import { fileURLToPath } from "node:url";

import { getEnv } from "@effectstream/utils/runtime";

// Dev seed. Must avoid every other wallet on the dev stack — genesis, the
// batcher's (…0003/…0004), and the ring-maker range (…0005+) — because two
// facades on one seed against one node force each other's connection down.
export const DEV_SEED = "0000000000000000000000000000000000000000000000000000000000000021";

export const SOLVER_SEED = getEnv("SOLVER_SEED") ?? DEV_SEED;

export const ZSWAP_API = getEnv("ZSWAP_API") ?? "http://127.0.0.1:9999";
export const BATCHER_SUBMIT_URL = getEnv("BATCHER_SUBMIT_URL") ?? "http://127.0.0.1:3334";
export const SOLVER_LEVELS_AUTH_TOKEN = getEnv("SOLVER_LEVELS_AUTH_TOKEN") ?? "";

export const SOLVER_LADDER_CONFIG =
  getEnv("SOLVER_LADDER_CONFIG") ??
  // fileURLToPath, not URL.pathname: pathname percent-encodes, so a checkout
  // under a directory with a space yields a path readFile cannot open.
  fileURLToPath(new URL("./config/ladders.dev.json", import.meta.url));

type EnvReader = (name: string) => string | undefined;

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

export interface SolverRuntimeEnv {
  maxCycleLen: number;
  resyncIntervalMs: number;
  expiryMarginSeconds: number;
  offerTtlSeconds: number;
  settleTtlMinutes: number;
  levelsPushIntervalMs: number;
  levelsTtlSeconds: number;
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
    levelsPushIntervalMs: parseBoundedIntegerEnv(
      "SOLVER_LEVELS_PUSH_INTERVAL_MS",
      read("SOLVER_LEVELS_PUSH_INTERVAL_MS"),
      5_000,
      100,
      3_600_000,
    ),
    levelsTtlSeconds: parseBoundedIntegerEnv(
      "SOLVER_LEVELS_TTL_SECONDS",
      read("SOLVER_LEVELS_TTL_SECONDS"),
      60,
      1,
      86_400,
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
  if (env.levelsPushIntervalMs >= env.levelsTtlSeconds * 1_000) {
    throw new Error(
      `SOLVER_LEVELS_PUSH_INTERVAL_MS (${env.levelsPushIntervalMs}) must be less than ` +
        `SOLVER_LEVELS_TTL_SECONDS (${env.levelsTtlSeconds})`,
    );
  }
  return env;
}

const runtime = loadSolverRuntimeEnv();

/** Longest crossing cycle the engine will enumerate. */
export const SOLVER_MAX_CYCLE_LEN = runtime.maxCycleLen;
/** The stream has no replay, so periodically rebuild the complete book. */
export const SOLVER_RESYNC_INTERVAL_MS = runtime.resyncIntervalMs;
export const SOLVER_EXPIRY_MARGIN_SECONDS = runtime.expiryMarginSeconds;
export const SOLVER_OFFER_TTL_SECONDS = runtime.offerTtlSeconds;
export const SOLVER_SETTLE_TTL_MINUTES = runtime.settleTtlMinutes;
export const SOLVER_LEVELS_PUSH_INTERVAL_MS = runtime.levelsPushIntervalMs;
export const SOLVER_LEVELS_TTL_SECONDS = runtime.levelsTtlSeconds;
export const SOLVER_STATUS_POLL_MS = runtime.statusPollMs;

/** Mirror the book and log every decision, but never build or submit a
 *  transaction. Safe to point at any environment. */
export const isDryRun = (fallback = false): boolean =>
  parseBooleanEnv("SOLVER_DRY_RUN", getEnv("SOLVER_DRY_RUN"), fallback);

export const isSolverEnabled = (): boolean =>
  parseBooleanEnv("SOLVER_ENABLED", getEnv("SOLVER_ENABLED"), true);

/** Experimental surfaces stay disabled until their economic oracle is
 * independently approved. Exact two-way zero-residual crossings are separate. */
export const isCyclesEnabled = (): boolean =>
  parseBooleanEnv("SOLVER_ENABLE_CYCLES", getEnv("SOLVER_ENABLE_CYCLES"), false);

/** All merged-offer execution is outside the R0-approved default scope. */
export const isPathBEnabled = (): boolean =>
  parseBooleanEnv("SOLVER_ENABLE_PATH_B", getEnv("SOLVER_ENABLE_PATH_B"), false);

export const isResidualTopUpsEnabled = (): boolean =>
  parseBooleanEnv(
    "SOLVER_ENABLE_RESIDUAL_TOPUPS",
    getEnv("SOLVER_ENABLE_RESIDUAL_TOPUPS"),
    false,
  );

/** Authenticated quote publication is a separate capability from settlement.
 * It stays off until both sides are explicitly configured for the protocol. */
export const isLevelsPublicationEnabled = (): boolean =>
  parseBooleanEnv(
    "SOLVER_ENABLE_LEVELS_PUBLICATION",
    getEnv("SOLVER_ENABLE_LEVELS_PUBLICATION"),
    false,
  );

export const isMainnetLiveTradingAcknowledged = (): boolean =>
  parseBooleanEnv(
    "SOLVER_MAINNET_LIVE_TRADING_ACK",
    getEnv("SOLVER_MAINNET_LIVE_TRADING_ACK"),
    false,
  );
