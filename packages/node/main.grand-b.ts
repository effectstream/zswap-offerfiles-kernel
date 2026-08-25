// TEST-ONLY ENTRYPOINT — used exclusively by the grand e2e determinism phase
// (packages/tests/grand-e2e/phases/p7-determinism.ts). Never launched by the
// orchestrator or any deployment.
//
// A verbatim replica of main.dev.ts + config.dev.ts with exactly one
// difference: the NTP network's startTime comes from GRAND_NTP_START_TIME
// instead of being derived from this instance's own (empty) database. That
// pins instance B's NTP block heights to instance A's, which is what makes
// "sync B to A's blockL2 height, then diff the databases" a well-defined
// comparison. DB target, API port and the embedded MQTT broker's four ports are
// all steered by env vars the phase sets (DB_PORT, EFFECTSTREAM_API_PORT,
// MQTT_*_PORT) — the MQTT ports matter because they default to fixed values
// that instance A already holds.

import "@midnightntwrk/onchain-runtime-v4";

import { ZswapChainState } from "@midnightntwrk/ledger-v9";

// Same ZSwap tryApply guard as main.dev.ts — required for identical STF
// behavior between the two instances.
const origTryApply = ZswapChainState.prototype.tryApply;
ZswapChainState.prototype.tryApply = function (...args) {
  try {
    return origTryApply.apply(this as any, args as any);
  } catch {
    return [this, new Map()];
  }
};

import { init, start } from "@effectstream/runtime";
import { main, suspend } from "effection";
import {
  ConfigBuilder,
  ConfigNetworkType,
  ConfigSyncProtocolType,
  toSyncProtocolWithNetwork,
  withEffectstreamStaticConfig,
} from "@effectstream/config";
import {
  PrimitiveTypeCelestiaGeneric,
  PrimitiveTypeMidnightGeneric,
  PrimitiveTypeMidnightNullifierAndCommitment,
  PrimitiveTypeMidnightUnshieldedSpend,
  PrimitiveTypeMidnightUnshieldedCreate,
  PrimitiveTypeMidnightZswapRoot,
} from "@effectstream/sm/builtin";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { OfferFilesContract } from "@zswap-da/contract-offer-files";

import { migrationTable } from "@zswap-da/database";
import { apiRouter } from "./api.ts";
import { gameStateTransitions } from "./state-machine.ts";
import { grammar } from "./grammar.ts";
import {
  CELESTIA_FETCH_CONCURRENCY,
  CELESTIA_NAMESPACE,
  CELESTIA_PRIMITIVE_NAME,
  CELESTIA_POLLING_INTERVAL_MS,
  CELESTIA_RPC_URL,
  CELESTIA_STEP_SIZE,
  midnightContract,
} from "./env.ts";

const startTimeRaw = process.env["GRAND_NTP_START_TIME"];
if (!startTimeRaw || !Number.isFinite(Number(startTimeRaw))) {
  throw new Error("main.grand-b.ts requires GRAND_NTP_START_TIME (ms epoch of instance A's NTP anchor)");
}
const launchStartTime = Number(startTimeRaw);

