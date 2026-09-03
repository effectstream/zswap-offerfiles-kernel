// The process itself: argument parsing, the two modes, exit codes.
//
// Everything with a side effect is injected through RunDeps so the loop's
// schedule and the exit codes are testable without a network, a database or a
// wall clock. The default deps (defaultRunDeps) are what the entrypoints use.

import type { BatchResult } from "./coingecko.ts";
import { fetchAssetPrices } from "./coingecko.ts";
import { runCycle, type CycleResult, type DbConnection } from "./cycle.ts";
import { describeConfig, type PriceFeedConfig } from "./config.ts";

/** Every asset the cycle requested was written. */
export const EXIT_OK = 0;
/** The cycle ran but at least one asset did not land (`--once` only). */
export const EXIT_CYCLE_INCOMPLETE = 2;
/** Misconfiguration: no API key, or a database without this project's schema. */
export const EXIT_CONFIG = 64;

/**
 * Delays after a failed cycle, before falling back to the normal interval.
 * Bounded on purpose: a provider outage must not turn into an ever-tightening
 * retry loop against a metered API, and after ~an hour of failure the next
 * daily cycle is soon enough.
 */
export const RETRY_LADDER_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 45 * 60_000];

export interface Connection {
  db: DbConnection;
  end: () => Promise<void>;
}

export interface RunDeps {
  connect: (config: PriceFeedConfig) => Promise<Connection>;
  fetchAssets: (assetIds: readonly string[], config: PriceFeedConfig) => Promise<BatchResult>;
  /** In-cycle spacing between requests. */
  sleep: (ms: number) => Promise<void>;
  /** Between-cycle wait in loop mode. Resolves early when the signal aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export function parseArgs(argv: readonly string[]): { once: boolean } {
  return { once: argv.includes("--once") };
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plain timers, deliberately NOT unref'd: this process exists to be the loop,
 * so a pending timer is the only thing that should be keeping it alive. An
 * unref'd timer would let the process exit silently between cycles and look
 * like a clean shutdown.
 */
const waitMs = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });

export function defaultRunDeps(): RunDeps {
  return {
    connect: async (config) => {
      const pg = (await import("pg")).default;
      const client = new pg.Client({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
      });
      await client.connect();
      return {
        db: client as unknown as DbConnection,
        end: () => client.end(),
      };
    },
    fetchAssets: (assetIds, config) =>
      fetchAssetPrices(assetIds, {
        apiKey: config.apiKey ?? "",
        baseUrl: config.baseUrl,
        timeoutMs: config.requestTimeoutMs,
      }),
    sleep: sleepMs,
    wait: waitMs,
    now: () => new Date(),
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  };
}

/**
 * The one thing this process says when it has no key. It is a WARNING, not an
 * error: a stack without a key is a supported, working configuration (the
 * schema ships seeded prices), and the service is opt-in everywhere — it is
 * not registered in start.dev.ts at all and its compose service sits behind a
 * profile (Q-11).
 */
const MISSING_KEY_MESSAGE =
  "[price-feed] WARNING: COINGECKO_API_KEY is not set, so this service will do " +
  "nothing. The database already ships seeded reference prices, so quotes keep " +
  "working — set the key only when you want them refreshed.";

/**
 * The schema this process writes into must already exist. A pre-00005 database
 * has no asset_prices, and the failure would otherwise be a bare
 * `relation "asset_prices" does not exist` from inside the first upsert, after
 * a CoinGecko call has already been spent.
 */
async function assertSchema(db: DbConnection): Promise<void> {
  const result = await db.query(
    "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'public' AND table_name IN ('asset_prices', 'price_feed_status')",
    [],
  );
  const present = new Set(
    (result.rows as { table_name: string }[]).map((row) => row.table_name),
  );
  const missing = ["asset_prices", "price_feed_status"].filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `[price-feed] the database is missing ${missing.join(" and ")}. ` +
        "This service needs the 00005 schema — apply packages/database/migrations/000-init.sql " +
        "(the kernel does it at startup) against a fresh database.",
    );
  }
}

