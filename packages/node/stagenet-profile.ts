// The stagenet runtime profile for the sync node + API (00050, FR-001).
//
// Stagenet reuses `config.preview.ts` UNCHANGED. That config takes every value
// from env (NTP anchor and block time, start heights, Celestia RPC and
// namespace), so a stagenet node is the preview node with stagenet's values in
// the environment. This module is what puts them there, and what refuses to
// start when a value that has no safe default is missing:
//
//   * DEFAULTS it applies when the variable is unset or blank:
//       NTP_START_TIME   = 1786638294000 (stagenet block 1, 2026-08-13T16:24:54Z)
//       CELESTIA_NETWORK = mocha
//     The NTP block time stays preview's (`BLOCK_TIME_MS` default 600000 in
//     env.ts). The Celestia namespace stays the MIP-0006 shared one, which is
//     already env.ts's default for an UNSET variable — a blank one is removed
//     here so it cannot become an empty namespace. The root window resolves to
//     stagenet's 14 days in network-windows.ts from MIDNIGHT_NETWORK_ID alone.
//
//   * REQUIRED, refused by name (exit 78, EX_CONFIG) when missing:
//       MIDNIGHT_NETWORK_ID   must be `stagenet`
//       CELESTIA_START_HEIGHT the mocha height to start reading offers at — no
//                             fallback to 1 (weeks of empty mocha blocks), and
//                             frozen by the runtime after the first boot
//       CELESTIA_RPC_URL      no loopback default on a hosted network
//       Celestia auth         CELESTIA_AUTH_TOKEN (bearer, read by the sync
//                             layer's CelestiaClient), or CELESTIA_AUTH_IN_URL=true
//                             when the RPC URL itself carries the credential
//                             (the QuickNode pattern preview uses)
//
// ORDER MATTERS. env.ts and config.preview.ts read the environment when they
// are first evaluated, so the profile must run before either is loaded. That
// is why this file imports nothing that reads env at load time (only the pure
// network-windows.ts), and why main.stagenet.ts imports `stagenet-node-env.ts`
// directly after the onchain-runtime side-effect import and before everything
// else. stagenet-profile.test.ts proves the ordering in a child process.
//
// Run directly (`bun run packages/node/stagenet-profile.ts`) it is the image
// entrypoint's configuration preflight: validate, print the resolved profile,
// exit 0 — or exit 78 naming every problem — without touching the network.

import { resolveRootWindowSeconds } from "./network-windows.ts";

/** Stagenet block 1: 2026-08-13T16:24:54Z (see the 00050 spec). */
export const STAGENET_NTP_START_TIME_MS = 1_786_638_294_000;
/** Stagenet posts and reads offers on Celestia mocha (00050 Q1). */
export const STAGENET_CELESTIA_NETWORK = "mocha";
/**
 * The MIP-0006 shared namespace suffix (`mn-swap-v1`). A local copy on
 * purpose: importing `@zswap-da/offer-guard` here would load the ledger WASM
 * before main.stagenet.ts's onchain-runtime side-effect import. The unit test
 * pins it to `MIP6_NAMESPACE_ID_SUFFIX_HEX`.
 */
export const STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX = "6d6e2d737761702d7631";

export type EnvMap = Record<string, string | undefined>;

