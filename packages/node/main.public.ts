// Public-network sync node + API: preview, preprod or mainnet, selected by
// MIDNIGHT_NETWORK_ID.
//
// One node for the three networks: config.preview.ts (every value from env),
// with the network's values put into the environment first by the
// public-network profile (public-network-profile.ts): NTP anchor at the
// network's block 1, the 10-minute NTP block time, Celestia mocha (preview,
// preprod) or Celestia mainnet (mainnet) on the MIP-0006 shared namespace, and
// a refusal (exit 78) naming CELESTIA_START_HEIGHT, CELESTIA_RPC_URL, the
// Celestia auth, MIDNIGHT_BLOCKFROST_PROJECT_ID or a retired endpoint host.
// Endpoints come from `@effectstream/midnight-contracts`' Blockfrost defaults,
// explicit MIDNIGHT_* env winning; every logged endpoint is redacted.

// Side-effect import FIRST: registers the Midnight onchain-runtime wasm bundle
// before any dependency loads it (see the note in main.dev.ts).
import "@midnightntwrk/onchain-runtime-v4";

// The profile SECOND, before anything that reads the environment at load time
// (env.ts, config.preview.ts, midnight-env): it validates the network contract
// and writes the network's defaults into process.env. Moving it below those
// imports would silently start the node on env.ts's defaults, or let
// midnight-env throw before every problem is listed.
import "./public-network-env.ts";

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
import { call, main, suspend } from "effection";
import {
  toSyncProtocolWithNetwork,
  withEffectstreamStaticConfig,
} from "@effectstream/config";
import {
  midnightNetworkConfig,
  redactBlockfrostProjectId,
} from "@effectstream/midnight-contracts/midnight-env";

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
import { REFERENCE_PARAMETERS } from "@zswap-da/validator";
import { apiRouter } from "./api.ts";
import { gameStateTransitions } from "./state-machine.ts";
import { grammar } from "./grammar.ts";
import { installLogRedaction, probeMidnightIndexerAuth } from "@zswap-da/offer-guard/public-networks";
import { describeMidnightEndpoints, EX_CONFIG } from "./public-network-profile.ts";

// Every line this process prints from here on — its own and its
// dependencies' — goes through redactBlockfrostProjectId: the Blockfrost
// endpoint URLs carry the project token.
installLogRedaction(redactBlockfrostProjectId);

const label = `[${midnightNetworkConfig.id}]`;

main(function* () {
  yield* init();
  console.log(`Starting ZSwap DA Node (${midnightNetworkConfig.id})`);
  // What env.ts actually resolved AFTER the profile ran — the offline boot
  // gate reads these lines, so they must come from env.ts and midnight-env,
  // not from the profile's own view.
  console.log(
    `${label} resolved: network=${midnightNetworkConfig.id} ntpStartTime=${NTP_START_TIME} ` +
      `blockTimeMs=${BLOCK_TIME_MS} celestiaNetwork=${CELESTIA_NETWORK} namespace=${CELESTIA_NAMESPACE} ` +
      `rootWindowSeconds=${ROOT_WINDOW_SECONDS} offerTtlFallbackSeconds=${OFFER_TTL_SECONDS} ` +
      `referenceParameters=${REFERENCE_PARAMETERS[midnightNetworkConfig.id]?.sha256.slice(0, 16) ?? "none"}`,
  );
  for (const line of describeMidnightEndpoints(midnightNetworkConfig, redactBlockfrostProjectId)) {
    console.log(`${label} ${line}`);
  }

  // A rejected Blockfrost token is permanent: stop naming the variable rather
  // than let the sync retry it forever. An unreachable indexer is not fatal.
  const auth = yield* call(() =>
    probeMidnightIndexerAuth(midnightNetworkConfig.id, midnightNetworkConfig.indexer, redactBlockfrostProjectId),
  );
  if (!auth.ok && auth.fatal) {
    console.error(`${label} ${auth.message}`);
    process.exit(EX_CONFIG);
  }
  if (!auth.ok) console.warn(`${label} WARNING: ${auth.message}`);

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
