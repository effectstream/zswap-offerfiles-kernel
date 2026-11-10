// The public-network batcher profile: preview, preprod and mainnet. Pure and
// unit-testable. The entry (batcher.public.ts) runs it in two steps:
//
//   1. `resolvePublicBatcherProblems(env)` on the RAW environment, from the
//      side-effect module public-network-env.ts, before `config.ts` (and with
//      it midnight-env, which throws at import without a Blockfrost token) is
//      loaded — so every refusal is listed at once, each naming its variable;
//   2. `applyPublicBatcherProfile(env, base)` on the config `loadBatcherConfig()`
//      built, which corrects the values the loader defaults for the local
//      devnet.
//
// Why a separate check on top of loadBatcherConfig(): that loader is shared
// with the devnet batcher and keeps its devnet conveniences, which are hazards
// on a network with real users:
//
//   * CELESTIA_RPC_URL defaults to a loopback light node;
//   * CELESTIA_NETWORK defaults to `devnet`;
//   * the DUST cache lands in a cwd-relative `dust-state/` folder
//     (@effectstream/midnight-contracts DEFAULT_DUST_STATE_DIR), not on the
//     volume that BATCHER_STORAGE_DIR names.
//
// The wallet seed is guarded twice: here (listed with every other problem)
// and in loadBatcherConfig() itself, which never falls back to the public seed
// …03 off `undeployed`.

import path from "node:path";

import {
  CELESTIA_NETWORK_FOR,
  isPublicMidnightNetwork,
  midnightEndpointProblems,
  PUBLIC_MIDNIGHT_NETWORKS,
  publicDevSeedProblem,
  referenceParametersProblem,
  unsupportedNetworkProblem,
  type PublicMidnightNetwork,
} from "@zswap-da/offer-guard/public-networks";

import type { BatcherConfig } from "./config.ts";

/** The MIP-0006 shared namespace suffix (`mn-swap-v1`). */
const MIP6_NAMESPACE_SUFFIX_HEX = "6d6e2d737761702d7631";

/** Exit status for a configuration refusal (EX_CONFIG). */
export const EX_CONFIG = 78;

export type EnvMap = Record<string, string | undefined>;

export interface PublicBatcherProfile {
  /** `base` with the public-network corrections applied. */
  readonly config: BatcherConfig;
  /** `${BATCHER_STORAGE_DIR}/dust-state` — the DUST cache, on the volume. */
  readonly dustStateDir: string;
  readonly warnings: readonly string[];
  readonly celestiaAuth: "bearer-token" | "in-url" | "missing";
}

function read(env: EnvMap, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : trimmed;
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value);

const celestiaAuthOf = (env: EnvMap): "bearer-token" | "in-url" | "missing" =>
  read(env, "CELESTIA_AUTH_TOKEN") !== undefined
    ? "bearer-token"
    : truthy(read(env, "CELESTIA_AUTH_IN_URL"))
      ? "in-url"
      : "missing";

/** Pure: every refusal for the raw environment, each naming its variable. */
export function resolvePublicBatcherProblems(env: EnvMap): string[] {
  const problems: string[] = [];

  const networkId = read(env, "MIDNIGHT_NETWORK_ID") ?? "";
  const network: PublicMidnightNetwork | undefined = isPublicMidnightNetwork(networkId) ? networkId : undefined;
  if (network === undefined) {
    problems.push(
      networkId === "undeployed"
        ? `MIDNIGHT_NETWORK_ID="undeployed" is the local devnet: run packages/batcher/batcher.dev.ts, not ` +
            `the public-network batcher (${PUBLIC_MIDNIGHT_NETWORKS.join(", ")})`
        : unsupportedNetworkProblem(networkId),
    );
  }
  const where = networkId || "a public network";

  // ── the wallet: required, well-formed, never a public dev seed ──
  const rawSeed = read(env, "BATCHER_WALLET_SEED");
  if (rawSeed === undefined) {
    problems.push(
      `BATCHER_WALLET_SEED is required on ${where}: a dedicated, funded seed (64 or 128 hex chars) ` +
        "whose NIGHT is registered for DUST — there is no fallback to the public dev seed",
    );
  } else {
    const seed = rawSeed.replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]+$/.test(seed) || (seed.length !== 64 && seed.length !== 128)) {
      problems.push(
        `BATCHER_WALLET_SEED must be 64 or 128 hex characters (32 or 64 bytes); got ${seed.length} characters`,
      );
    } else {
      const devSeed = publicDevSeedProblem(networkId, "BATCHER_WALLET_SEED", seed);
      if (devSeed !== undefined) problems.push(devSeed);
    }
  }

  // ── storage: required, it carries parked inputs AND the DUST cache ──
  const storageRaw = read(env, "BATCHER_STORAGE_DIR");
  if (storageRaw === undefined) {
    problems.push(
      `BATCHER_STORAGE_DIR is required on ${where}: a persistent directory (a volume) for the batcher's ` +
        "parked inputs and its DUST-state cache",
    );
  } else if (!path.isAbsolute(storageRaw)) {
    problems.push(`BATCHER_STORAGE_DIR must be an absolute path, got "${storageRaw}"`);
  }

  // ── Celestia: the network's DA chain, explicit RPC, auth ──
  const celestiaNetworkRaw = read(env, "CELESTIA_NETWORK");
  if (network && celestiaNetworkRaw !== undefined && celestiaNetworkRaw !== CELESTIA_NETWORK_FOR[network]) {
    problems.push(
      `CELESTIA_NETWORK must be "${CELESTIA_NETWORK_FOR[network]}" on ${network} (the MIP-0006 shared ` +
        `namespace on Celestia ${CELESTIA_NETWORK_FOR[network]}), got "${celestiaNetworkRaw}"`,
    );
  }

  const rpcUrl = read(env, "CELESTIA_RPC_URL");
  if (rpcUrl === undefined) {
    problems.push(
      `CELESTIA_RPC_URL is required on ${where}: the Celestia RPC endpoint the batcher posts blobs to ` +
        "(no loopback default on a hosted network)",
    );
  } else {
    let protocol = "";
    try {
      protocol = new URL(rpcUrl).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "http:" && protocol !== "https:") {
      problems.push("CELESTIA_RPC_URL must be an absolute http(s) URL");
    }
  }

  if (celestiaAuthOf(env) === "missing") {
    problems.push(
      `CELESTIA_AUTH_TOKEN is required on ${where} (the RPC bearer token of the batcher's funded Celestia ` +
        "signer), or set CELESTIA_AUTH_IN_URL=true when CELESTIA_RPC_URL carries the credential",
    );
  }

  // ── Midnight endpoints: Blockfrost token, no retired host ──
  if (network) problems.push(...midnightEndpointProblems(network, env));

  // ── reference ledger parameters: the pre-fee gate validates against them
  // (celestia.ts resolves them at startup), so a network without a pinned
  // snapshot is refused here, with the reason ──
  const parameters = network ? referenceParametersProblem(network) : undefined;
  if (parameters !== undefined) problems.push(parameters);

  return problems;
}

