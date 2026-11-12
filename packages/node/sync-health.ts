// Per-protocol sync state for /v1/health/sync, and the damped verdict of
// /v1/health.
//
// NTP current block is read from effectstream.effectstream_blocks (exact).
// Parallel chain positions come from effectstream.sync_protocol_pagination:
//   MIN(page_number) = last merged native block (preserved as cursor by the merger)
//   MAX(page_number) = latest prefetched native block (furthest ahead in buffer)
// Chain tips (height and block time) are fetched externally and cached for
// 60 s to limit outbound calls.
//
// Two verdicts come out of one sample:
//   * the per-sample verdict: known positions and tips, NTP lag and tip
//     freshness, judged on this sample alone. /v1/health/sync reports it,
//     and offer validation refuses on it, so a node that is behind fails
//     closed at once.
//   * the published verdict of /v1/health: the per-sample verdict damped by
//     hysteresis, so one slow upstream read does not flip `ok`. It changes
//     only after SYNC_HEALTH_HYSTERESIS_SAMPLES consecutive samples disagree
//     with it. A sample is one read of the chain tips (tips are cached 60 s),
//     so the count does not depend on how often clients poll. The state lives
//     in memory: after a restart the first sample is published as is.

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { BLOCK_TIME_MS, CELESTIA_RPC_URL, NTP_START_TIME } from "./env.ts";
import {
  DEFAULT_SYNC_HEALTH_CONFIG,
  syncHealthConfigOrThrow,
  type SyncHealthConfig,
} from "./sync-health-config.ts";
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

export type SyncStatus = "ok" | "syncing" | "error";

/** A chain tip as one source reported it. */
export interface TipObservation {
  height: number | null;
  /** The tip block's time in ms since the epoch; null when the source gave none. */
  timeMs: number | null;
}

const NO_TIP: TipObservation = Object.freeze({ height: null, timeMs: null });

const TIP_TTL_MS = 60_000;
const TIP_TIMEOUT_MS = 5_000;

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

// Earliest value accepted as a millisecond timestamp (2001-09-09). A smaller
// number is most likely seconds; reading it as milliseconds would make the
// tip look decades old, so it is reported as unknown instead.
const MIN_PLAUSIBLE_MS = 1_000_000_000_000;

/** A block time from a tip response: a millisecond number (Midnight indexer)
 * or an RFC 3339 string (Celestia header). Anything else is unknown. */
export function parseTipTimeMs(value: unknown): number | null {
  let ms: number;
  if (typeof value === "number") ms = value;
  else if (typeof value === "string" && /^[0-9]+$/.test(value)) ms = Number(value);
  else if (typeof value === "string" && value !== "") ms = Date.parse(value);
  else return null;
  return Number.isSafeInteger(Math.trunc(ms)) && ms >= MIN_PLAUSIBLE_MS ? Math.trunc(ms) : null;
}

/** `query { block { height timestamp } }` answered by the Midnight indexer. */
export function parseMidnightTip(json: any): TipObservation {
  const h = json?.data?.block?.height;
  return {
    height: typeof h === "number" ? h : null,
    timeMs: parseTipTimeMs(json?.data?.block?.timestamp),
  };
}

/** `header.NetworkHead` answered by a Celestia node. */
export function parseCelestiaTip(json: any): TipObservation {
  const h = parseInt(json?.result?.header?.height, 10);
  return {
    height: Number.isFinite(h) ? h : null,
    timeMs: parseTipTimeMs(json?.result?.header?.time),
  };
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
  /** Block time of each tip in ms; null or absent means unknown. */
  midnightTipTimeMs?: number | null;
  celestiaTipTimeMs?: number | null;
  /** Wall-clock for the freshness rule; Date.now() when absent. */
  nowMs?: number;
}

// How far a parallel chain trails its tip is not judged by a block count.
// The node applies Midnight and Celestia blocks once per NTP block, and only
// after each chain has delivered blocks past that NTP block's end time, so
// between two NTP blocks the applied positions stand still while the tips move
// on: with BLOCK_TIME_MS = 600000 and ~6 s chain blocks they trail by up to
// ~100 blocks on a node that is current. A chain that stops delivering holds
// back the next NTP block instead, which the NTP-lag rule reports; a chain
// whose tip stops moving is caught by the tip-age rule, and an unknown
// position or tip is never `ok`. `current` and `lag_blocks` in
// /v1/health/sync remain diagnostics.

