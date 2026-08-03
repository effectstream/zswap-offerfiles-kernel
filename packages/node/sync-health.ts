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
const tipCache: Record<string, CachedTip> = {};

async function cachedFetch(key: string, fn: () => Promise<number | null>): Promise<number | null> {
  const hit = tipCache[key];
  if (hit && Date.now() - hit.fetchedAt < TIP_TTL_MS) return hit.value;
  let value: number | null = null;
  try { value = await fn(); } catch { /* leave null */ }
  tipCache[key] = { value, fetchedAt: Date.now() };
  return value;
}

async function fetchMidnightTip(): Promise<number | null> {
  return cachedFetch("midnight", async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      const res = await fetch(midnightNetworkConfig.indexer, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { block { height } }" }),
        signal: ac.signal,
      });
      const json = await res.json();
      const h = json?.data?.block?.height;
      return typeof h === "number" ? h : null;
    } finally {
      clearTimeout(t);
    }
  });
}

async function fetchCelestiaTip(): Promise<number | null> {
  return cachedFetch("celestia", async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      const res = await fetch(CELESTIA_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "header.NetworkHead", params: [], id: 1 }),
        signal: ac.signal,
      });
      const json = await res.json();
      const h = parseInt(json?.result?.header?.height, 10);
      return Number.isFinite(h) ? h : null;
    } finally {
      clearTimeout(t);
    }
  });
}

function pct(current: number, tip: number | null): number | null {
  if (tip == null || tip <= 0) return null;
  const p = Math.round((current / tip) * 1000) / 10;
  // Never show 100 when there are still blocks to process.
  return current < tip ? Math.min(p, 99.9) : p;
}

// "ok"      — within 2 NTP blocks (≤ 20 min behind), serving live data.
// "syncing" — catching up; historical data only until lag clears.
// "error"   — no blocks finalized yet (migrations pending or node crash).
function deriveStatus(ntpCurrent: number, lagSeconds: number): "ok" | "syncing" | "error" {
  if (ntpCurrent === 0) return "error";
  if (lagSeconds > BLOCK_TIME_MS * 2 / 1000) return "syncing"; // > 2 blocks
  return "ok";
}

// The set-size stats are COUNT(*) + MAX(height) over append-only tables
// (created_unshielded grows from genesis forever, nullifiers with every
// spend). /api/health/sync is rate-limit-exempt and polled by UIs as a
// liveness probe, so these scans must not run per request — cache them.
// 15 s staleness is irrelevant for totals that only ever grow.
const SET_STATS_TTL_MS = 15_000;
type SetStats = { nullifiers: any; roots: any; unshielded: any };
let setStatsCache: { value: SetStats; fetchedAt: number } | null = null;

async function fetchSetStats(dbConn: any): Promise<SetStats> {
  if (setStatsCache && Date.now() - setStatsCache.fetchedAt < SET_STATS_TTL_MS) {
    return setStatsCache.value;
  }
  const [nullifierRows, rootRows, unshieldedRows] = await Promise.all([
    getNullifierStats.run(undefined, dbConn),
    getKnownRootStats.run(undefined, dbConn),
    getUnshieldedStats.run(undefined, dbConn),
  ]);
  const value = {
    nullifiers: nullifierRows[0] ?? null,
    roots: rootRows[0] ?? null,
    unshielded: unshieldedRows[0] ?? null,
  };
  setStatsCache = { value, fetchedAt: Date.now() };
  return value;
}

export async function getSyncStatus(dbConn: any) {
  const [ntpRows, ntpCfgRows, pageRows, blockRows, setStats, lastOfferRows, rejections, midnightTip, celestiaTip] = await Promise.all([
    getNtpCurrentBlock.run(undefined, dbConn),
    getNtpConfigSnapshot.run(undefined, dbConn),
    getSyncProtocolPagination.run(undefined, dbConn),
    getLatestEffectstreamBlock.run(undefined, dbConn),
    fetchSetStats(dbConn),
    getLastOffer.run(undefined, dbConn),
    getRecentRejections.run({ limit: 20 }, dbConn),
    fetchMidnightTip(),
    fetchCelestiaTip(),
  ]);
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
    status: deriveStatus(ntpCurrent, lagSeconds),
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
