import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

import { getEnv } from "@effectstream/utils/runtime";

// Dev seed. Must avoid every other wallet on the dev stack — genesis, the
// batcher's (…0003/…0004), and the ring-maker range (…0005+) — because two
// facades on one seed against one node force each other's connection down.
export const DEV_SEED = "0000000000000000000000000000000000000000000000000000000000000021";

export const SOLVER_SEED = getEnv("SOLVER_SEED") ?? DEV_SEED;

export const ZSWAP_API = getEnv("ZSWAP_API") ?? "http://127.0.0.1:9999";

/**
 * Midnight Intents relay client (FR-012).
 *
 * `SOLVER_RELAY_AUTH_TOKEN` is the SAME shared secret the relay deployment
 * calls `SOLVER_AUTH_TOKEN` (and the reference solver reads under that name).
 * The explicit prefix says which outbound boundary it authenticates. The
 * backend exact-files read is intentionally unauthenticated. The relay refuses
 * a token shorter than 32 characters.
 */
export const SOLVER_RELAY_WS_URL = getEnv("SOLVER_RELAY_WS_URL") ?? "";
export const SOLVER_RELAY_HTTP_URL = getEnv("SOLVER_RELAY_HTTP_URL") ?? "";
export const SOLVER_RELAY_AUTH_TOKEN = getEnv("SOLVER_RELAY_AUTH_TOKEN") ?? "";

export const SOLVER_LADDER_CONFIG =
  getEnv("SOLVER_LADDER_CONFIG") ??
  // fileURLToPath, not URL.pathname: pathname percent-encodes, so a checkout
  // under a directory with a space yields a path readFile cannot open.
  fileURLToPath(new URL("./config/ladders.dev.json", import.meta.url));

type EnvReader = (name: string) => string | undefined;

export interface SolverRelayHttpEnvOptions {
  relayExecutionEnabled: boolean;
}

