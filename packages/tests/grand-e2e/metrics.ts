// Metric collectors + baseline enforcement (HANDOFF §7 "Metrics to collect").
//
// First full run = calibration: metrics.json is written, baseline.json is NOT
// enforced (it ships as {} until a calibrated baseline is committed). Once
// baseline.json carries numbers, each metric is enforced at baseline × 1.2.

import { readFileSync } from "node:fs";
import { apiTimings, getHealthSync, realNtpLagSeconds } from "./lib/api2.ts";
import { pgrepF, rssKb, summarizeLatencies, writeOut } from "./lib/util.ts";

export interface MetricsSnapshot {
  submit: { count: number; p50: number; p95: number; max: number };
  publishToIndexedMs: { count: number; p50: number; p95: number; max: number };
  stmLag: { samples: number; maxLagBlocks: number; lastLagBlocks: number };
  sseDeliveryLagMs: { count: number; p50: number; p95: number; max: number };
  bookReadMs: { count: number; p50: number; p95: number; max: number };
  batcherQueueDepthMax: number;
  rss: { syncStartKb: number; syncEndKb: number; indexerStartKb: number; indexerEndKb: number };
  dbSizeBytes: number | null;
  stormApiMs: { count: number; p50: number; p95: number; max: number };
}

export const submitLatencies: number[] = [];
export const publishToIndexed: number[] = [];
export const sseDeliveryLags: number[] = [];
export const bookReadLatencies: number[] = [];
export const stormApiLatencies: number[] = [];

const stmLagSamples: { at: number; lagBlocks: number }[] = [];
let batcherQueueDepthMax = 0;
let syncPid: number | null = null;
let indexerPid: number | null = null;
let syncStartKb = 0;
let indexerStartKb = 0;
let lagPollTimer: ReturnType<typeof setInterval> | null = null;

export async function initMetrics(): Promise<void> {
  syncPid = await pgrepF("packages/node/main.dev.ts");
  indexerPid = await pgrepF("midnight-indexer");
  syncStartKb = syncPid ? await rssKb(syncPid) : 0;
  indexerStartKb = indexerPid ? await rssKb(indexerPid) : 0;
  lagPollTimer = setInterval(() => void pollLag(), 30_000);
}

async function pollLag(): Promise<void> {
  const h = await getHealthSync();
  if (!h) return;
  // Real lag from blockL2.timestamp (1 s blocks ⇒ seconds ≈ blocks); the
  // endpoint's own ntp.tip is wrong on dev — see realNtpLagSeconds.
  const lag = realNtpLagSeconds(h);
  if (Number.isFinite(lag)) stmLagSamples.push({ at: Date.now(), lagBlocks: Math.round(lag) });
}

export function recordBatcherQueueDepth(depth: number): void {
  if (depth > batcherQueueDepthMax) batcherQueueDepthMax = depth;
}

export function getPids(): { syncPid: number | null; indexerPid: number | null } {
  return { syncPid, indexerPid };
}

/** Re-resolve pids after a chaos restart. */
export async function refreshPids(): Promise<void> {
  syncPid = await pgrepF("packages/node/main.dev.ts");
  indexerPid = await pgrepF("midnight-indexer");
}

export async function currentSyncRssKb(): Promise<number> {
  return syncPid ? await rssKb(syncPid) : 0;
}

export async function snapshot(db: { query: (q: string) => Promise<any> } | null): Promise<MetricsSnapshot> {
  if (lagPollTimer) clearInterval(lagPollTimer);
  await pollLag();
  let dbSizeBytes: number | null = null;
  try {
    const r = await db?.query("SELECT pg_database_size(current_database()) AS s");
    dbSizeBytes = r ? Number(r.rows[0]?.s) : null;
  } catch {
    dbSizeBytes = null; // pglite may not implement pg_database_size
  }
  return {
    submit: summarizeLatencies(submitLatencies),
    publishToIndexedMs: summarizeLatencies(publishToIndexed),
    stmLag: {
      samples: stmLagSamples.length,
      maxLagBlocks: Math.max(0, ...stmLagSamples.map((s) => s.lagBlocks)),
      lastLagBlocks: stmLagSamples[stmLagSamples.length - 1]?.lagBlocks ?? 0,
    },
    sseDeliveryLagMs: summarizeLatencies(sseDeliveryLags),
    bookReadMs: summarizeLatencies(bookReadLatencies),
    batcherQueueDepthMax,
    rss: {
      syncStartKb,
      syncEndKb: syncPid ? await rssKb(syncPid) : 0,
      indexerStartKb,
      indexerEndKb: indexerPid ? await rssKb(indexerPid) : 0,
    },
    dbSizeBytes,
    stormApiMs: summarizeLatencies(stormApiLatencies),
  };
}

export function writeMetrics(snap: MetricsSnapshot): void {
  writeOut(
    "metrics.json",
    JSON.stringify({ snap, stmLagSamples, apiTimingCount: apiTimings.length }, null, 2),
  );
}

// ── Baseline enforcement ─────────────────────────────────────────────────────

interface Baseline {
  submitP95Ms?: number;
  publishToIndexedP95Ms?: number;
  bookReadP95Ms?: number;
  sseDeliveryLagP95Ms?: number;
  maxStmLagBlocks?: number;
}

export function loadBaseline(): Baseline | null {
  try {
    const raw = readFileSync(new URL("./baseline.json", import.meta.url).pathname, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && Object.keys(parsed).length > 0 ? (parsed as Baseline) : null;
  } catch {
    return null;
  }
}

export function baselineViolations(snap: MetricsSnapshot, base: Baseline): string[] {
  const out: string[] = [];
  const checkOne = (name: string, actual: number, allowed: number | undefined) => {
    if (allowed === undefined) return;
    const limit = allowed * 1.2;
    if (actual > limit) out.push(`${name}: ${actual} > baseline ${allowed} × 1.2 = ${limit.toFixed(0)}`);
  };
  checkOne("submit p95 ms", snap.submit.p95, base.submitP95Ms);
  checkOne("publish→indexed p95 ms", snap.publishToIndexedMs.p95, base.publishToIndexedP95Ms);
  checkOne("book read p95 ms", snap.bookReadMs.p95, base.bookReadP95Ms);
  checkOne("SSE delivery lag p95 ms", snap.sseDeliveryLagMs.p95, base.sseDeliveryLagP95Ms);
  checkOne("max STM lag blocks", snap.stmLag.maxLagBlocks, base.maxStmLagBlocks);
  return out;
}