export interface StagenetNodeProfile {
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
    readonly ntpStartTimeMs: number;
    readonly celestiaNetwork: string;
    readonly celestiaNamespace: string;
    readonly celestiaStartHeight: number | undefined;
    readonly celestiaAuth: "bearer-token" | "in-url" | "missing";
    readonly celestiaRpcOrigin: string | undefined;
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

/** Pure: resolve the stagenet node profile from an environment snapshot. */
export function resolveStagenetNodeProfile(env: EnvMap): StagenetNodeProfile {
  const problems: string[] = [];
  const warnings: string[] = [];
  const defaults: Record<string, string> = {};
  const unset: string[] = [];

  const networkId = read(env, "MIDNIGHT_NETWORK_ID") ?? "";
  if (networkId !== "stagenet") {
    problems.push(
      `MIDNIGHT_NETWORK_ID must be "stagenet" for the stagenet profile, got "${networkId || "(unset)"}"`,
    );
  }

  // ── NTP anchor ──
  let ntpStartTimeMs = STAGENET_NTP_START_TIME_MS;
  const ntpRaw = read(env, "NTP_START_TIME");
  if (ntpRaw === undefined) {
    defaults["NTP_START_TIME"] = String(STAGENET_NTP_START_TIME_MS);
  } else if (!/^[0-9]+$/.test(ntpRaw)) {
    problems.push(`NTP_START_TIME must be a millisecond timestamp, got "${ntpRaw}"`);
  } else {
    ntpStartTimeMs = Number(ntpRaw);
    if (ntpStartTimeMs !== STAGENET_NTP_START_TIME_MS) {
      warnings.push(
        `NTP_START_TIME=${ntpRaw} overrides the stagenet block-1 anchor ${STAGENET_NTP_START_TIME_MS}`,
      );
    }
  }

  // ── Celestia network ──
  let celestiaNetwork = STAGENET_CELESTIA_NETWORK;
  const celestiaNetworkRaw = read(env, "CELESTIA_NETWORK");
  if (celestiaNetworkRaw === undefined) {
    defaults["CELESTIA_NETWORK"] = STAGENET_CELESTIA_NETWORK;
  } else if (celestiaNetworkRaw !== STAGENET_CELESTIA_NETWORK) {
    problems.push(
      `CELESTIA_NETWORK must be "mocha" on stagenet (MIP-0006 shared namespace on Celestia mocha), got "${celestiaNetworkRaw}"`,
    );
    celestiaNetwork = celestiaNetworkRaw;
  }

  // ── Celestia namespace: MIP-0006 unless deliberately overridden ──
  let celestiaNamespace = STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX;
  const namespaceRaw = read(env, "CELESTIA_NAMESPACE");
  if (namespaceRaw === undefined) {
    if (env["CELESTIA_NAMESPACE"] !== undefined) unset.push("CELESTIA_NAMESPACE");
  } else {
    celestiaNamespace = namespaceRaw;
    if (namespaceRaw.toLowerCase() !== STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX) {
      warnings.push(
        `CELESTIA_NAMESPACE=${namespaceRaw} overrides the MIP-0006 shared namespace ` +
          `${STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX} (mn-swap-v1); stagenet kernels on the shared ` +
          `namespace will not see these offers`,
      );
    }
  }

  // ── Celestia start height: required, no fallback ──
  let celestiaStartHeight: number | undefined;
  const startRaw = read(env, "CELESTIA_START_HEIGHT");
  if (startRaw === undefined) {
    problems.push(
      "CELESTIA_START_HEIGHT is required on stagenet: pin the Celestia mocha height to start reading " +
        "offers from (there is no fallback to 1, and the runtime freezes it after the first boot " +
        "unless USE_DB_STARTHEIGHT is set)",
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
      "CELESTIA_RPC_URL is required on stagenet: the mocha RPC endpoint (no loopback default on a hosted network)",
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
      "CELESTIA_AUTH_TOKEN is required on stagenet (the mocha RPC bearer token), or set " +
        "CELESTIA_AUTH_IN_URL=true when CELESTIA_RPC_URL itself carries the credential",
    );
  }

  // @effectstream/db defaults PGLITE to TRUE (single-connection PGlite mode,
  // and DB_PW is then never sent). The stagenet deploy uses an external
  // Postgres (00050 Q4), which needs PGLITE=false; PGlite stays possible.
  const pglite = read(env, "PGLITE");
  if (pglite === undefined || truthy(pglite)) {
    warnings.push(
      `PGLITE is ${pglite === undefined ? "unset (the runtime defaults it to true)" : `"${pglite}"`}: ` +
        "the node runs in single-connection PGlite mode and does not send DB_PW — set PGLITE=false " +
        "for an external Postgres",
    );
  }

  const rootWindowSeconds = resolveRootWindowSeconds(
    networkId || "stagenet",
    read(env, "ROOT_WINDOW_SECONDS"),
  );

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
      rootWindowSeconds,
    },
  };
}

