// Per-protocol sync state for the /api/health/sync endpoint.
//
// NTP current block is read from effectstream.effectstream_blocks (exact).
// Parallel chain positions come from effectstream.sync_protocol_pagination:
//   MIN(page_number) = last merged native block (preserved as cursor by the merger)
//   MAX(page_number) = latest prefetched native block (furthest ahead in buffer)
// Chain tips are fetched externally and cached for 60 s to limit outbound calls.

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { BLOCK_TIME_MS, CELESTIA_RPC_URL, NTP_START_TIME } from "./env.ts";
import {
  getNtpCurrentBlock,
  getNtpConfigSnapshot,
  getSyncProtocolPagination,
  getLatestEffectstreamBlock,
  getNullifierStats,
  getKnownRootStats,
  getUnshieldedStats,
  getLastOffer,
  getRecentRejections,
} from "@zswap-da/database";

interface CachedTip {
  value: number | null;
  fetchedAt: number;
}
const TIP_TTL_MS = 60_000;
const TIP_TIMEOUT_MS = 5_000;
const tipCache: Record<string, CachedTip> = {};

async function cachedFetch(key: string, fn: () => Promise<number | null>): Promise<number | null> {
  const hit = tipCache[key];
  if (hit && Date.now() - hit.fetchedAt < TIP_TTL_MS) return hit.value;
  let value: number | null = null;
  try { value = await fn(); } catch { /* leave null */ }
  tipCache[key] = { value, fetchedAt: Date.now() };
  return value;
}

export async function fetchJsonWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = TIP_TIMEOUT_MS,
): Promise<any> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid fetch deadline: ${timeoutMs}`);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`tip request failed with HTTP ${res.status}`);
    // Include body decoding in the same absolute deadline. Headers alone are
    // not progress if an upstream leaves its JSON stream open indefinitely.
    return await res.json();
  })();
  // Observe any late rejection after the deadline wins the race. This matters
  // for fetch implementations which reject only in response to abort.
  void operation.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`tip request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

async function fetchMidnightTip(): Promise<number | null> {
  return cachedFetch("midnight", async () => {
    const json = await fetchJsonWithDeadline(fetch, midnightNetworkConfig.indexer, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { block { height } }" }),
    });
    const h = json?.data?.block?.height;
    return typeof h === "number" ? h : null;
  });
}

async function fetchCelestiaTip(): Promise<number | null> {
  return cachedFetch("celestia", async () => {
    const json = await fetchJsonWithDeadline(fetch, CELESTIA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "header.NetworkHead", params: [], id: 1 }),
    });
    const h = parseInt(json?.result?.header?.height, 10);
    return Number.isFinite(h) ? h : null;
  });
}

function pct(current: number, tip: number | null): number | null {
  if (tip == null || tip <= 0) return null;
  const p = Math.round((current / tip) * 1000) / 10;
  // Never show 100 when there are still blocks to process.
  return current < tip ? Math.min(p, 99.9) : p;
}

export interface ReadinessInput {
  ntpCurrent: number;
  ntpLagSeconds: number;
  ntpBlockMs: number;
  midnightCurrent: number | null;
  midnightTip: number | null;
  celestiaCurrent: number | null;
  celestiaTip: number | null;
}

// Liveness sets are unsafe to use when either source chain position is
// unknown or behind. Permit the configured parallel delays plus a small block
// cushion, but never report ready solely because NTP itself is current.
export const MAX_MIDNIGHT_LAG_BLOCKS = 12;
export const MAX_CELESTIA_LAG_BLOCKS = 4;

export function deriveSyncStatus(input: ReadinessInput): "ok" | "syncing" | "error" {
  const {
    ntpCurrent,
    ntpLagSeconds,
    ntpBlockMs,
    midnightCurrent,
    midnightTip,
    celestiaCurrent,
    celestiaTip,
  } = input;
  if (!Number.isFinite(ntpCurrent) || ntpCurrent <= 0 ||
      !Number.isFinite(ntpBlockMs) || ntpBlockMs <= 0 ||
      !Number.isFinite(ntpLagSeconds) || ntpLagSeconds < 0) return "error";
  if (
    midnightCurrent === null || midnightTip === null ||
    celestiaCurrent === null || celestiaTip === null
  ) return "syncing";
  if (![midnightCurrent, midnightTip, celestiaCurrent, celestiaTip].every(
    (height) => Number.isFinite(height) && height >= 0,
  )) return "syncing";
  if (ntpLagSeconds > ntpBlockMs * 2 / 1000) return "syncing";
  if (midnightTip - midnightCurrent > MAX_MIDNIGHT_LAG_BLOCKS) return "syncing";
  if (celestiaTip - celestiaCurrent > MAX_CELESTIA_LAG_BLOCKS) return "syncing";
  return "ok";
}