const config = new ConfigBuilder()
  .setNamespace((builder) => builder.setSecurityNamespace("zswap-da-node"))
  .buildNetworks((builder) =>
    builder
      .addNetwork({
        name: "ntp",
        type: ConfigNetworkType.NTP,
        startTime: launchStartTime,
        blockTimeMS: 1000,
      })
      .addNetwork({
        name: "midnight",
        type: ConfigNetworkType.MIDNIGHT,
        networkId: midnightNetworkConfig.id,
        nodeUrl: midnightNetworkConfig.node,
      })
      .addNetwork({
        name: "celestia",
        type: ConfigNetworkType.CELESTIA,
        rpcUrl: CELESTIA_RPC_URL,
      })
  )
  .buildDeployments((builder) => builder)
  .buildSyncProtocols((builder) =>
    builder
      .addMain(
        (networks) => networks.ntp,
        () => ({
          name: "mainNtp",
          type: ConfigSyncProtocolType.NTP_MAIN,
          chainUri: "",
          startBlockHeight: 1,
          pollingInterval: 1000,
        }),
      )
      .addParallel(
        (networks) => (networks as any).midnight,
        () => ({
          name: "parallelMidnight",
          type: ConfigSyncProtocolType.MIDNIGHT_PARALLEL,
          startBlockHeight: 1,
          pollingInterval: 1000,
          delayMs: 18000,
          indexer: midnightNetworkConfig.indexer,
          indexerWs: midnightNetworkConfig.indexerWS,
        }),
      )
      .addParallel(
        (networks) => (networks as any).celestia,
        () => ({
          name: "parallelCelestia",
          type: ConfigSyncProtocolType.CELESTIA_PARALLEL,
          startBlockHeight: 1,
          pollingInterval: CELESTIA_POLLING_INTERVAL_MS,
          delayMs: 12_000,
          confirmationDepth: 1,
          stepSize: CELESTIA_STEP_SIZE,
          concurrency: CELESTIA_FETCH_CONCURRENCY,
        }),
      )
  )
  .buildPrimitives((builder) => {
    return builder
      .addPrimitive(
        (syncProtocols) => (syncProtocols as any).parallelCelestia,
        () => ({
          name: CELESTIA_PRIMITIVE_NAME,
          type: PrimitiveTypeCelestiaGeneric,
          startBlockHeight: 1,
          namespace: CELESTIA_NAMESPACE,
          stateMachinePrefix: "celestia-zswap",
        }),
      )
      .addPrimitive(
        (syncProtocols) => (syncProtocols as any).parallelMidnight,
        () => ({
          name: "ZswapMidnightState",
          type: PrimitiveTypeMidnightGeneric,
          startBlockHeight: 1,
          contractAddress: midnightContract!.contractAddress,
          stateMachinePrefix: "midnight-zswap",
          contract: { ledger: OfferFilesContract.ledger },
          networkId: midnightNetworkConfig.id,
        }),
      )
      .addPrimitive(
        (syncProtocols) => (syncProtocols as any).parallelMidnight,
        () => ({
          name: "Midnight-ZswapEvents",
          type: PrimitiveTypeMidnightNullifierAndCommitment,
          startBlockHeight: 1,
          stateMachinePrefix: "midnight-zswap-event",
          capture: "both",
          networkId: midnightNetworkConfig.id,
        }),
      )
      .addPrimitive(
        (syncProtocols) => (syncProtocols as any).parallelMidnight,
        () => ({
          name: "Midnight-UnshieldedSpend",
          type: PrimitiveTypeMidnightUnshieldedSpend,
          startBlockHeight: 1,
          stateMachinePrefix: "midnight-unshielded-spend",
          networkId: midnightNetworkConfig.id,
        }),
      )
      .addPrimitive(
        (syncProtocols) => (syncProtocols as any).parallelMidnight,
        () => ({
          name: "Midnight-UnshieldedCreate",
          type: PrimitiveTypeMidnightUnshieldedCreate,
          startBlockHeight: 1,
          stateMachinePrefix: "midnight-unshielded-create",
          networkId: midnightNetworkConfig.id,
        }),
      )
      .addPrimitive(
        (syncProtocols) => (syncProtocols as any).parallelMidnight,
        () => ({
          name: "Midnight-ZswapRoot",
          type: PrimitiveTypeMidnightZswapRoot,
          startBlockHeight: 1,
          stateMachinePrefix: "midnight-zswap-root",
          networkId: midnightNetworkConfig.id,
        }),
      );
  })
  .build();

main(function* () {
  yield* init();
  console.log("Starting ZSwap DA Node (grand-e2e instance B)");

  yield* withEffectstreamStaticConfig(config, function* () {
    yield* start({
      appName: "zswap-da",
      appVersion: "1.0.0",
      syncInfo: toSyncProtocolWithNetwork(config),
      gameStateTransitions,
      migrations: migrationTable,
      apiRouter,
      grammar,
    });
  });

  yield* suspend();
});