/** Raised by {@link applyStagenetNodeProfile}; the message lists every problem. */
export class StagenetConfigError extends Error {
  readonly problems: readonly string[];
  constructor(service: string, problems: readonly string[]) {
    super(
      `${service} stagenet configuration is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "StagenetConfigError";
    this.problems = problems;
  }
}

/** One line per resolved value — the stagenet constants an operator checks. */
export function describeStagenetNodeProfile(profile: StagenetNodeProfile): string[] {
  const r = profile.resolved;
  return [
    `network            : ${r.networkId}`,
    `NTP anchor         : ${r.ntpStartTimeMs} (${new Date(r.ntpStartTimeMs).toISOString()})`,
    `Celestia network   : ${r.celestiaNetwork}`,
    `Celestia namespace : ${r.celestiaNamespace}${r.celestiaNamespace === STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX ? " (MIP-0006 mn-swap-v1)" : " (OVERRIDE)"}`,
    `Celestia start     : ${r.celestiaStartHeight ?? "(missing)"}`,
    `Celestia RPC       : ${r.celestiaRpcOrigin ?? "(missing)"} (auth: ${r.celestiaAuth})`,
    `root window        : ${r.rootWindowSeconds} s`,
  ];
}

/**
 * Validate and apply the profile to `env` (process.env by default): throws
 * {@link StagenetConfigError} before changing anything if a problem exists.
 */
export function applyStagenetNodeProfile(env: EnvMap = process.env): StagenetNodeProfile {
  const profile = resolveStagenetNodeProfile(env);
  if (profile.problems.length > 0) throw new StagenetConfigError("node", profile.problems);
  for (const key of profile.unset) delete env[key];
  for (const [key, value] of Object.entries(profile.defaults)) env[key] = value;
  return profile;
}

/**
 * The entry-side wrapper: apply, log with the `[stagenet]` label, and exit 78
 * (EX_CONFIG, the code the image entrypoints use) on a configuration problem.
 */
export function applyStagenetNodeProfileOrExit(env: EnvMap = process.env): StagenetNodeProfile {
  try {
    const profile = applyStagenetNodeProfile(env);
    for (const line of describeStagenetNodeProfile(profile)) console.log(`[stagenet] ${line}`);
    for (const warning of profile.warnings) console.warn(`[stagenet] WARNING: ${warning}`);
    return profile;
  } catch (error) {
    if (error instanceof StagenetConfigError) {
      console.error(`[stagenet] ${error.message}`);
      process.exit(78);
    }
    throw error;
  }
}

// ── configuration preflight (image entrypoint) ────────────────────────────
//
// An async function, NOT a top-level `await`: a top-level await anywhere in
// this file would make it an async module, and main.stagenet.ts's later
// imports could then be evaluated before the profile is applied.
async function preflight(): Promise<void> {
  applyStagenetNodeProfileOrExit();
  // Loaded only now, after the defaults: midnight-env resolves the stagenet
  // endpoints (explicit MIDNIGHT_* env wins) exactly as the node will.
  const { midnightNetworkConfig } = await import("@effectstream/midnight-contracts/midnight-env");
  console.log(`[stagenet] Midnight node       : ${midnightNetworkConfig.node}`);
  console.log(`[stagenet] Midnight indexer    : ${midnightNetworkConfig.indexer}`);
  console.log(`[stagenet] Midnight indexer ws : ${midnightNetworkConfig.indexerWS}`);
  console.log(`[stagenet] proof server        : ${midnightNetworkConfig.proofServer}`);
  console.log("[stagenet] node configuration OK");
  process.exit(0);
}

if (import.meta.main) void preflight();
