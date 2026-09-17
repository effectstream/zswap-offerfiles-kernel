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

const BALANCER_TARGET = "midnight-balancer";
const CELESTIA_TARGET = "celestia";

const batcherConfig = loadBatcherConfig();

if (batcherConfig.celestia.network !== "mainnet") {
  throw new Error(
    `batcher.mainnet.ts requires CELESTIA_NETWORK=mainnet, got '${batcherConfig.celestia.network}'`,
  );
}
if (!batcherConfig.celestia.authToken) {
  throw new Error("CELESTIA_AUTH_TOKEN is required for mainnet batcher");
}

const midnightAdapter = createMidnightBalancingAdapter(batcherConfig);
const celestiaAdapter = createCelestiaAdapter(batcherConfig);

const sdkConfig: SdkBatcherConfig<DefaultBatcherInput> = {
  pollingIntervalMs: batcherConfig.pollingIntervalMs,
  enableHttpServer: true,
  namespace: "",
  confirmationLevel: "wait-receipt",
  enableEventSystem: false,
  port: batcherConfig.port,
  // #847: these were accepted-but-ignored before 0.103.1 (retry limit was
  // hardcoded to 3). Only genuine input failures charge retries now; infra
  // failures park inputs and cool the target down for retryDelayMs.
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
    `[zswap-da-batcher] mainnet, starting on :${batcherConfig.port} (targets=${BALANCER_TARGET}, ${CELESTIA_TARGET})`,
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