export type SyncSource = "ntp" | "midnight" | "celestia" | "node";

/** Why a sample is not `ok`. Numbers are in the unit their name says. */
export interface SyncReason {
  source: SyncSource;
  rule: "no_finalized_block" | "position_unknown" | "tip_unknown" | "lag" | "stale" | "state_unreadable";
  message: string;
  lag_seconds?: number;
  max_lag_seconds?: number;
  age_seconds?: number;
  max_age_seconds?: number;
}

/** How old a source's tip is, judged against wall-clock. */
export interface SourceFreshness {
  state: "fresh" | "stale" | "unknown";
  tip_height: number | null;
  tip_time: string | null;
  age_seconds: number | null;
  max_age_seconds: number;
}

export interface SyncVerdict {
  status: SyncStatus;
  reasons: SyncReason[];
  freshness: { midnight: SourceFreshness; celestia: SourceFreshness };
}

const knownHeight = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

function freshnessOf(
  tip: number | null,
  timeMs: number | null | undefined,
  nowMs: number,
  maxAgeSeconds: number,
): SourceFreshness {
  if (timeMs === null || timeMs === undefined || !Number.isFinite(timeMs)) {
    return { state: "unknown", tip_height: tip, tip_time: null, age_seconds: null, max_age_seconds: maxAgeSeconds };
  }
  // A tip time slightly ahead of this host's clock is skew, not age.
  const ageSeconds = Math.max(0, Math.round((nowMs - timeMs) / 1000));
  return {
    state: ageSeconds > maxAgeSeconds ? "stale" : "fresh",
    tip_height: tip,
    tip_time: new Date(timeMs).toISOString(),
    age_seconds: ageSeconds,
    max_age_seconds: maxAgeSeconds,
  };
}

/** The per-sample verdict with every reason it is not `ok`. `error` means no
 * NTP block has finalized; every other failed rule is `syncing`. */
export function evaluateSyncVerdict(
  input: ReadinessInput,
  thresholds: SyncHealthConfig = DEFAULT_SYNC_HEALTH_CONFIG,
): SyncVerdict {
  const {
    ntpCurrent,
    ntpLagSeconds,
    ntpBlockMs,
    midnightCurrent,
    midnightTip,
    celestiaCurrent,
    celestiaTip,
  } = input;
  const nowMs = input.nowMs ?? Date.now();
  const reasons: SyncReason[] = [];
  const freshness = {
    midnight: freshnessOf(midnightTip, input.midnightTipTimeMs, nowMs, thresholds.maxMidnightTipAgeSeconds),
    celestia: freshnessOf(celestiaTip, input.celestiaTipTimeMs, nowMs, thresholds.maxCelestiaTipAgeSeconds),
  };

  if (!Number.isFinite(ntpCurrent) || ntpCurrent <= 0 ||
      !Number.isFinite(ntpBlockMs) || ntpBlockMs <= 0 ||
      !Number.isFinite(ntpLagSeconds) || ntpLagSeconds < 0) {
    reasons.push({
      source: "ntp",
      rule: "no_finalized_block",
      message: "no NTP block has finalized yet (or the NTP block time is not known)",
    });
    return { status: "error", reasons, freshness };
  }

  const maxNtpLagSeconds = ntpBlockMs * thresholds.maxNtpLagBlocks / 1000;
  if (ntpLagSeconds > maxNtpLagSeconds) {
    reasons.push({
      source: "ntp",
      rule: "lag",
      message: `NTP is ${ntpLagSeconds} s behind wall-clock (limit ${maxNtpLagSeconds} s)`,
      lag_seconds: ntpLagSeconds,
      max_lag_seconds: maxNtpLagSeconds,
    });
  }

  const chains = [
    ["midnight", midnightCurrent, midnightTip],
    ["celestia", celestiaCurrent, celestiaTip],
  ] as const;
  for (const [source, current, tip] of chains) {
    if (!knownHeight(current)) {
      reasons.push({ source, rule: "position_unknown", message: `the node's ${source} position is unknown` });
    }
    if (!knownHeight(tip)) {
      reasons.push({ source, rule: "tip_unknown", message: `the ${source} tip could not be read` });
    }
    const fresh = freshness[source];
    if (fresh.state === "stale") {
      reasons.push({
        source,
        rule: "stale",
        message: `the ${source} tip (height ${fresh.tip_height}) is ${fresh.age_seconds} s old (limit ${fresh.max_age_seconds} s)`,
        age_seconds: fresh.age_seconds ?? undefined,
        max_age_seconds: fresh.max_age_seconds,
      });
    }
  }

  return { status: reasons.length === 0 ? "ok" : "syncing", reasons, freshness };
}

