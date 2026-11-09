// The public-network profile of the sync node + API: `preview`, `preprod` and
// `mainnet`, selected by MIDNIGHT_NETWORK_ID.
//
// All three run `config.preview.ts` unchanged. That config takes every value
// from env (NTP anchor and block time, start heights, Celestia RPC and
// namespace), so a public node is one config with each network's values in the
// environment. This module is what puts them there, and what refuses to start
// when a value with no safe default is missing:
//
//   * DEFAULTS applied when the variable is unset or blank:
//       NTP_START_TIME   the network's block-1 timestamp (NTP_ANCHOR_MS)
//       CELESTIA_NETWORK mocha on preview and preprod, mainnet on mainnet
//     The NTP block time stays env.ts's 10-minute default. The Celestia
//     namespace stays the MIP-0006 shared one (env.ts's default for an UNSET
//     variable); a blank one is removed here so it cannot become an empty
//     namespace.
//
//   * REQUIRED, refused by name (exit 78, EX_CONFIG) when missing:
//       MIDNIGHT_NETWORK_ID   preview, preprod or mainnet
//       Midnight endpoints    MIDNIGHT_BLOCKFROST_PROJECT_ID while any of
//                             MIDNIGHT_INDEXER_HTTP / _WS / MIDNIGHT_NODE_HTTP
//                             is left to its Blockfrost default; an override on
//                             a retired *.midnight.network host is refused
//       CELESTIA_START_HEIGHT the Celestia height to start reading offers at —
//                             no fallback to 1, and frozen by the runtime after
//                             the first boot
//       CELESTIA_RPC_URL      no loopback default on a hosted network
//       Celestia auth         CELESTIA_AUTH_TOKEN (bearer), or
//                             CELESTIA_AUTH_IN_URL=true when the RPC URL itself
//                             carries the credential
//
// ORDER MATTERS. env.ts, config.preview.ts and midnight-env read the
// environment when they are first evaluated (midnight-env also throws at
// import without a Blockfrost token), so the profile must run before any of
// them is loaded. This file therefore imports nothing that reads env at load
// time: only the pure network-windows.ts and offer-guard's public-networks.ts.
// main.public.ts imports `public-network-env.ts` directly after the
// onchain-runtime side-effect import and before everything else.
//
// Run directly (`bun run packages/node/public-network-profile.ts`) it is the
// image entrypoint's configuration preflight: validate, print the resolved
// profile and the (redacted) endpoints, exit 0 — or exit 78 naming every
// problem — without touching the network.

import {
  CELESTIA_NETWORK_FOR,
  isPublicMidnightNetwork,
  midnightEndpointProblems,
  PUBLIC_MIDNIGHT_NETWORKS,
  unsupportedNetworkProblem,
  type PublicMidnightNetwork,
} from "@zswap-da/offer-guard/public-networks";

import { resolveRootWindowSeconds } from "./network-windows.ts";

/**
 * Block 1 of each public network, in ms: the NTP anchor, so the NTP chain
 * covers the whole Midnight history the sync replays from MIDNIGHT_START_BLOCK
 * (default 1). Read on 2026-11-09 as the `Timestamp.Now` storage value at
 * block 1 over each network's node RPC (node 2.1.101-913ec011); preview's
 * value also matches its indexer's block 1.
 *   preview  block 1 0xee45046d…3947fe  2026-07-16T15:07:48.491Z
 *   preprod  block 1 0xd64fcd69…5af01b  2026-03-20T18:23:24Z
 *   mainnet  block 1 0x1c231b40…e7caf0  2026-03-18T14:19:42Z
 */
export const NTP_ANCHOR_MS: Readonly<Record<PublicMidnightNetwork, number>> = Object.freeze({
  preview: 1_784_214_468_491,
  preprod: 1_774_031_004_000,
  mainnet: 1_773_843_582_000,
});

/**
 * The MIP-0006 shared namespace suffix (`mn-swap-v1`). A local copy on
 * purpose: importing `@zswap-da/offer-guard`'s main module here would load the
 * ledger WASM before main.public.ts's onchain-runtime side-effect import. The
 * unit test pins it to `MIP6_NAMESPACE_ID_SUFFIX_HEX`.
 */
export const MIP6_NAMESPACE_SUFFIX_HEX = "6d6e2d737761702d7631";

