import path from "node:path";
import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";
import { fileURLToPath } from "node:url";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { ENV } from "@effectstream/utils/node-env";

export interface BatcherConfig {
  port: number;
  pollingIntervalMs: number;
  storageDir: string;
  walletSeed: string | string[];
  // Max concurrent balancing txs PER wallet. The SDK computes actual slots as
  // min(floor(dustUtxoCount / costPerTx), maxSlotsPerWallet), so this is only
  // a ceiling — real concurrency is still bounded by how many dust UTXOs the
  // wallet holds (one NIGHT UTXO registered for dust ≈ one slot). Default 1
  // preserves the SDK's serialized behavior; raise it AND split the wallet's
  // NIGHT into that many dust UTXOs to actually parallelize. Watch the
  // "worker slots: N (M UTXOs, cost=…, cap=…)" line on startup for what you
  // got. The proof server becomes the next ceiling.
  maxSlotsPerWallet: number;
  // 0.103.1 (effectstream#847) hardening knobs. All optional: undefined defers
  // to the SDK's defaults. maxRetries/retryDelayMs go to the core batcher
  // (per-input retry budget + infra-failure cooldown — both existed before
  // #847 but were never read); the rest go to the midnight balancing adapter.
  maxRetries: number | undefined;
  retryDelayMs: number | undefined;
  // Balancing adapter: how long to wait for a dust coin to become spendable,
  // the value below which a coin does not count as capacity (specks; #847's
  // value-aware gate), and the /send-input size cap.
  dustWaitTimeoutMs: number | undefined;
  minSpendableDustPerCoin: bigint | undefined;
  maxInputChars: number | undefined;
  midnight: {
    id: string;
    indexer: string;
    indexerWS: string;
    node: string;
    proofServer: string;
  };
  celestia: {
    rpcUrl: string;
    namespace: string;
    authToken: string | undefined;
    network: "devnet" | "mainnet" | "mocha";
    fee: number;
    gasLimit: number;
    gasPrice: number | undefined;
    gas: number | undefined;
    maxGasPrice: number | undefined;
    txPriority: number | undefined;
  };
}

const DEFAULT_STORAGE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "batcher-data",
);

// Dedicated seed for the zswap-da batcher wallet. Distinct from any wallet
// the rest of the stack uses — running two wallets on the same seed against
// a single Midnight node forces one to disconnect.
const BATCHER_SEED = [
  "0000000000000000000000000000000000000000000000000000000000000003",
  "0000000000000000000000000000000000000000000000000000000000000004",
];

const optionalNumber = (key: string): number | undefined => {
  const raw = ENV.getString(key, "");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function loadBatcherConfig(): BatcherConfig {
  const network = ENV.getString("CELESTIA_NETWORK", "devnet") as
    | "devnet"
    | "mainnet"
    | "mocha";

  return {
    port: ENV.getNumber("BATCHER_PORT", 3334),
    pollingIntervalMs: ENV.getNumber("BATCHER_POLLING_INTERVAL_MS", 250),
    storageDir: ENV.getString("BATCHER_STORAGE_DIR", DEFAULT_STORAGE_DIR),
    walletSeed: ENV.getString("BATCHER_WALLET_SEED") || BATCHER_SEED,
    maxSlotsPerWallet: ENV.getNumber("BATCHER_MAX_SLOTS_PER_WALLET", 1),
    maxRetries: optionalNumber("BATCHER_MAX_RETRIES"),
    retryDelayMs: optionalNumber("BATCHER_RETRY_DELAY_MS"),
    dustWaitTimeoutMs: optionalNumber("BATCHER_DUST_WAIT_TIMEOUT_MS"),
    minSpendableDustPerCoin: (() => {
      const raw = ENV.getString("BATCHER_MIN_SPENDABLE_DUST_PER_COIN", "");
      return raw ? BigInt(raw) : undefined;
    })(),
    maxInputChars: optionalNumber("BATCHER_MAX_INPUT_CHARS"),
    midnight: {
      id: midnightNetworkConfig.id,
      indexer: midnightNetworkConfig.indexer,
      indexerWS: midnightNetworkConfig.indexerWS,
      node: midnightNetworkConfig.node,
      proofServer: midnightNetworkConfig.proofServer,
    },
    celestia: {
      rpcUrl: ENV.getString("CELESTIA_RPC_URL", "http://127.0.0.1:26658"),
      namespace: ENV.getString("CELESTIA_NAMESPACE", MIP6_NAMESPACE_ID_SUFFIX_HEX),
      authToken: ENV.getString("CELESTIA_AUTH_TOKEN", "") || undefined,
      network,
      fee: ENV.getNumber("CELESTIA_FEE", 2000),
      gasLimit: ENV.getNumber("CELESTIA_GAS_LIMIT", 100000),
      gasPrice: optionalNumber("CELESTIA_GAS_PRICE"),
      gas: optionalNumber("CELESTIA_GAS"),
      maxGasPrice: optionalNumber("CELESTIA_MAX_GAS_PRICE"),
      txPriority: optionalNumber("CELESTIA_TX_PRIORITY"),
    },
  };
}