export function deriveSyncStatus(
  input: ReadinessInput,
  thresholds: SyncHealthConfig = DEFAULT_SYNC_HEALTH_CONFIG,
): SyncStatus {
  return evaluateSyncVerdict(input, thresholds).status;
}

export interface DampedVerdict {
  status: SyncStatus;
  /** Consecutive samples, up to and including the latest, that disagree with `status`. */
  disagreeingSamples: number;
}

export interface VerdictDamper {
  /** Record the per-sample verdict of sample `sampleKey`; observing a key
   * again replaces that sample instead of counting it twice. */
  observe(raw: SyncStatus, sampleKey: string): DampedVerdict;
  current(): DampedVerdict | null;
}

/** Hysteresis: the published verdict changes only after `samplesToChange`
 * consecutive samples disagree with it. The first sample is published as is. */
export function createVerdictDamper(samplesToChange: number): VerdictDamper {
  if (!Number.isSafeInteger(samplesToChange) || samplesToChange < 1) {
    throw new Error(`hysteresis needs a positive integer sample count, got ${samplesToChange}`);
  }
  let published: SyncStatus | null = null;
  let streak = 0;
  let streakBeforeLatest = 0;
  let latestKey: string | null = null;
  return {
    observe(raw, sampleKey) {
      if (published === null) {
        published = raw;
        latestKey = sampleKey;
        streak = 0;
        streakBeforeLatest = 0;
        return { status: published, disagreeingSamples: 0 };
      }
      if (sampleKey !== latestKey) {
        streakBeforeLatest = streak;
        latestKey = sampleKey;
      }
      streak = raw === published ? 0 : streakBeforeLatest + 1;
      if (streak >= samplesToChange) {
        published = raw;
        streak = 0;
        streakBeforeLatest = 0;
      }
      return { status: published, disagreeingSamples: streak };
    },
    current() {
      return published === null ? null : { status: published, disagreeingSamples: streak };
    },
  };
}

// The set-size stats are COUNT(*) + MAX(height) over append-only tables
// (created_unshielded grows from genesis forever, nullifiers with every
// spend). /v1/health/sync is rate-limit-exempt and polled by UIs as a
// liveness probe, so these scans must not run per request — cache them.
// 15 s staleness is irrelevant for totals that only ever grow.
const SET_STATS_TTL_MS = 15_000;
type SetStats = { nullifiers: any; roots: any; unshielded: any };

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

/** The `/v1/health` body. `status` / `synced` keep their meaning for existing
 * readers; the rest says why. */
export interface HealthVerdict {
  status: SyncStatus;
  synced: boolean;
  /** The latest sample's own verdict, before hysteresis. */
  raw_status: SyncStatus;
  /** Why `raw_status` is not `ok`; empty when it is. */
  reasons: SyncReason[];
  freshness: { midnight: SourceFreshness; celestia: SourceFreshness } | null;
  hysteresis: { samples_to_change: number; disagreeing_samples: number };
}

export interface SyncHealthDeps {
  config: SyncHealthConfig;
  midnightIndexerUrl: string;
  celestiaRpcUrl: string;
  /** NTP anchor and block time used when the runtime's config snapshot has none. */
  ntpStartTimeMs: number;
  ntpBlockTimeMs: number;
  /** Defaults to the global fetch, looked up per call. */
  fetchImpl?: typeof fetch;
  /** Defaults to Date.now. */
  now?: () => number;
}