/** Exit status for a configuration refusal (EX_CONFIG). */
export const EX_CONFIG = 78;

export type EnvMap = Record<string, string | undefined>;

export interface PublicNodeProfile {
  /** Values to write into the environment (only for unset/blank variables). */
  readonly defaults: Readonly<Record<string, string>>;
  /** Variables that are present but blank and must be removed, not set. */
  readonly unset: readonly string[];
  /** Every refusal, each naming its variable. Empty means startable. */
  readonly problems: readonly string[];
  /** Deliberate deviations worth a log line, never a refusal. */
  readonly warnings: readonly string[];
  /** The effective values after the defaults, for the startup log. */
  readonly resolved: {
    readonly networkId: string;
    readonly ntpStartTimeMs: number | undefined;
    readonly celestiaNetwork: string | undefined;
    readonly celestiaNamespace: string;
    readonly celestiaStartHeight: number | undefined;
    readonly celestiaAuth: "bearer-token" | "in-url" | "missing";
    readonly celestiaRpcOrigin: string | undefined;
    readonly midnightEndpoints: "blockfrost-defaults" | "partial-overrides" | "overrides";
    readonly rootWindowSeconds: number;
  };
}

/** Trimmed value, or undefined for absent / blank. */
function read(env: EnvMap, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : trimmed;
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value);

/**
 * `protocol//host[:port]` of a URL and nothing else: a Celestia RPC URL may
 * embed its credential in the path, the query or the userinfo, and none of
 * that may reach a log.
 */
export function redactedOrigin(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<unparseable URL>";
  }
}

