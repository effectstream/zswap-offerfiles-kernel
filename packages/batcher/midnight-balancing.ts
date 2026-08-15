import { MidnightBalancingAdapter } from "@effectstream/batcher-sdk";
import { waitForDustFundsWithRetry } from "@effectstream/midnight-contracts";
import type { BatcherConfig } from "./config.ts";
import {
  BATCHER_NIGHT_UTXO_TARGET,
  ensureBatcherNightUtxos,
} from "./night-utxo-bootstrap.ts";

export function createMidnightBalancingAdapter(
  batcherConfig: BatcherConfig,
): MidnightBalancingAdapter {
  // Why this approach instead of passing a `walletResult` built by buildWalletFacade:
  //
  // Midnight Preview has ~83k historical dust commitment entries. The wallet must
  // scan them all to find recently-registered dust UTXOs. The default path uses
  // stallTimeoutMs=60s and maxRetries=5, covering only ~6k entries before giving up.
  //
  // waitForDustFundsWithRetry with stallTimeoutMs=7_200_000 (2h) lets the entire
  // 81-minute scan finish in a single attempt without a false stall. It also saves
  // state to dust-state/ on disk, so a restart resumes from where it left off
  // (via the batcher_dust Docker volume).
  const firstSeed = Array.isArray(batcherConfig.walletSeed)
    ? batcherConfig.walletSeed[0]!
    : batcherConfig.walletSeed;

  const networkUrls = {
    id: batcherConfig.midnight.id,
    indexer: batcherConfig.midnight.indexer,
    indexerWS: batcherConfig.midnight.indexerWS,
    node: batcherConfig.midnight.node,
    proofServer: batcherConfig.midnight.proofServer,
  };

  const devBootstrap = batcherConfig.midnight.id === "undeployed";
  const walletResultPromise = waitForDustFundsWithRetry(
    {
      networkUrls: networkUrls as any,
      seed: firstSeed,
      networkId: batcherConfig.midnight.id as any,
      // The dev bootstrap needs the unshielded wallet long enough to inspect
      // and, when necessary, self-split NIGHT. The adapter suspends the two
      // auxiliary wallet syncs after this promise resolves. Deployed networks
      // keep the cheaper dust-only path.
      syncMode: devBootstrap ? "all" : "dust-only",
      stallTimeoutMs: 7_200_000,  // 2h per attempt — enough for the full 81-min scan
      maxRetries: 3,
    },
  ).then(async ({ walletResult }) => {
    if (devBootstrap) {
      const ready = await ensureBatcherNightUtxos(walletResult, {
        target: BATCHER_NIGHT_UTXO_TARGET,
        minSpendableDustPerCoin: batcherConfig.minSpendableDustPerCoin,
      });
      console.log(
        `[zswap-da-batcher] NIGHT bootstrap: ${ready.registeredNightUtxos} registered UTXOs, ` +
          `${ready.spendableDustUtxos} spendable dust streams${ready.split ? " (self-split)" : ""}`,
      );
    }
    return walletResult;
  });

  return new MidnightBalancingAdapter([firstSeed], {
    indexer: batcherConfig.midnight.indexer,
    indexerWS: batcherConfig.midnight.indexerWS,
    node: batcherConfig.midnight.node,
    proofServer: batcherConfig.midnight.proofServer,
    walletNetworkId: batcherConfig.midnight.id,
    syncProtocolName: "parallelMidnight",
    walletResult: walletResultPromise as any,
    walletFundingTimeoutSeconds: 7200,
    // Concurrency ceiling. Real slots = min(floor(dustUtxos/costPerTx), this);
    // one wallet with one big NIGHT UTXO still gets one slot, so raising this
    // only helps once the wallet's NIGHT is split into multiple dust UTXOs.
    maxSlotsPerWallet: batcherConfig.maxSlotsPerWallet,
    // #847 hardening: value-aware dust gate, wait budget, intake size cap.
    // undefined defers to SDK defaults (1.5x wallet overhead / 60s / 500k).
    dustWaitTimeoutMs: batcherConfig.dustWaitTimeoutMs,
    minSpendableDustPerCoin: batcherConfig.minSpendableDustPerCoin,
    maxInputChars: batcherConfig.maxInputChars,
  });
}