// The set-size stats are COUNT(*) + MAX(height) over append-only tables
// (created_unshielded grows from genesis forever, nullifiers with every
// spend). /api/health/sync is rate-limit-exempt and polled by UIs as a
// liveness probe, so these scans must not run per request — cache them.
// 15 s staleness is irrelevant for totals that only ever grow.
const SET_STATS_TTL_MS = 15_000;
type SetStats = { nullifiers: any; roots: any; unshielded: any };
let setStatsCaches = new WeakMap<object, { value: SetStats; fetchedAt: number }>();

async function fetchSetStats(dbConn: any): Promise<SetStats> {
  const cacheKey = dbConn as object;
  const cached = setStatsCaches.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SET_STATS_TTL_MS) {
    return cached.value;
  }
  const [nullifierRows, rootRows, unshieldedRows] = await runSequentially([
    () => getNullifierStats.run(undefined, dbConn),
    () => getKnownRootStats.run(undefined, dbConn),
    () => getUnshieldedStats.run(undefined, dbConn),
  ] as const);
  const value = {
    nullifiers: nullifierRows[0] ?? null,
    roots: rootRows[0] ?? null,
    unshielded: unshieldedRows[0] ?? null,
  };
  setStatsCaches.set(cacheKey, { value, fetchedAt: Date.now() });
  return value;
}

const STATUS_TTL_MS = 5_000;

export interface SingleFlightCache<T> {
  get: (load: () => Promise<T>) => Promise<T>;
  reset: () => void;
}

