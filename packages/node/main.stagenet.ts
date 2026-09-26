// Stagenet sync node + API (00050, FR-001).
//
// The same node as main.preview.ts — it reuses config.preview.ts unchanged —
// with stagenet's values put into the environment first by the stagenet
// profile (stagenet-profile.ts): NTP anchor at stagenet block 1, preview's NTP
// block time, Celestia mocha on the MIP-0006 shared namespace, and a refusal
// (exit 78) naming CELESTIA_START_HEIGHT, CELESTIA_RPC_URL or the Celestia auth
// when missing. Endpoints come from `@effectstream/midnight-contracts`'
// stagenet profile (shielded.tools), explicit MIDNIGHT_* env winning.

// Side-effect import FIRST: registers the Midnight onchain-runtime wasm bundle
// before any dependency loads it (see the note in main.dev.ts).
import "@midnightntwrk/onchain-runtime-v4";

// The stagenet profile SECOND, before anything that reads the environment at
// load time (env.ts, config.preview.ts): it validates the stagenet contract and
// writes the stagenet defaults into process.env. Moving it below those imports
// would silently start the node on preview's anchor.
import "./stagenet-node-env.ts";

import { ZswapChainState } from "@midnightntwrk/ledger-v9";

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
  toSyncProtocolWithNetwork,
  withEffectstreamStaticConfig,
} from "@effectstream/config";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";

import { config } from "./config.preview.ts";
import {
  BLOCK_TIME_MS,
  CELESTIA_NAMESPACE,
  CELESTIA_NETWORK,
  NTP_START_TIME,
  OFFER_TTL_SECONDS,
  ROOT_WINDOW_SECONDS,
} from "./env.ts";
import { migrationTable } from "@zswap-da/database";
import { apiRouter } from "./api.ts";
import { gameStateTransitions } from "./state-machine.ts";
import { grammar } from "./grammar.ts";

main(function* () {
  yield* init();
  console.log("Starting ZSwap DA Node (Stagenet)");
  // What env.ts actually resolved AFTER the profile ran — the offline boot
  // check (00050 T1) reads these lines, so they must come from env.ts and
  // midnight-env, not from the profile's own view.
  console.log(
    `[stagenet] resolved: network=${midnightNetworkConfig.id} ntpStartTime=${NTP_START_TIME} ` +
      `blockTimeMs=${BLOCK_TIME_MS} celestiaNetwork=${CELESTIA_NETWORK} namespace=${CELESTIA_NAMESPACE} ` +
      `rootWindowSeconds=${ROOT_WINDOW_SECONDS} offerTtlSeconds=${OFFER_TTL_SECONDS}`,
  );
  console.log(
    `[stagenet] endpoints: node=${midnightNetworkConfig.node} indexer=${midnightNetworkConfig.indexer} ` +
      `indexerWs=${midnightNetworkConfig.indexerWS} proofServer=${midnightNetworkConfig.proofServer}`,
  );

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