/**
 * Pure: `base` (what loadBatcherConfig() built) with the public-network
 * corrections: the Celestia network default, the storage directory and the
 * DUST cache on it. Call only after {@link resolvePublicBatcherProblems}
 * returned no problem.
 */
export function applyPublicBatcherProfile(env: EnvMap, base: BatcherConfig): PublicBatcherProfile {
  const warnings: string[] = [];
  const networkId = base.midnight.id;
  const celestiaNetwork = isPublicMidnightNetwork(networkId)
    ? CELESTIA_NETWORK_FOR[networkId]
    : base.celestia.network;
  const storageDir = read(env, "BATCHER_STORAGE_DIR") ?? base.storageDir;

  if (base.celestia.namespace.toLowerCase() !== MIP6_NAMESPACE_SUFFIX_HEX) {
    warnings.push(
      `CELESTIA_NAMESPACE=${base.celestia.namespace} overrides the MIP-0006 shared namespace ` +
        `${MIP6_NAMESPACE_SUFFIX_HEX} (mn-swap-v1); kernels on the shared namespace will not see these offers`,
    );
  }

  return {
    config: {
      ...base,
      storageDir,
      celestia: { ...base.celestia, network: celestiaNetwork },
    },
    dustStateDir: path.join(storageDir, "dust-state"),
    warnings,
    celestiaAuth: celestiaAuthOf(env),
  };
}

/** `protocol//host[:port]` only — the RPC URL may embed a credential. */
export function redactedOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<unparseable URL>";
  }
}

/**
 * The resolved values an operator checks, one per line. The Midnight URLs go
 * through `redact` (the entry hands in midnight-env's
 * `redactBlockfrostProjectId`: Blockfrost URLs carry the project token); the
 * Celestia RPC is reduced to its origin. No seed, no token.
 */
export function describePublicBatcher(
  profile: PublicBatcherProfile,
  redact: (text: string) => string,
): string[] {
  const c = profile.config;
  return [
    `network            : ${c.midnight.id}`,
    `Midnight node      : ${redact(c.midnight.node)}`,
    `Midnight indexer   : ${redact(c.midnight.indexer)}`,
    `Midnight indexer ws: ${redact(c.midnight.indexerWS)}`,
    `proof server       : ${redact(c.midnight.proofServer)}`,
    `Celestia network   : ${c.celestia.network}`,
    `Celestia namespace : ${c.celestia.namespace}${c.celestia.namespace.toLowerCase() === MIP6_NAMESPACE_SUFFIX_HEX ? " (MIP-0006 mn-swap-v1)" : " (OVERRIDE)"}`,
    `Celestia RPC       : ${redactedOrigin(c.celestia.rpcUrl)} (auth: ${profile.celestiaAuth})`,
    `storage dir        : ${c.storageDir}`,
    `DUST-state cache   : ${profile.dustStateDir}`,
    `max slots / wallet : ${c.maxSlotsPerWallet}`,
    `node API (prices)  : ${c.sponsorship.nodeApiUrl} (policy ${c.sponsorship.policy}, unpriced ${c.sponsorship.unpriced})`,
  ];
}