interface CachedTip {
  value: TipObservation;
  fetchedAt: number;
  /** Increments on every read that reached the source: one sample each. */
  round: number;
}

export function createSyncHealth(deps: SyncHealthDeps) {
  const now = deps.now ?? Date.now;
  const fetchImpl = (): typeof fetch => deps.fetchImpl ?? fetch;
  let tipCache: Record<string, CachedTip> = {};
  let rounds = 0;
  let setStatsCaches = new WeakMap<object, { value: SetStats; fetchedAt: number }>();
  let dampers = new WeakMap<object, VerdictDamper>();

  async function cachedTip(key: string, load: () => Promise<TipObservation>): Promise<CachedTip> {
    const hit = tipCache[key];
    if (hit && now() - hit.fetchedAt < TIP_TTL_MS) return hit;
    let value: TipObservation = NO_TIP;
    try { value = await load(); } catch { /* leave unknown */ }
    const entry = { value, fetchedAt: now(), round: ++rounds };
    tipCache[key] = entry;
    return entry;
  }

  async function readTip(
    key: string,
    load: () => Promise<TipObservation>,
    fresh: boolean,
  ): Promise<CachedTip> {
    if (!fresh) return cachedTip(key, load);
    let value: TipObservation = NO_TIP;
    try { value = await load(); } catch { /* leave unknown */ }
    return { value, fetchedAt: now(), round: -1 };
  }

  const loadMidnightTip = async () =>
    parseMidnightTip(await fetchJsonWithDeadline(fetchImpl(), deps.midnightIndexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { block { height timestamp } }" }),
    }));

  const loadCelestiaTip = async () => {
    // Same bearer the DA write path sends. Without it, an auth-enabled
    // Celestia node answers 401, the tip reads as unknown forever, and every
    // consumer that gates on currentness sees a caught-up node as "syncing".
    const token = process.env["CELESTIA_AUTH_TOKEN"] ?? "";
    return parseCelestiaTip(await fetchJsonWithDeadline(fetchImpl(), deps.celestiaRpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "header.NetworkHead", params: [], id: 1 }),
    }));
  };

  async function fetchSetStats(dbConn: any): Promise<SetStats> {
    const cacheKey = dbConn as object;
    const cached = setStatsCaches.get(cacheKey);
    if (cached && now() - cached.fetchedAt < SET_STATS_TTL_MS) {
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
    setStatsCaches.set(cacheKey, { value, fetchedAt: now() });
    return value;
  }

  async function computeSample(dbConn: any, freshTips: boolean) {
    const tips = Promise.all([
      readTip("midnight", loadMidnightTip, freshTips),
      readTip("celestia", loadCelestiaTip, freshTips),
    ]);
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
    const [midnightRead, celestiaRead] = await tips;
    const midnightTip = midnightRead.value.height;
    const celestiaTip = celestiaRead.value.height;
    const nullifierRows = [setStats.nullifiers].filter(Boolean);
    const rootRows = [setStats.roots].filter(Boolean);
    const unshieldedRows = [setStats.unshielded].filter(Boolean);
    const nowMs = now();

    const ntpCurrent = Number(ntpRows[0]?.current ?? 0);
    // Tip from the protocol's ACTUAL anchor (config snapshot), not env: the
    // dev orchestrator anchors NTP at launch with 1 s blocks, and computing
    // the tip from the env defaults would report a node at its tip as months
    // behind (perpetual "syncing").
    const ntpStartMs = Number(ntpCfgRows[0]?.start_time ?? deps.ntpStartTimeMs);
    const ntpBlockMs = Number(ntpCfgRows[0]?.block_time_ms ?? deps.ntpBlockTimeMs);
    const ntpTip = Math.floor((nowMs - ntpStartMs) / ntpBlockMs);

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

    const verdict = evaluateSyncVerdict({
      ntpCurrent,
      ntpLagSeconds: lagSeconds,
      ntpBlockMs,
      midnightCurrent: mn?.merged ?? null,
      midnightTip,
      celestiaCurrent: ce?.merged ?? null,
      celestiaTip,
      midnightTipTimeMs: midnightRead.value.timeMs,
      celestiaTipTimeMs: celestiaRead.value.timeMs,
      nowMs,
    }, deps.config);

    // The grammar of this object is a client contract (strict parsers reject
    // unknown keys): add new diagnostics to the /v1/health body instead.
    const response = {
      ts: nowMs,
      now: new Date(nowMs).toISOString(),
      status: verdict.status,
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
    return {
      response,
      verdict,
      sampleKey: `${midnightRead.round}:${celestiaRead.round}`,
    };
  }

  type Sample = Awaited<ReturnType<typeof computeSample>> & { published: DampedVerdict };

  function damperFor(dbConn: any): VerdictDamper {
    const owner = dbConn as object;
    let damper = dampers.get(owner);
    if (!damper) {
      damper = createVerdictDamper(deps.config.hysteresisSamples);
      dampers.set(owner, damper);
    }
    return damper;
  }

  // Every cached sample feeds the damper once it is computed, whichever route
  // asked for it, so the published verdict follows the tip reads even when
  // only /v1/health/sync is polled.
  const sampleCache = createOwnedSingleFlightCache<Sample>(STATUS_TTL_MS, now);
  const cachedSample = (dbConn: any) =>
    sampleCache.get(dbConn as object, async () => {
      const sample = await computeSample(dbConn, false);
      return { ...sample, published: damperFor(dbConn).observe(sample.verdict.status, sample.sampleKey) };
    });

  return {
    /** Whole-response cache + single-flight. Health routes are deliberately
     * rate-limit-exempt; one polling burst must therefore fan into one bounded
     * batch of DB/external work rather than one batch per caller. */
    async getSyncStatus(dbConn: any) {
      return (await cachedSample(dbConn)).response;
    },

    /** Validation runs this after proof verification. Unlike the public health
     * cache, it re-reads both external chain tips so a tip that became
     * unreadable or stale during proof work cannot be hidden behind a
     * previously healthy cached response. It is not a sample of the published
     * verdict. */
    async getFreshSyncStatus(dbConn: any) {
      return (await computeSample(dbConn, true)).response;
    },

    /** The `/v1/health` body: the damped verdict plus the latest sample's own
     * verdict, its reasons and the freshness of both tips. */
    async getHealthVerdict(dbConn: any): Promise<HealthVerdict> {
      const samplesToChange = deps.config.hysteresisSamples;
      try {
        const sample = await cachedSample(dbConn);
        return {
          status: sample.published.status,
          synced: sample.published.status === "ok",
          raw_status: sample.verdict.status,
          reasons: sample.verdict.reasons,
          freshness: sample.verdict.freshness,
          hysteresis: {
            samples_to_change: samplesToChange,
            disagreeing_samples: sample.published.disagreeingSamples,
          },
        };
      } catch {
        // An unreadable sync state is not a chain sample: report it at once.
        return {
          status: "error",
          synced: false,
          raw_status: "error",
          reasons: [{ source: "node", rule: "state_unreadable", message: "the node's sync state could not be read" }],
          freshness: null,
          hysteresis: {
            samples_to_change: samplesToChange,
            disagreeing_samples: damperFor(dbConn).current()?.disagreeingSamples ?? 0,
          },
        };
      }
    },

    reset(): void {
      sampleCache.reset();
      setStatsCaches = new WeakMap();
      dampers = new WeakMap();
      tipCache = {};
    },
  };
}

export type SyncHealth = ReturnType<typeof createSyncHealth>;

const syncHealth = createSyncHealth({
  config: syncHealthConfigOrThrow(process.env),
  midnightIndexerUrl: midnightNetworkConfig.indexer,
  celestiaRpcUrl: CELESTIA_RPC_URL,
  ntpStartTimeMs: NTP_START_TIME,
  ntpBlockTimeMs: BLOCK_TIME_MS,
});

export function getSyncStatus(dbConn: any) {
  return syncHealth.getSyncStatus(dbConn);
}

export function getFreshSyncStatus(dbConn: any) {
  return syncHealth.getFreshSyncStatus(dbConn);
}

export function getHealthVerdict(dbConn: any): Promise<HealthVerdict> {
  return syncHealth.getHealthVerdict(dbConn);
}

export function resetSyncHealthCacheForTest(): void {
  syncHealth.reset();
}
