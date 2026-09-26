/**
 * Stagenet batcher: Midnight balancer + Celestia DA (00050, FR-002).
 *
 * The preview batcher's wiring with the stagenet profile in front of it
 * (stagenet.ts): MIDNIGHT_NETWORK_ID=stagenet, a dedicated funded
 * BATCHER_WALLET_SEED (a missing or public dev seed is refused — no silent
 * fallback), BATCHER_STORAGE_DIR on a volume (it also holds the DUST-state
 * cache), Celestia mocha with an explicit RPC URL and auth. Every refusal is
 * listed at once and exits 78 (EX_CONFIG), before any network call.
 *
 * `--check` validates, prints the resolved profile and exits 0 without
 * touching the network — the image entrypoint's configuration preflight.
 *
 * Funding (see README "Running against stagenet"): NIGHT on the batcher's
 * unshielded address registered for DUST, and mocha TIA on the Celestia
 * signer behind CELESTIA_RPC_URL / CELESTIA_AUTH_TOKEN.
 */
import { main, suspend } from "effection";
import {
  createNewBatcher,
  FileStorage,
  type BatcherConfig as SdkBatcherConfig,
  type DefaultBatcherInput,
} from "@effectstream/batcher-sdk";

import { loadBatcherConfig } from "./config.ts";
import { createMidnightBalancingAdapter } from "./midnight-balancing.ts";
import { createCelestiaAdapter } from "./celestia.ts";
import { describeStagenetBatcher, resolveStagenetBatcher } from "./stagenet.ts";

const BALANCER_TARGET = "midnight-balancer";
const CELESTIA_TARGET = "celestia";

const profile = resolveStagenetBatcher(process.env, loadBatcherConfig());
if (profile.problems.length > 0) {
  console.error(
    `[zswap-da-batcher] stagenet configuration is invalid (${profile.problems.length} problem` +
      `${profile.problems.length === 1 ? "" : "s"}):\n` +
      profile.problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(78);
}
for (const line of describeStagenetBatcher(profile)) console.log(`[zswap-da-batcher] [stagenet] ${line}`);
for (const warning of profile.warnings) console.warn(`[zswap-da-batcher] [stagenet] WARNING: ${warning}`);
if (process.argv.includes("--check")) {
  console.log("[zswap-da-batcher] [stagenet] batcher configuration OK");
  process.exit(0);
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
    `[zswap-da-batcher] stagenet, starting on :${batcherConfig.port} (targets=${BALANCER_TARGET}, ${CELESTIA_TARGET})`,
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