export function createSingleFlightCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
): SingleFlightCache<T> {
  let cached: { value: T; fetchedAt: number } | null = null;
  let inFlight: Promise<T> | null = null;
  return {
    get(load) {
      const current = now();
      if (cached && current - cached.fetchedAt < ttlMs) return Promise.resolve(cached.value);
      if (inFlight) return inFlight;
      let loaded: Promise<T>;
      try {
        loaded = load();
      } catch (error) {
        return Promise.reject(error);
      }
      inFlight = loaded.then((value) => {
        cached = { value, fetchedAt: now() };
        return value;
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    reset() {
      cached = null;
      inFlight = null;
    },
  };
}

/** Scope cached work to the resource owner. API tests and embedded nodes can
 * host several independent database connections in one process; returning one
 * connection's readiness for another would be a cross-instance state leak. */
export function createOwnedSingleFlightCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
): {
  get: (owner: object, load: () => Promise<T>) => Promise<T>;
  reset: () => void;
} {
  let owners = new WeakMap<object, SingleFlightCache<T>>();
  return {
    get(owner, load) {
      let cache = owners.get(owner);
      if (!cache) {
        cache = createSingleFlightCache<T>(ttlMs, now);
        owners.set(owner, cache);
      }
      return cache.get(load);
    },
    reset() {
      owners = new WeakMap();
    },
  };
}

type StatusResponse = Awaited<ReturnType<typeof computeSyncStatus>>;
const statusResponseCache = createOwnedSingleFlightCache<StatusResponse>(STATUS_TTL_MS);

type AsyncTask<T> = () => Promise<T>;

/** pg.Client currently queues overlapping queries but pg@8.21 deprecates that
 * behavior and pg@9 removes it. Health receives one connection, so preserve
 * query ordering explicitly instead of depending on that implicit queue. */
export async function runSequentially<
  const Tasks extends readonly AsyncTask<unknown>[],
>(tasks: Tasks): Promise<{
  -readonly [Index in keyof Tasks]: Tasks[Index] extends AsyncTask<infer Value>
    ? Value
    : never;
}> {
  const values: unknown[] = [];
  for (const task of tasks) values.push(await task());
  return values as any;
}

async function computeSyncStatus(dbConn: any) {
  const tips = Promise.all([fetchMidnightTip(), fetchCelestiaTip()]);
  // If a DB query fails before tips are consumed, their late failure must not
  // become an unhandled rejection. The original promise is still awaited on
  // the successful path, so tip failures remain fail-closed.
  void tips.catch(() => undefined);
  const [ntpRows, ntpCfgRows, pageRows, blockRows, setStats, lastOfferRows, rejections] =
    await runSequentially([
      () => getNtpCurrentBlock.run(undefined, dbConn),
      () => getNtpConfigSnapshot.run(undefined, dbConn),
      () => getSyncProtocolPagination.run(undefined, dbConn),
      () => getLatestEffectstreamBlock.run(undefined, dbConn),
      () => fetchSetStats(dbConn),
      () => getLastOffer.run(undefined, dbConn),
      () => getRecentRejections.run({ limit: 20 }, dbConn),
    ] as const);
  const [midnightTip, celestiaTip] = await tips;
  const nullifierRows = [setStats.nullifiers].filter(Boolean);
  const rootRows = [setStats.roots].filter(Boolean);
  const unshieldedRows = [setStats.unshielded].filter(Boolean);

  const ntpCurrent = Number(ntpRows[0]?.current ?? 0);
  // Tip from the protocol's ACTUAL anchor (config snapshot), not env: the
  // dev orchestrator anchors NTP at launch with 1 s blocks, and computing
  // the tip from the Preview-genesis env defaults reported a machine at tip
  // as ~130 days behind (perpetual "syncing" — which the frontend gates on).
  const ntpStartMs = Number(ntpCfgRows[0]?.start_time ?? NTP_START_TIME);
  const ntpBlockMs = Number(ntpCfgRows[0]?.block_time_ms ?? BLOCK_TIME_MS);
  const ntpTip = Math.floor((Date.now() - ntpStartMs) / ntpBlockMs);

  const pages: Record<string, { merged: number; fetched: number }> = {};
  for (const row of pageRows) {
    pages[row.protocol_name] = { merged: Number(row.merged), fetched: Number(row.fetched) };
  }

  const mn = pages["parallelMidnight"];
  const ce = pages["parallelCelestia"];

  const lagSeconds = Math.max(0, (ntpTip - ntpCurrent) * ntpBlockMs / 1000);

  const toHex = (v: unknown) =>
    v != null ? Buffer.from(v as Buffer).toString("hex") : null;
  const latestBlock = blockRows[0] ?? null;
  const lastOffer   = lastOfferRows[0] ?? null;

  return {
    ts: Date.now(),
    now: new Date().toISOString(),
    status: deriveSyncStatus({
      ntpCurrent,
      ntpLagSeconds: lagSeconds,
      ntpBlockMs,
      midnightCurrent: mn?.merged ?? null,
      midnightTip,
      celestiaCurrent: ce?.merged ?? null,
      celestiaTip,
    }),
    blockL2: latestBlock
      ? {
          height: latestBlock.block_height,
          timestamp: latestBlock.ms_timestamp,
          block_hash: toHex(latestBlock.effectstream_block_hash),
          main_chain_block_hash: toHex(latestBlock.main_chain_block_hash),
          block_time: ntpBlockMs,
          lag: Math.max(0, ntpTip - ntpCurrent),
        }
      : null,
    ntp: {
      current: ntpCurrent,
      tip: ntpTip,
      pct: pct(ntpCurrent, ntpTip),
      lag_blocks: Math.max(0, ntpTip - ntpCurrent),
      lag_seconds: lagSeconds,
    },
    midnight: {
      current: mn?.merged ?? null,
      fetched: mn?.fetched ?? null,
      tip: midnightTip,
      lag_blocks: mn && midnightTip != null ? Math.max(0, midnightTip - mn.merged) : null,
      pct: mn ? pct(mn.merged, midnightTip) : null,
    },
    celestia: {
      current: ce?.merged ?? null,
      fetched: ce?.fetched ?? null,
      tip: celestiaTip,
      lag_blocks: ce && celestiaTip != null ? Math.max(0, celestiaTip - ce.merged) : null,
      pct: ce ? pct(ce.merged, celestiaTip) : null,
    },
    sets: {
      nullifiers: {
        total: nullifierRows[0]?.total ?? 0,
        latest_height: nullifierRows[0]?.latest_height ?? null,
      },
      known_roots: {
        total: rootRows[0]?.total ?? 0,
        latest_height: rootRows[0]?.latest_height ?? null,
      },
      unshielded_utxos: {
        total: unshieldedRows[0]?.total ?? 0,
        latest_height: unshieldedRows[0]?.latest_height ?? null,
      },
      last_zswap: lastOffer
        ? {
            id: lastOffer.id,
            celestia_height: lastOffer.celestia_height,
            created_at: lastOffer.created_at,
          }
        : null,
    },
    // Blobs the ingestion ladder discarded, aggregated per (height, code).
    // The bodies are deleted; this is what makes namespace spam visible.
    recent_rejections: rejections.map((r) => ({
      celestia_height: r.celestia_height,
      code: r.code,
      count: r.count,
    })),
  };
}

/** Whole-response cache + single-flight. Health routes are deliberately
 * rate-limit-exempt; one polling burst must therefore fan into one bounded
 * batch of DB/external work rather than one batch per caller. */
export async function getSyncStatus(dbConn: any) {
  return statusResponseCache.get(dbConn as object, () => computeSyncStatus(dbConn));
}

export function resetSyncHealthCacheForTest(): void {
  statusResponseCache.reset();
  setStatsCaches = new WeakMap();
  for (const key of Object.keys(tipCache)) delete tipCache[key];
}
