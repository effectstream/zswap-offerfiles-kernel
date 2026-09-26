// The stagenet batcher profile (00050, FR-002). Pure and unit-testable: the
// entry (batcher.stagenet.ts) feeds it the raw environment and the config
// `loadBatcherConfig()` built, and gets back either a corrected config or the
// full list of refusals — every one naming its variable.
//
// Why a separate check on top of loadBatcherConfig(): that loader is shared
// with the devnet batcher and keeps its devnet conveniences, which are hazards
// on a network with real users:
//
//   * an unset BATCHER_WALLET_SEED silently becomes the PUBLIC seed …03
//     (config.ts BATCHER_SEED) — anyone can drain it, and every other stack
//     that booted on the same default fights this wallet on the node;
//   * CELESTIA_RPC_URL defaults to a loopback light node;
//   * CELESTIA_NETWORK defaults to `devnet`;
//   * the DUST cache lands in a cwd-relative `dust-state/` folder
//     (@effectstream/midnight-contracts DEFAULT_DUST_STATE_DIR), not on the
//     volume that BATCHER_STORAGE_DIR names.
//
// The stagenet entry therefore reads the RAW variables here and never trusts
// a value the loader defaulted.

import path from "node:path";

import { isPublicDevSeed, MIP6_NAMESPACE_ID_SUFFIX_HEX, normalizeSeedHex } from "@zswap-da/offer-guard";

import type { BatcherConfig } from "./config.ts";

export type EnvMap = Record<string, string | undefined>;

export interface StagenetBatcherProfile {
  /** `base` with the stagenet corrections applied (Celestia network). */
  readonly config: BatcherConfig;
  /** `${BATCHER_STORAGE_DIR}/dust-state` — the DUST cache, on the volume. */
  readonly dustStateDir: string;
  readonly problems: readonly string[];
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

/** Pure: validate the stagenet batcher contract against the raw env. */
export function resolveStagenetBatcher(env: EnvMap, base: BatcherConfig): StagenetBatcherProfile {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (base.midnight.id !== "stagenet") {
    problems.push(
      `batcher.stagenet.ts requires MIDNIGHT_NETWORK_ID=stagenet, got "${base.midnight.id || "(unset)"}"`,
    );
  }

  // ── the wallet: required, well-formed, never a public dev seed ──
  const rawSeed = read(env, "BATCHER_WALLET_SEED");
  if (rawSeed === undefined) {
    problems.push(
      "BATCHER_WALLET_SEED is required on stagenet: a dedicated, funded seed (64 or 128 hex chars) " +
        "whose NIGHT is registered for DUST — there is no fallback to the public dev seed",
    );
  } else {
    const seed = normalizeSeedHex(rawSeed);
    if (!/^[0-9a-f]+$/.test(seed) || (seed.length !== 64 && seed.length !== 128)) {
      problems.push(
        `BATCHER_WALLET_SEED must be 64 or 128 hex characters (32 or 64 bytes); got ${seed.length} characters`,
      );
    } else if (isPublicDevSeed(seed)) {
      problems.push(
        "BATCHER_WALLET_SEED is a public dev seed from this repository (anyone can drain it, and other " +
          "stacks on the same seed fight this wallet); give the stagenet batcher its own funded seed",
      );
    }
  }

  // ── storage: required, it carries parked inputs AND the DUST cache ──
  const storageRaw = read(env, "BATCHER_STORAGE_DIR");
  if (storageRaw === undefined) {
    problems.push(
      "BATCHER_STORAGE_DIR is required on stagenet: a persistent directory (a volume) for the batcher's " +
        "parked inputs and its DUST-state cache",
    );
  } else if (!path.isAbsolute(storageRaw)) {
    problems.push(`BATCHER_STORAGE_DIR must be an absolute path, got "${storageRaw}"`);
  }
  const storageDir = storageRaw ?? base.storageDir;

  // ── Celestia: mocha, explicit RPC, auth ──
  let celestiaNetwork = base.celestia.network;
  const celestiaNetworkRaw = read(env, "CELESTIA_NETWORK");
  if (celestiaNetworkRaw === undefined) {
    celestiaNetwork = "mocha";
  } else if (celestiaNetworkRaw !== "mocha") {
    problems.push(
      `CELESTIA_NETWORK must be "mocha" on stagenet (MIP-0006 shared namespace on Celestia mocha), got "${celestiaNetworkRaw}"`,
    );
  }

  const rpcUrl = read(env, "CELESTIA_RPC_URL");
  if (rpcUrl === undefined) {
    problems.push(
      "CELESTIA_RPC_URL is required on stagenet: the mocha RPC endpoint the batcher posts blobs to " +
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

  const token = read(env, "CELESTIA_AUTH_TOKEN");
  const authInUrl = truthy(read(env, "CELESTIA_AUTH_IN_URL"));
  const celestiaAuth = token !== undefined ? "bearer-token" : authInUrl ? "in-url" : "missing";
  if (celestiaAuth === "missing") {
    problems.push(
      "CELESTIA_AUTH_TOKEN is required on stagenet (the mocha RPC bearer token of the batcher's funded " +
        "Celestia signer), or set CELESTIA_AUTH_IN_URL=true when CELESTIA_RPC_URL carries the credential",
    );
  }

  if (base.celestia.namespace.toLowerCase() !== MIP6_NAMESPACE_ID_SUFFIX_HEX) {
    warnings.push(
      `CELESTIA_NAMESPACE=${base.celestia.namespace} overrides the MIP-0006 shared namespace ` +
        `${MIP6_NAMESPACE_ID_SUFFIX_HEX} (mn-swap-v1); stagenet kernels on the shared namespace will not see these offers`,
    );
  }

  return {
    config: {
      ...base,
      storageDir,
      celestia: { ...base.celestia, network: celestiaNetwork },
    },
    dustStateDir: path.join(storageDir, "dust-state"),
    problems,
    warnings,
    celestiaAuth,
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

/** The resolved stagenet values an operator checks, one per line. No secrets. */
export function describeStagenetBatcher(profile: StagenetBatcherProfile): string[] {
  const c = profile.config;
  return [
    `network            : ${c.midnight.id}`,
    `Midnight node      : ${c.midnight.node}`,
    `Midnight indexer   : ${c.midnight.indexer}`,
    `Midnight indexer ws: ${c.midnight.indexerWS}`,
    `proof server       : ${c.midnight.proofServer}`,
    `Celestia network   : ${c.celestia.network}`,
    `Celestia namespace : ${c.celestia.namespace}${c.celestia.namespace.toLowerCase() === MIP6_NAMESPACE_ID_SUFFIX_HEX ? " (MIP-0006 mn-swap-v1)" : " (OVERRIDE)"}`,
    `Celestia RPC       : ${redactedOrigin(c.celestia.rpcUrl)} (auth: ${profile.celestiaAuth})`,
    `storage dir        : ${c.storageDir}`,
    `DUST-state cache   : ${profile.dustStateDir}`,
    `max slots / wallet : ${c.maxSlotsPerWallet}`,
    `node API (prices)  : ${c.sponsorship.nodeApiUrl} (policy ${c.sponsorship.policy}, unpriced ${c.sponsorship.unpriced})`,
  ];
}