/** Pure: resolve the public-network node profile from an environment snapshot. */
export function resolvePublicNodeProfile(env: EnvMap): PublicNodeProfile {
  const problems: string[] = [];
  const warnings: string[] = [];
  const defaults: Record<string, string> = {};
  const unset: string[] = [];

  const networkId = read(env, "MIDNIGHT_NETWORK_ID") ?? "";
  const network = isPublicMidnightNetwork(networkId) ? networkId : undefined;
  if (network === undefined) {
    problems.push(
      networkId === "undeployed"
        ? `MIDNIGHT_NETWORK_ID="undeployed" is the local devnet: run packages/node/main.dev.ts, not the ` +
            `public-network node (${PUBLIC_MIDNIGHT_NETWORKS.join(", ")})`
        : unsupportedNetworkProblem(networkId),
    );
  }

  // ── NTP anchor: the network's block 1 unless deliberately overridden ──
  let ntpStartTimeMs: number | undefined = network ? NTP_ANCHOR_MS[network] : undefined;
  const ntpRaw = read(env, "NTP_START_TIME");
  if (ntpRaw === undefined) {
    if (network) defaults["NTP_START_TIME"] = String(NTP_ANCHOR_MS[network]);
  } else if (!/^[0-9]+$/.test(ntpRaw)) {
    problems.push(`NTP_START_TIME must be a millisecond timestamp, got "${ntpRaw}"`);
  } else {
    ntpStartTimeMs = Number(ntpRaw);
    if (network && ntpStartTimeMs !== NTP_ANCHOR_MS[network]) {
      warnings.push(
        `NTP_START_TIME=${ntpRaw} overrides the ${network} block-1 anchor ${NTP_ANCHOR_MS[network]}`,
      );
    }
  }

  // ── Celestia network ──
  let celestiaNetwork: string | undefined = network ? CELESTIA_NETWORK_FOR[network] : undefined;
  const celestiaNetworkRaw = read(env, "CELESTIA_NETWORK");
  if (celestiaNetworkRaw === undefined) {
    if (network) defaults["CELESTIA_NETWORK"] = CELESTIA_NETWORK_FOR[network];
  } else {
    if (network && celestiaNetworkRaw !== CELESTIA_NETWORK_FOR[network]) {
      problems.push(
        `CELESTIA_NETWORK must be "${CELESTIA_NETWORK_FOR[network]}" on ${network} ` +
          `(the MIP-0006 shared namespace on Celestia ${CELESTIA_NETWORK_FOR[network]}), got "${celestiaNetworkRaw}"`,
      );
    }
    celestiaNetwork = celestiaNetworkRaw;
  }

  // ── Celestia namespace: MIP-0006 unless deliberately overridden ──
  let celestiaNamespace = MIP6_NAMESPACE_SUFFIX_HEX;
  const namespaceRaw = read(env, "CELESTIA_NAMESPACE");
  if (namespaceRaw === undefined) {
    if (env["CELESTIA_NAMESPACE"] !== undefined) unset.push("CELESTIA_NAMESPACE");
  } else {
    celestiaNamespace = namespaceRaw;
    if (namespaceRaw.toLowerCase() !== MIP6_NAMESPACE_SUFFIX_HEX) {
      warnings.push(
        `CELESTIA_NAMESPACE=${namespaceRaw} overrides the MIP-0006 shared namespace ` +
          `${MIP6_NAMESPACE_SUFFIX_HEX} (mn-swap-v1); kernels on the shared namespace will not see these offers`,
      );
    }
  }

  // ── Celestia start height: required, no fallback ──
  let celestiaStartHeight: number | undefined;
  const startRaw = read(env, "CELESTIA_START_HEIGHT");
  if (startRaw === undefined) {
    problems.push(
      `CELESTIA_START_HEIGHT is required on ${networkId || "a public network"}: pin the Celestia height to ` +
        "start reading offers from (there is no fallback to 1, and the runtime freezes it after the first " +
        "boot unless USE_DB_STARTHEIGHT is set)",
    );
  } else if (!/^[1-9][0-9]*$/.test(startRaw)) {
    problems.push(`CELESTIA_START_HEIGHT must be a positive integer, got "${startRaw}"`);
  } else {
    celestiaStartHeight = Number(startRaw);
  }

  // ── Celestia RPC + auth ──
  const rpcUrl = read(env, "CELESTIA_RPC_URL");
  if (rpcUrl === undefined) {
    problems.push(
      `CELESTIA_RPC_URL is required on ${networkId || "a public network"}: the Celestia RPC endpoint ` +
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
      `CELESTIA_AUTH_TOKEN is required on ${networkId || "a public network"} (the Celestia RPC bearer token), ` +
        "or set CELESTIA_AUTH_IN_URL=true when CELESTIA_RPC_URL itself carries the credential",
    );
  }

  // ── Midnight endpoints: Blockfrost token, no retired host ──
  if (network) problems.push(...midnightEndpointProblems(network, env));
  const overrides = ["MIDNIGHT_INDEXER_HTTP", "MIDNIGHT_INDEXER_WS", "MIDNIGHT_NODE_HTTP"].filter(
    (name) => read(env, name) !== undefined,
  ).length;
  const midnightEndpoints =
    overrides === 0 ? "blockfrost-defaults" : overrides === 3 ? "overrides" : "partial-overrides";

  // @effectstream/db defaults PGLITE to TRUE (single-connection PGlite mode,
  // and DB_PW is then never sent). A deployment uses an external Postgres,
  // which needs PGLITE=false; PGlite stays possible.
  const pglite = read(env, "PGLITE");
  if (pglite === undefined || truthy(pglite)) {
    warnings.push(
      `PGLITE is ${pglite === undefined ? "unset (the runtime defaults it to true)" : `"${pglite}"`}: ` +
        "the node runs in single-connection PGlite mode and does not send DB_PW — set PGLITE=false " +
        "for an external Postgres",
    );
  }

  const rootWindowSeconds = resolveRootWindowSeconds(networkId, read(env, "ROOT_WINDOW_SECONDS"));

  return {
    defaults,
    unset,
    problems,
    warnings,
    resolved: {
      networkId,
      ntpStartTimeMs,
      celestiaNetwork,
      celestiaNamespace,
      celestiaStartHeight,
      celestiaAuth,
      celestiaRpcOrigin: redactedOrigin(rpcUrl),
      midnightEndpoints,
      rootWindowSeconds,
    },
  };
}

