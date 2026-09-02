import path from "node:path";
import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";
import { fileURLToPath } from "node:url";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { ENV } from "@effectstream/utils/node-env";

/**
 * What the batcher does when an offer is not worth its Celestia fee.
 *
 *   enforce — refuse it. The offer never reaches the queue and no fee is paid.
 *   warn    — sponsor it, but say so in the log. The rollout default (D7): a
 *             day of `warn` on a live deployment shows what `enforce` WOULD
 *             have refused before it refuses anything real.
 *   off     — do not evaluate at all. No node poll, no log noise.
 */
export type SponsorPolicy = "enforce" | "warn" | "off";

/**
 * What to do with an offer whose tokens have no market price at all — every
 * test token, and anything minted by the faucet.
 *
 *   allow  — sponsor it (the default, D7: test tokens must keep flowing, and a
 *            price feed that fails must not silently close the test site).
 *   reject — refuse it. Only sensible on a deployment where every tradeable
 *            token is mapped to a reference asset.
 */
export type UnpricedPolicy = "allow" | "reject";

export interface SponsorshipConfig {
  /** Node API base URL — the batcher polls `${nodeApiUrl}/v1/prices`. */
  nodeApiUrl: string;
  priceRefreshMs: number;
  /** Past this age a snapshot stops counting as an answer at all. */
  priceMaxAgeMs: number;
  policy: SponsorPolicy;
  unpriced: UnpricedPolicy;
  /** Bootstrap threshold, used ONLY until the node has answered once. */
  fallbackDiscountBps: number;
}

export interface BatcherConfig {
  port: number;
  pollingIntervalMs: number;
  storageDir: string;
  walletSeed: string | string[];
  // Max concurrent balancing txs PER wallet. The SDK computes actual slots as
  // min(floor(dustUtxoCount / costPerTx), maxSlotsPerWallet), so this is only
  // a ceiling — real concurrency is still bounded by how many dust UTXOs the
  // wallet holds (one NIGHT UTXO registered for dust ≈ one slot). The dev
  // stack defaults to 5 and bootstraps five fee-capable streams; deployed
  // networks preserve the SDK's conservative default of 1. Watch the
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
  sponsorship: SponsorshipConfig;
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
const BATCHER_SEED =
  "0000000000000000000000000000000000000000000000000000000000000003";

export const defaultMaxSlotsPerWallet = (networkId: string): number =>
  networkId === "undeployed" ? 5 : 1;

const optionalNumber = (key: string): number | undefined => {
  const raw = ENV.getString(key, "");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const SPONSOR_POLICIES: readonly SponsorPolicy[] = ["enforce", "warn", "off"];
const UNPRICED_POLICIES: readonly UnpricedPolicy[] = ["allow", "reject"];

/**
 * Every sponsorship knob is validated HERE, at startup, and a bad value throws
 * before the batcher accepts its first input.
 *
 * A typo in `BATCHER_SPONSOR_POLICY` must not silently fall back to a default:
 * an operator who typed `enfroce` intends to refuse unsponsored offers, and
 * quietly sponsoring everything instead is the one outcome they were trying to
 * prevent — with no signal anywhere that it happened.
 */
export function loadSponsorshipConfig(): SponsorshipConfig {
  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = ENV.getString(key, "").trim().toLowerCase();
    if (raw === "") return fallback;
    if (!(allowed as readonly string[]).includes(raw)) {
      throw new Error(`${key} must be one of ${allowed.join(" | ")}, got "${raw}"`);
    }
    return raw as T;
  };

  const positiveMs = (key: string, fallback: number): number => {
    const value = ENV.getNumber(key, fallback);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} must be a positive number of milliseconds, got "${ENV.getString(key, "")}"`);
    }
    return value;
  };

  const nodeApiUrl = ENV.getString("BATCHER_NODE_API_URL", "http://127.0.0.1:9999").trim();
  // Checked early: the failure would otherwise be one `fetch` rejection every
  // refresh, forever. The protocol check is not pedantry — `new URL` happily
  // accepts "kernel:9999" (scheme "kernel:"), which is exactly the typo a
  // compose file invites, and `fetch` would then reject on every poll.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(nodeApiUrl);
  } catch {
    throw new Error(`BATCHER_NODE_API_URL must be an absolute http(s) URL, got "${nodeApiUrl}"`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`BATCHER_NODE_API_URL must be an absolute http(s) URL, got "${nodeApiUrl}"`);
  }

  const fallbackDiscountBps = ENV.getNumber("SPONSOR_DISCOUNT_BPS", 250);
  if (!Number.isInteger(fallbackDiscountBps) || fallbackDiscountBps < 0 || fallbackDiscountBps >= 10_000) {
    throw new Error(
      `SPONSOR_DISCOUNT_BPS must be an integer in [0, 10000), got "${ENV.getString("SPONSOR_DISCOUNT_BPS", "")}"`,
    );
  }

  return {
    nodeApiUrl,
    priceRefreshMs: positiveMs("BATCHER_PRICE_REFRESH_MS", 600_000), // 10 min
    priceMaxAgeMs: positiveMs("BATCHER_PRICE_MAX_AGE_MS", 172_800_000), // 48 h
    policy: oneOf("BATCHER_SPONSOR_POLICY", SPONSOR_POLICIES, "warn"),
    unpriced: oneOf("BATCHER_SPONSOR_UNPRICED", UNPRICED_POLICIES, "allow"),
    fallbackDiscountBps,
  };
}

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
    maxSlotsPerWallet: ENV.getNumber(
      "BATCHER_MAX_SLOTS_PER_WALLET",
      defaultMaxSlotsPerWallet(midnightNetworkConfig.id),
    ),
    maxRetries: optionalNumber("BATCHER_MAX_RETRIES"),
    retryDelayMs: optionalNumber("BATCHER_RETRY_DELAY_MS"),
    dustWaitTimeoutMs: optionalNumber("BATCHER_DUST_WAIT_TIMEOUT_MS"),
    minSpendableDustPerCoin: (() => {
      const raw = ENV.getString("BATCHER_MIN_SPENDABLE_DUST_PER_COIN", "");
      return raw ? BigInt(raw) : undefined;
    })(),
    maxInputChars: optionalNumber("BATCHER_MAX_INPUT_CHARS"),
    sponsorship: loadSponsorshipConfig(),
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