/** One cycle against a fresh connection. The connection is always closed. */
export async function runOneCycle(
  deps: RunDeps,
  config: PriceFeedConfig,
): Promise<CycleResult> {
  const connection = await deps.connect(config);
  try {
    await assertSchema(connection.db);
    return await runCycle(
      {
        db: connection.db,
        fetchAssets: (assetIds) => deps.fetchAssets(assetIds, config),
        sleep: deps.sleep,
        now: deps.now,
        log: deps.log,
      },
      { assetIds: config.assetIds, spacingMs: config.spacingMs, batchSize: config.batchSize },
    );
  } finally {
    await connection.end().catch(() => {});
  }
}

/** `--once`: run a single cycle and report through the exit code. */
export async function runOnce(deps: RunDeps, config: PriceFeedConfig): Promise<number> {
  deps.log(describeConfig(config));
  if (config.apiKey === null) {
    deps.logError(MISSING_KEY_MESSAGE);
    return EXIT_CONFIG;
  }
  let result: CycleResult;
  try {
    result = await runOneCycle(deps, config);
  } catch (error) {
    deps.logError(`[price-feed] cycle aborted: ${String((error as Error)?.message ?? error)}`);
    return EXIT_CONFIG;
  }
  const complete =
    result.failed.length === 0 && result.updated.length === config.assetIds.length;
  return complete ? EXIT_OK : EXIT_CYCLE_INCOMPLETE;
}

/**
 * Loop mode: a cycle at start, then one every `intervalMs`. After a failed
 * cycle the next attempt follows RETRY_LADDER_MS, and the ladder resets on the
 * first success.
 *
 * Without a key it warns at start and on every tick and does nothing else
 * (Q-11) — it does NOT exit: a compose service that exits non-zero would
 * crash-loop, and the stack is perfectly usable on the seeded prices meanwhile.
 * It also does not idle forever in silence: a process that logged once at
 * startup and then went quiet for a week is indistinguishable from one that is
 * quietly working, which is exactly the confusion the tick warning removes.
 */
export async function runLoop(
  deps: RunDeps,
  config: PriceFeedConfig,
  signal: AbortSignal,
): Promise<number> {
  deps.log(describeConfig(config));
  if (config.apiKey === null) {
    deps.logError(MISSING_KEY_MESSAGE);
    while (!signal.aborted) {
      await deps.wait(config.intervalMs, signal);
      if (signal.aborted) break;
      deps.logError(MISSING_KEY_MESSAGE);
    }
    return EXIT_OK;
  }

  let retryIndex = 0;
  while (!signal.aborted) {
    let ok = false;
    try {
      const result = await runOneCycle(deps, config);
      ok = result.error === null;
    } catch (error) {
      deps.logError(`[price-feed] cycle aborted: ${String((error as Error)?.message ?? error)}`);
    }

    if (signal.aborted) break;

    let delay: number;
    if (ok) {
      retryIndex = 0;
      delay = config.intervalMs;
    } else {
      delay = RETRY_LADDER_MS[retryIndex] ?? config.intervalMs;
      // Bounded: once the ladder is exhausted the wait stays at the normal
      // interval instead of growing or shrinking forever.
      retryIndex = Math.min(retryIndex + 1, RETRY_LADDER_MS.length);
    }
    deps.log(`[price-feed] next cycle in ${Math.round(delay / 1000)} s`);
    await deps.wait(delay, signal);
  }
  return EXIT_OK;
}

export async function main(
  argv: readonly string[],
  config: PriceFeedConfig,
  deps: RunDeps = defaultRunDeps(),
  signal?: AbortSignal,
): Promise<number> {
  const { once } = parseArgs(argv);
  if (once) return runOnce(deps, config);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await runLoop(deps, config, controller.signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