export function parseSolverRelayHttpUrl(raw: string): string {
  const name = "SOLVER_RELAY_HTTP_URL";
  if (raw.length === 0 || raw.trim() !== raw || raw.includes("\0")) {
    throw new Error(`${name} must be a non-empty canonical HTTP(S) URL without whitespace or NUL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `${name} must use http/https and contain no credentials, query, or fragment`,
    );
  }
  if (parsed.pathname.includes("//")) {
    throw new Error(`${name} path must not contain empty segments`);
  }
  parsed.pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

/** The public relay status authority is configured explicitly. It is never
 * guessed by rewriting the websocket URL because the deployed HTTP prefix may
 * be different (for example `/api/v1`). */
export function loadSolverRelayHttpEnv(
  read: EnvReader = getEnv,
  options: SolverRelayHttpEnvOptions = { relayExecutionEnabled: true },
): string | null {
  const raw = read("SOLVER_RELAY_HTTP_URL");
  if (raw === undefined) {
    if (!options.relayExecutionEnabled) return null;
    throw new Error("SOLVER_RELAY_HTTP_URL is required when relay job execution is enabled");
  }
  return parseSolverRelayHttpUrl(raw);
}

export interface SolverJournalEnv {
  path: string;
  allowMemory: boolean;
}

export interface SolverJournalEnvOptions {
  /** A mirror-only process does not execute relay jobs and need not own a journal. */
  relayExecutionEnabled: boolean;
  /** `:memory:` is structurally unavailable to production callers. */
  runtimeMode?: "production" | "test-harness";
  warn?: (message: string) => void;
}

/** Parse one bounded base-10 integer without parseInt's prefix/coercion traps. */
export function parseBoundedIntegerEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name}: expected a base-10 integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
  const parsed = BigInt(value);
  if (parsed < BigInt(min) || parsed > BigInt(max) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name}: expected a base-10 integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
  return Number(parsed);
}

/** Boolean environment values are deliberately canonical. Typos must stop
 * startup instead of silently selecting a trading mode. */
export function parseBooleanEnv(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name}: expected exactly "true" or "false", got ${JSON.stringify(raw)}`);
}

/**
 * Parse the durable wallet-operation journal boundary independently of the
 * relay client. RF1B wires this into lifecycle ordering; RF1A keeps parsing
 * side-effect-free and makes `:memory:` impossible outside an explicit test
 * harness.
 */
export function loadSolverJournalEnv(
  read: EnvReader = getEnv,
  options: SolverJournalEnvOptions = { relayExecutionEnabled: true },
): SolverJournalEnv | null {
  const rawPath = read("SOLVER_JOURNAL_PATH");
  const rawAllowMemory = read("SOLVER_JOURNAL_ALLOW_MEMORY");
  const allowMemory = parseBooleanEnv(
    "SOLVER_JOURNAL_ALLOW_MEMORY",
    rawAllowMemory,
    false,
  );

  if (rawPath === undefined) {
    if (allowMemory) {
      throw new Error("SOLVER_JOURNAL_ALLOW_MEMORY=true requires SOLVER_JOURNAL_PATH=:memory:");
    }
    if (!options.relayExecutionEnabled) return null;
    throw new Error(
      "SOLVER_JOURNAL_PATH is required when relay job execution is enabled",
    );
  }
  if (rawPath.length === 0 || rawPath.trim() !== rawPath || rawPath.includes("\0")) {
    throw new Error("SOLVER_JOURNAL_PATH must be a non-empty canonical path without whitespace or NUL bytes");
  }

  if (rawPath === ":memory:") {
    if (!allowMemory || options.runtimeMode !== "test-harness") {
      throw new Error(
        "SOLVER_JOURNAL_PATH=:memory: requires SOLVER_JOURNAL_ALLOW_MEMORY=true in an explicit test harness",
      );
    }
    try {
      options.warn?.(
        "[JOURNAL] using :memory: test harness — wallet-operation state will not survive restart",
      );
    } catch {
      // Diagnostics never alter the safety decision or create an unhandled throw.
    }
    return { path: rawPath, allowMemory: true };
  }

  if (allowMemory) {
    throw new Error("SOLVER_JOURNAL_ALLOW_MEMORY=true is valid only with SOLVER_JOURNAL_PATH=:memory:");
  }
  if (!isAbsolute(rawPath)) {
    throw new Error("SOLVER_JOURNAL_PATH must be an absolute mounted-volume path");
  }
  return { path: rawPath, allowMemory: false };
}

export interface SolverRuntimeEnv {
  maxCycleLen: number;
  resyncIntervalMs: number;
  backendHealthCheckIntervalMs: number;
  backendHealthMaxAgeMs: number;
  expiryMarginSeconds: number;
  offerTtlSeconds: number;
  settleTtlMinutes: number;
  statusPollMs: number;
}

export function loadSolverRuntimeEnv(read: EnvReader = getEnv): SolverRuntimeEnv {
  const env: SolverRuntimeEnv = {
    maxCycleLen: parseBoundedIntegerEnv("SOLVER_MAX_CYCLE_LEN", read("SOLVER_MAX_CYCLE_LEN"), 3, 2, 8),
    resyncIntervalMs: parseBoundedIntegerEnv(
      "SOLVER_RESYNC_INTERVAL_MS",
      read("SOLVER_RESYNC_INTERVAL_MS"),
      300_000,
      1_000,
      86_400_000,
    ),
    backendHealthCheckIntervalMs: parseBoundedIntegerEnv(
      "SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS",
      read("SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS"),
      5_000,
      250,
      3_600_000,
    ),
    backendHealthMaxAgeMs: parseBoundedIntegerEnv(
      "SOLVER_BACKEND_HEALTH_MAX_AGE_MS",
      read("SOLVER_BACKEND_HEALTH_MAX_AGE_MS"),
      15_000,
      1_000,
      3_600_000,
    ),
    expiryMarginSeconds: parseBoundedIntegerEnv(
      "SOLVER_EXPIRY_MARGIN_SECONDS",
      read("SOLVER_EXPIRY_MARGIN_SECONDS"),
      120,
      1,
      604_800,
    ),
    offerTtlSeconds: parseBoundedIntegerEnv(
      "OFFER_TTL_SECONDS",
      read("OFFER_TTL_SECONDS"),
      3_600,
      2,
      604_800,
    ),
    settleTtlMinutes: parseBoundedIntegerEnv(
      "SOLVER_SETTLE_TTL_MINUTES",
      read("SOLVER_SETTLE_TTL_MINUTES"),
      30,
      1,
      1_440,
    ),
    statusPollMs: parseBoundedIntegerEnv(
      "SOLVER_STATUS_POLL_MS",
      read("SOLVER_STATUS_POLL_MS"),
      5_000,
      100,
      60_000,
    ),
  };

  if (env.expiryMarginSeconds >= env.offerTtlSeconds) {
    throw new Error(
      `SOLVER_EXPIRY_MARGIN_SECONDS (${env.expiryMarginSeconds}) must be less than ` +
        `OFFER_TTL_SECONDS (${env.offerTtlSeconds})`,
    );
  }
  if (env.backendHealthCheckIntervalMs >= env.backendHealthMaxAgeMs) {
    throw new Error(
      `SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS (${env.backendHealthCheckIntervalMs}) must be less than ` +
        `SOLVER_BACKEND_HEALTH_MAX_AGE_MS (${env.backendHealthMaxAgeMs})`,
    );
  }
  return env;
}

export interface RelayClientEnv {
  /** FR-012's cadence: ladders are re-pushed once per second. */
  pushIntervalMs: number;
  /** FR-012's reconnect delay. */
  reconnectDelayMs: number;
  connectTimeoutMs: number;
  /** Bound on the graceful withdrawal before stop (R-41). */
  withdrawTimeoutMs: number;
  /** Advertised in `solver-capabilities`; N5 enforces it (FR-019). */
  maxParallelSwaps: number;
}

/**
 * Numeric knobs for the relay client. Deliberately a function rather than
 * module-level constants: the relay client is a process INDEPENDENT of the
 * book mirror (FR-005/FR-012), so importing this module must not make a
 * mirror-only entrypoint fail on relay configuration it never uses.
 */
export function loadRelayClientEnv(read: EnvReader = getEnv): RelayClientEnv {
  return {
    pushIntervalMs: parseBoundedIntegerEnv(
      "SOLVER_RELAY_PUSH_INTERVAL_MS",
      read("SOLVER_RELAY_PUSH_INTERVAL_MS"),
      1_000,
      50,
      60_000,
    ),
    reconnectDelayMs: parseBoundedIntegerEnv(
      "SOLVER_RELAY_RECONNECT_DELAY_MS",
      read("SOLVER_RELAY_RECONNECT_DELAY_MS"),
      2_000,
      50,
      300_000,
    ),
    connectTimeoutMs: parseBoundedIntegerEnv(
      "SOLVER_RELAY_CONNECT_TIMEOUT_MS",
      read("SOLVER_RELAY_CONNECT_TIMEOUT_MS"),
      10_000,
      100,
      300_000,
    ),
    withdrawTimeoutMs: parseBoundedIntegerEnv(
      "SOLVER_RELAY_WITHDRAW_TIMEOUT_MS",
      read("SOLVER_RELAY_WITHDRAW_TIMEOUT_MS"),
      2_000,
      50,
      60_000,
    ),
    maxParallelSwaps: parseBoundedIntegerEnv(
      "SOLVER_RELAY_MAX_PARALLEL_SWAPS",
      read("SOLVER_RELAY_MAX_PARALLEL_SWAPS"),
      8,
      1,
      1_024,
    ),
  };
}

const runtime = loadSolverRuntimeEnv();

/** Longest crossing cycle the engine will enumerate. */
export const SOLVER_MAX_CYCLE_LEN = runtime.maxCycleLen;
/** The stream has no replay, so periodically rebuild the complete book. */
export const SOLVER_RESYNC_INTERVAL_MS = runtime.resyncIntervalMs;
export const SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS = runtime.backendHealthCheckIntervalMs;
export const SOLVER_BACKEND_HEALTH_MAX_AGE_MS = runtime.backendHealthMaxAgeMs;
export const SOLVER_EXPIRY_MARGIN_SECONDS = runtime.expiryMarginSeconds;
export const SOLVER_OFFER_TTL_SECONDS = runtime.offerTtlSeconds;
export const SOLVER_SETTLE_TTL_MINUTES = runtime.settleTtlMinutes;
export const SOLVER_STATUS_POLL_MS = runtime.statusPollMs;

/** Mirror the book and log every decision, but never build or submit a
 *  transaction. Safe to point at any environment. */
export const isDryRun = (fallback = false): boolean =>
  parseBooleanEnv("SOLVER_DRY_RUN", getEnv("SOLVER_DRY_RUN"), fallback);

export const isSolverEnabled = (): boolean =>
  parseBooleanEnv("SOLVER_ENABLED", getEnv("SOLVER_ENABLED"), true);

export const isMainnetLiveTradingAcknowledged = (): boolean =>
  parseBooleanEnv(
    "SOLVER_MAINNET_LIVE_TRADING_ACK",
    getEnv("SOLVER_MAINNET_LIVE_TRADING_ACK"),
    false,
  );