/** Raised by {@link applyPublicNodeProfile}; the message lists every problem. */
export class PublicNetworkConfigError extends Error {
  readonly problems: readonly string[];
  constructor(service: string, networkId: string, problems: readonly string[]) {
    super(
      `${service} configuration for MIDNIGHT_NETWORK_ID="${networkId || "(unset)"}" is invalid ` +
        `(${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "PublicNetworkConfigError";
    this.problems = problems;
  }
}

/** One line per resolved value — what an operator checks. No secrets. */
export function describePublicNodeProfile(profile: PublicNodeProfile): string[] {
  const r = profile.resolved;
  return [
    `network            : ${r.networkId}`,
    `NTP anchor         : ${r.ntpStartTimeMs ?? "(missing)"}` +
      (r.ntpStartTimeMs === undefined ? "" : ` (${new Date(r.ntpStartTimeMs).toISOString()})`),
    `Celestia network   : ${r.celestiaNetwork ?? "(missing)"}`,
    `Celestia namespace : ${r.celestiaNamespace}${r.celestiaNamespace.toLowerCase() === MIP6_NAMESPACE_SUFFIX_HEX ? " (MIP-0006 mn-swap-v1)" : " (OVERRIDE)"}`,
    `Celestia start     : ${r.celestiaStartHeight ?? "(missing)"}`,
    `Celestia RPC       : ${r.celestiaRpcOrigin ?? "(missing)"} (auth: ${r.celestiaAuth})`,
    `Midnight endpoints : ${r.midnightEndpoints}`,
    `root window        : ${r.rootWindowSeconds} s`,
  ];
}

/** The Midnight endpoints a service dials, as they may be logged. */
export interface MidnightEndpoints {
  readonly node: string;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly proofServer: string;
}

/**
 * The endpoint lines, every URL passed through `redact` (the caller hands in
 * `redactBlockfrostProjectId` from midnight-env): Blockfrost URLs carry the
 * project token in their query string. Kept free of a midnight-env import so
 * this module can run before midnight-env is evaluated.
 */
export function describeMidnightEndpoints(
  endpoints: MidnightEndpoints,
  redact: (text: string) => string,
): string[] {
  return [
    `Midnight node      : ${redact(endpoints.node)}`,
    `Midnight indexer   : ${redact(endpoints.indexer)}`,
    `Midnight indexer ws: ${redact(endpoints.indexerWS)}`,
    `proof server       : ${redact(endpoints.proofServer)}`,
  ];
}

/**
 * Validate and apply the profile to `env` (process.env by default): throws
 * {@link PublicNetworkConfigError} before changing anything if a problem
 * exists.
 */
export function applyPublicNodeProfile(env: EnvMap = process.env): PublicNodeProfile {
  const profile = resolvePublicNodeProfile(env);
  if (profile.problems.length > 0) {
    throw new PublicNetworkConfigError("node", profile.resolved.networkId, profile.problems);
  }
  for (const key of profile.unset) delete env[key];
  for (const [key, value] of Object.entries(profile.defaults)) env[key] = value;
  return profile;
}

/**
 * The entry-side wrapper: apply, log with the network as label, and exit 78
 * (EX_CONFIG, the code the image entrypoints use) on a configuration problem.
 */
export function applyPublicNodeProfileOrExit(env: EnvMap = process.env): PublicNodeProfile {
  try {
    const profile = applyPublicNodeProfile(env);
    const label = `[${profile.resolved.networkId}]`;
    for (const line of describePublicNodeProfile(profile)) console.log(`${label} ${line}`);
    for (const warning of profile.warnings) console.warn(`${label} WARNING: ${warning}`);
    return profile;
  } catch (error) {
    if (error instanceof PublicNetworkConfigError) {
      console.error(`[public-network] ${error.message}`);
      process.exit(EX_CONFIG);
    }
    throw error;
  }
}

// ── configuration preflight (image entrypoint) ────────────────────────────
//
// An async function, NOT a top-level `await`: a top-level await anywhere in
// this file would make it an async module, and main.public.ts's later imports
// could then be evaluated before the profile is applied.
async function preflight(): Promise<void> {
  const profile = applyPublicNodeProfileOrExit();
  const label = `[${profile.resolved.networkId}]`;
  // Loaded only now, after the checks: midnight-env resolves the endpoints
  // (explicit MIDNIGHT_* env wins) exactly as the node will.
  const { midnightNetworkConfig, redactBlockfrostProjectId } = await import(
    "@effectstream/midnight-contracts/midnight-env"
  );
  for (const line of describeMidnightEndpoints(midnightNetworkConfig, redactBlockfrostProjectId)) {
    console.log(`${label} ${line}`);
  }
  console.log(`${label} node configuration OK`);
  process.exit(0);
}

if (import.meta.main) void preflight();
