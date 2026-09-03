import {
  SHIELDED_NIGHT_BY_NETWORK,
  seedNetworkKnownTokens,
  type NetworkSeedResult,
  type QueryableConnection,
} from "@zswap-da/database";

// Startup registration of the running network's sNight row.
//
// WHY IT IS A STARTUP STEP AND NOT SQL. 000-init.sql seeds only colours that
// are the same on every network, and the runtime applies `migrationTable` by
// BLOCK HEIGHT — an entry runs while a database syncs through block 1 and
// never again — so nothing written there can reach a database that is already
// live. preprod's is. See packages/database/network-tokens.ts.
//
// WHY IT RETRIES. On a FRESH database the schema does not exist yet when this
// runs: the runtime spawns the HTTP server (and with it this router) before
// the first block is processed, and 000-init.sql is applied inside that first
// block's transaction. So the first attempt legitimately fails with
// `undefined_table`, and the seed simply waits for the schema to appear. On an
// existing database — the deployment case — the first attempt succeeds and no
// timer is ever armed beyond the first tick.

/** PostgreSQL `undefined_table`: the schema has not been applied yet. */
const UNDEFINED_TABLE = "42P01";

export interface NetworkTokenSeedOptions {
  /** Delay between attempts while the schema is still missing (default 1 s). */
  intervalMs?: number;
  /** Give up after this many attempts (default 600 ≈ 10 minutes at 1 s). */
  maxAttempts?: number;
  log?: (line: string) => void;
  warn?: (line: string, error?: unknown) => void;
}

export interface NetworkTokenSeedHandle {
  /** Resolves once the seed has applied, skipped, or given up. */
  readonly settled: Promise<void>;
  /** Cancel a pending retry (server shutdown). */
  stop(): void;
}

/** The single line an operator sees for a finished seed. */
function describe(networkId: string, result: NetworkSeedResult): {
  line: string;
  isWarning: boolean;
} {
  if (result.inserted.length > 0) {
    return {
      line: `known_tokens: seeded SNIGHT ${result.inserted.join(", ")} for ${networkId}`,
      isWarning: false,
    };
  }
  const skip = result.skipped[0];
  if (skip === undefined) {
    return { line: `known_tokens: nothing to seed for ${networkId}`, isWarning: false };
  }
  return {
    line: `known_tokens: SNIGHT not seeded for ${networkId} — ${skip.reason}`,
    // "already registered" is the steady state of every restart after the
    // first; the other reasons are something an operator should look at.
    isWarning: skip.code !== "already-registered",
  };
}

/**
 * Register the running network's sNight row, retrying only while the schema is
 * still being created. Never throws and never rejects `settled`: a node that
 * cannot label one token must still serve.
 */
export function startNetworkTokenSeed(
  dbConn: QueryableConnection,
  networkId: string,
  options: NetworkTokenSeedOptions = {},
): NetworkTokenSeedHandle {
  const intervalMs = options.intervalMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 600;
  const log = options.log ?? ((line: string) => console.log(`[TOKENS] ${line}`));
  const warn = options.warn ??
    ((line: string, error?: unknown) =>
      error === undefined
        ? console.warn(`[TOKENS] ${line}`)
        : console.warn(`[TOKENS] ${line}`, error));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  // Nothing is deployed on this network: no row, no log, no timer.
  if (!SHIELDED_NIGHT_BY_NETWORK.has(networkId)) {
    resolveSettled();
    return { settled, stop: () => {} };
  }

  let attempts = 0;
  const attempt = async (): Promise<void> => {
    if (stopped) return;
    attempts += 1;
    try {
      const result = await seedNetworkKnownTokens(dbConn, networkId);
      const { line, isWarning } = describe(networkId, result);
      if (isWarning) warn(line);
      else log(line);
      resolveSettled();
    } catch (error) {
      if (stopped) return resolveSettled();
      const code = (error as { code?: string } | null)?.code;
      if (attempts >= maxAttempts) {
        warn(
          `known_tokens: gave up seeding SNIGHT for ${networkId} after ${attempts} attempts`,
          error,
        );
        return resolveSettled();
      }
      if (code !== UNDEFINED_TABLE && attempts === 1) {
        // Not the expected "schema not applied yet"; say so once, then keep
        // retrying anyway — a connection that is not ready at startup is the
        // other thing this survives.
        warn(`known_tokens: SNIGHT seed attempt failed, retrying`, error);
      }
      timer = setTimeout(() => {
        timer = null;
        void attempt();
      }, intervalMs);
      (timer as any).unref?.();
    }
  };

  void attempt();

  return {
    settled,
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolveSettled();
    },
  };
}
