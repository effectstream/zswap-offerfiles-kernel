/**
 * Public-network batcher: Midnight balancer + Celestia DA on preview, preprod
 * or mainnet, selected by MIDNIGHT_NETWORK_ID.
 *
 * The dev batcher's wiring with the public-network profile in front of it
 * (public-network.ts): a dedicated funded BATCHER_WALLET_SEED (a missing or
 * public dev seed is refused — no silent fallback), BATCHER_STORAGE_DIR on a
 * volume (it also holds the DUST-state cache), the network's Celestia chain
 * (mocha for preview and preprod, mainnet for mainnet) with an explicit RPC
 * URL and auth, and MIDNIGHT_BLOCKFROST_PROJECT_ID (or full endpoint
 * overrides, never a retired *.midnight.network host), and the network's
 * pinned reference ledger parameters (a supported network that is not pinned
 * yet is refused with the reason). Every refusal is listed at once and exits
 * 78 (EX_CONFIG), before any network call.
 *
 * `--check` validates, prints the resolved profile (endpoints redacted) and
 * exits 0 without touching the network — the image entrypoint's
 * configuration preflight.
 *
 * Funding: NIGHT on the batcher's unshielded address registered for DUST, and
 * TIA on the Celestia signer behind CELESTIA_RPC_URL / CELESTIA_AUTH_TOKEN.
 */

// FIRST: the raw-environment check. It exits 78 listing every problem before
// config.ts loads midnight-env, which would otherwise throw on the first one.
import "./public-network-env.ts";

import { main, suspend } from "effection";
import {
  createNewBatcher,
  FileStorage,
  type BatcherConfig as SdkBatcherConfig,
  type DefaultBatcherInput,
} from "@effectstream/batcher-sdk";
import { redactBlockfrostProjectId } from "@effectstream/midnight-contracts/midnight-env";
import { installLogRedaction, probeMidnightIndexerAuth } from "@zswap-da/offer-guard/public-networks";

import { loadBatcherConfig } from "./config.ts";
import { createMidnightBalancingAdapter } from "./midnight-balancing.ts";
import { createCelestiaAdapter } from "./celestia.ts";
import { applyPublicBatcherProfile, describePublicBatcher, EX_CONFIG } from "./public-network.ts";

const BALANCER_TARGET = "midnight-balancer";
const CELESTIA_TARGET = "celestia";

// Every line this process prints from here on — its own and its
// dependencies' (the wallet SDK logs the node URL it loses) — goes through
// redactBlockfrostProjectId: the Blockfrost endpoint URLs carry the token.
installLogRedaction(redactBlockfrostProjectId);

const profile = applyPublicBatcherProfile(process.env, loadBatcherConfig());
const label = `[zswap-da-batcher] [${profile.config.midnight.id}]`;
for (const line of describePublicBatcher(profile, redactBlockfrostProjectId)) console.log(`${label} ${line}`);
for (const warning of profile.warnings) console.warn(`${label} WARNING: ${warning}`);
if (process.argv.includes("--check")) {
  console.log(`${label} batcher configuration OK`);
  process.exit(0);
}

// A rejected Blockfrost token is permanent: stop naming the variable rather
// than let the wallet sync retry it forever. An unreachable indexer is not
// fatal.
{
  const auth = await probeMidnightIndexerAuth(
    profile.config.midnight.id,
    profile.config.midnight.indexer,
    redactBlockfrostProjectId,
  );
  if (!auth.ok && auth.fatal) {
    console.error(`${label} ${auth.message}`);
    process.exit(EX_CONFIG);
  }
  if (!auth.ok) console.warn(`${label} WARNING: ${auth.message}`);
}

const batcherConfig = profile.config;
const midnightAdapter = createMidnightBalancingAdapter(batcherConfig, {
  dustStateDir: profile.dustStateDir,
});
const celestiaAdapter = createCelestiaAdapter(batcherConfig);

const sdkConfig: SdkBatcherConfig<DefaultBatcherInput> = {
  pollingIntervalMs: batcherConfig.pollingIntervalMs,
  enableHttpServer: true,
  namespace: "",
  confirmationLevel: "wait-receipt",
  enableEventSystem: false,
  port: batcherConfig.port,
  // #847: only genuine input failures charge retries; infra failures park
  // inputs and cool the target down for retryDelayMs.
  ...(batcherConfig.maxRetries !== undefined && { maxRetries: batcherConfig.maxRetries }),
  ...(batcherConfig.retryDelayMs !== undefined && { retryDelayMs: batcherConfig.retryDelayMs }),
};

const storage = new FileStorage(batcherConfig.storageDir);
const batcher = createNewBatcher(sdkConfig, storage);

batcher.addBlockchainAdapter(BALANCER_TARGET, midnightAdapter, {
  criteriaType: "size",
  maxBatchSize: 1,
});

batcher.addBlockchainAdapter(CELESTIA_TARGET, celestiaAdapter, {
  criteriaType: "size",
  maxBatchSize: 1,
});

main(function* () {
  console.log(
    `${label} starting on :${batcherConfig.port} (targets=${BALANCER_TARGET}, ${CELESTIA_TARGET})`,
  );
  try {
    yield* batcher.runBatcher();
  } catch (error) {
    console.error("[zswap-da-batcher] error:", error);
    yield* batcher.gracefulShutdownOp();
  }
  // runBatcher() RETURNS as soon as the HTTP server and the polling loop are
  // spawned; this suspend is what keeps their scope alive. So the reference-
  // price poll must be stopped when THIS unwinds, not when runBatcher returns.
  try {
    yield* suspend();
  } finally {
    celestiaAdapter.stop();
  }
});
