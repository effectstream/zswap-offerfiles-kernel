// The baseline gate must be able to fail HONESTLY — that is, fail on a real
// regression and pass on a lucky outlier. It could not.
//
// bookReadMs collects 10 samples, so its "p95" is the max. One 42 ms read
// against a median of 7 ms failed the 2026-08-07 run while every other number
// was healthy. That was the THIRD time the gate fired for that reason
// (baseline.json's note records it being raised 10 -> 20 after a 19 ms read,
// median unmoved), and each previous response was to raise the threshold — which
// is the "widen it until it passes" move this project refuses for index-wait
// timeouts. A gate relaxed whenever it fires measures nothing.
//
// The two cases below are the whole point: today's outlier must PASS and a
// genuine median shift must FAIL. Before this change BOTH failed, which is
// exactly the defect — the gate could not tell them apart.
import { expect, test } from "bun:test";

const { baselineViolations, summarizeStmLag, beginChaosWindow, endChaosWindow, getChaosWindows } =
  await import("./metrics.ts");

/** A snapshot whose every other metric is comfortably inside baseline. */
function snapWith(bookRead: { count: number; p50: number; p95: number }) {
  return {
    submit: { count: 29, p50: 2627, p95: 6000, max: 7295 },
    publishToIndexedMs: { count: 33, p50: 17606, p95: 22000, max: 23176 },
    stmLag: {
      samples: 115,
      excludedSamples: 0,
      maxLagBlocks: 90,
      maxLagBlocksIncludingChaos: 90,
      lastLagBlocks: 2,
      recoveries: [],
    },
    sseDeliveryLagMs: { count: 21, p50: 1830, p95: 2308, max: 2785 },
    bookReadMs: { ...bookRead, max: bookRead.p95 },
    batcherQueueDepthMax: 1,
    rss: { syncStartKb: 1, syncEndKb: 1, indexerStartKb: 1, indexerEndKb: 1 },
    dbSizeBytes: 1,
    stormApiMs: { count: 200, p50: 6, p95: 103, max: 377 },
  } as any;
}

const BASE = {
  submitP50Ms: 3619,
  submitP95Ms: 12167,
  publishToIndexedP95Ms: 27183,
  bookReadP50Ms: 8,
  bookReadP95Ms: 20,
  sseDeliveryLagP50Ms: 2254,
  sseDeliveryLagP95Ms: 10008,
  maxStmLagBlocks: 95,
  recoveryLagBlocks: 10,
};

test("a tail outlier at 10 samples is reported, not enforced", () => {
  // The exact numbers from the 2026-08-07 run.
  const { violations, notes } = baselineViolations(snapWith({ count: 10, p50: 7, p95: 42 }), BASE);
  expect(violations).toEqual([]);
  expect(notes.join(" ")).toContain("book read p95 ms");
  expect(notes.join(" ")).toContain("only 10 samples");
});

test("a genuine median shift still FAILS at the same sample count", () => {
  // Same 10 samples, but the median moved 7 -> 30. This is the case the old
  // gate could not distinguish from the one above.
  const { violations } = baselineViolations(snapWith({ count: 10, p50: 30, p95: 45 }), BASE);
  expect(violations.join(" ")).toContain("book read p50 ms");
});

test("the tail IS enforced once there are enough samples", () => {
  // Same p95 that was excused at count=10; at 200 it is a real percentile.
  const { violations, notes } = baselineViolations(snapWith({ count: 200, p50: 7, p95: 42 }), BASE);
  expect(violations.join(" ")).toContain("book read p95 ms");
  expect(notes).toEqual([]);
});

test("a deliberately slowed submit path still fails the median gate", () => {
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  const slowedP50 = BASE.submitP50Ms * 2;
  snap.submit = { count: 60, p50: slowedP50, p95: slowedP50 * 1.5, max: slowedP50 * 2 };
  const { violations } = baselineViolations(snap, BASE);
  expect(violations.join(" ")).toContain("submit p50 ms");
});

test("the five-slot calibration sample passes without baked-in headroom", () => {
  const snap = snapWith({ count: 10, p50: 9, p95: 12 });
  snap.submit = { count: 58, p50: 3619, p95: 12167, max: 14478 };
  snap.publishToIndexedMs = { count: 63, p50: 18635, p95: 27183, max: 29535 };
  snap.sseDeliveryLagMs = { count: 38, p50: 2254, p95: 10008, max: 10008 };
  snap.stmLag = { samples: 146, maxLagBlocks: 59, lastLagBlocks: 0 };
  const verdict = baselineViolations(snap, BASE);
  expect(verdict).toEqual({ violations: [], notes: [] });
});

test("an out-of-band SSE median fails once its baseline keys are present", () => {
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.sseDeliveryLagMs = { count: 21, p50: 4000, p95: 4500, max: 5000 };
  const { violations } = baselineViolations(snap, BASE);
  expect(violations.join(" ")).toContain("SSE delivery lag p50 ms");
});

test("a run beyond the STM validity envelope still fails the lag gate", () => {
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.stmLag = { samples: 146, maxLagBlocks: 151, lastLagBlocks: 151 };
  const { violations } = baselineViolations(snap, BASE);
  expect(violations.join(" ")).toContain("max STM lag blocks");
});

test("a healthy run produces neither violations nor notes", () => {
  const { violations, notes } = baselineViolations(snapWith({ count: 10, p50: 7, p95: 18 }), BASE);
  expect(violations).toEqual([]);
  expect(notes).toEqual([]);
});

test("absent baseline keys are not enforced (calibration runs stay green)", () => {
  // sseDeliveryLag* are deliberately absent from baseline.json until 2-3 clean
  // measurements exist; an absent key must never fail a run.
  const { violations } = baselineViolations(snapWith({ count: 10, p50: 7, p95: 18 }), {
    maxStmLagBlocks: 95,
  });
  expect(violations).toEqual([]);
});

test("the committed baseline carries every calibrated closeout key", async () => {
  // Guards the closeout end-to-end: absent keys are deliberately ignored, so
  // losing one would silently make its metric decorative.
  const base = (await import("./baseline.json")).default as Record<string, unknown>;
  expect(base["submitP50Ms"]).toBe(3619);
  expect(base["submitP95Ms"]).toBe(12167);
  expect(base["publishToIndexedP95Ms"]).toBe(27183);
  expect(base["sseDeliveryLagP50Ms"]).toBe(2254);
  expect(base["sseDeliveryLagP95Ms"]).toBe(10008);
  // 95, not a number chosen to fit a restart: ruling (c) excludes the chaos
  // window from the metric and FORBIDS recalibrating this baseline to absorb
  // one (that was the rejected option (d)). A future run that "fixes" a lag
  // failure by raising this number fails here first.
  expect(base["maxStmLagBlocks"]).toBe(95);
  expect(base["recoveryLagBlocks"]).toBe(10);
  expect(base["bookReadP50Ms"]).toBeLessThan(base["bookReadP95Ms"] as number);
});

// ── Chaos-window exclusion + recovery (ruling (c), 2026-08-18) ───────────────
//
// The series below is run 6's, verbatim from out/metrics.json at `dc08d17`:
// 146 samples, 30 s apart, median 1, p95 3, and exactly one excursion —
// 30/60/90/120 across four samples, then straight back down. 30 blocks per 30 s
// is the chain's own 1 block/s, i.e. the STM processed NOTHING and then absorbed
// the whole backlog inside one interval. Run 5 is the same curve at the same
// offset with the same peak; its post-window sample read 1 where run 6's read 2.
const RUN6_LAGS = [
  0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0,
  1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 3, 1, 0,
  1, 1, 1, 1, 2, 0, 2, 0, 1, 0, 0, 1, 1, 1, 2, 1, 2, 2, 1, 2,
  2, 1, 2, 2, 1, 1, 2, 2, 1, 4, 1, 4, 2, 2, 2, 1, 1, 2, 1, 1,
  2, 1, 1, 2, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 2,
  2, 1, 2, 1, 1, 2, 30, 60, 90, 120, 2, 2, 2, 1, 1, 1, 1, 2, 1, 1,
  2, 2, 1, 1, 1, 1, 1, 4, 2, 7, 1, 1, 1, 1, 1, 3, 1, 1, 2, 1,
  1, 1, 1, 1, 1, 1,
];

const SAMPLE_MS = 30_000;
const T0 = 1_755_000_000_000;
const seriesFrom = (lags: number[]) =>
  lags.map((lagBlocks, i) => ({ at: T0 + i * SAMPLE_MS, lagBlocks }));

// Runs 5/6 predate the markers, so this window is RECONSTRUCTED from run 6's
// stack.log rather than recorded: the sync process log went silent 13:34:00 and
// resumed 13:35:43, and chaosSync's exit poll runs every 5 s. Anchored to the
// series, the outage began one sample before the ramp (sample 106 already read
// 30 blocks, so the STM had stopped 30 s earlier) and the routine returned ~11 s
// before sample 109 — which is exactly why that sample still reads 120 despite
// the process being healthy, and why the deadline is endedAt + one interval.
const SYNC_WINDOW = {
  name: "sync",
  startedAt: T0 + 106 * SAMPLE_MS - 30_000,
  endedAt: T0 + 109 * SAMPLE_MS - 11_000,
};

test("chaos-window samples do not feed maxLagBlocks; the peak stays visible", () => {
  const s = summarizeStmLag(seriesFrom(RUN6_LAGS), [SYNC_WINDOW], SAMPLE_MS);
  expect(s.samples).toBe(146);
  // The 30/60/90/120 ramp plus the sample that lands on the window's opening
  // edge — chaosSync counts two tables before it issues the restart, so the
  // real mark precedes the outage by a second or two. Five of 146.
  expect(s.excludedSamples).toBe(5);
  expect(s.maxLagBlocks).toBe(7); // the largest sample the STM is answerable for
  expect(s.maxLagBlocksIncludingChaos).toBe(120); // not hidden, just not gated
  expect(s.recoveries).toEqual([
    { name: "sync", endedAt: SYNC_WINDOW.endedAt, at: T0 + 110 * SAMPLE_MS, lagBlocks: 2 },
  ]);
});

test("run 6 passes both halves of the gate once the window is marked", () => {
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.stmLag = summarizeStmLag(seriesFrom(RUN6_LAGS), [SYNC_WINDOW], SAMPLE_MS);
  const { violations, notes } = baselineViolations(snap, BASE);
  expect(violations).toEqual([]);
  expect(notes.join(" ")).toContain("5/146 samples excluded");
  expect(notes.join(" ")).toContain("peak including chaos 120");
});

test("RED half 1: a lag plateau OUTSIDE a chaos window still fails the gate", () => {
  // The same 120-block excursion, injected at t+30 min where no window covers
  // it, with the real sync window still marked. If exclusion had been global —
  // or keyed on the value rather than the time — this would pass, and the gate
  // would be decorative.
  const lags = [...RUN6_LAGS];
  lags[60] = 30;
  lags[61] = 60;
  lags[62] = 90;
  lags[63] = 120;
  const summary = summarizeStmLag(seriesFrom(lags), [SYNC_WINDOW], SAMPLE_MS);
  expect(summary.maxLagBlocks).toBe(120);
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.stmLag = summary;
  const { violations } = baselineViolations(snap, BASE);
  expect(violations.join(" ")).toContain("max STM lag blocks");
});

test("RED half 1b: with no window marked at all, run 6's own peak fails", () => {
  // What the metric did before this change, kept as the contrast: the ruling
  // narrows WHICH samples are gated, it does not lower the bar for the rest.
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.stmLag = summarizeStmLag(seriesFrom(RUN6_LAGS), [], SAMPLE_MS);
  const { violations } = baselineViolations(snap, BASE);
  expect(violations.join(" ")).toContain("max STM lag blocks: 120");
});

test("RED half 2: a restart that does NOT recover fails the recovery assertion", () => {
  // Identical window, identical peak — only the drain is missing: the STM is
  // still 120 blocks behind one interval after the process reported healthy.
  // Both runs absorbed that backlog inside a single 30 s interval, so this is
  // the failure the exclusion would otherwise have made invisible.
  const lags = [...RUN6_LAGS];
  for (let i = 110; i < 120; i++) lags[i] = 120;
  const summary = summarizeStmLag(seriesFrom(lags), [SYNC_WINDOW], SAMPLE_MS);
  expect(summary.recoveries[0]!.lagBlocks).toBe(120);
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.stmLag = summary;
  const { violations } = baselineViolations(snap, BASE);
  expect(violations.join(" ")).toContain("chaos recovery lag blocks (sync)");
});

test("a slow recovery fails even while the throughput gate reads healthy", () => {
  // The sharp version of the same case: outside the window every sample is
  // nominal, so maxLagBlocks is fine and ONLY the recovery assertion fires.
  const lags = [...RUN6_LAGS];
  lags[110] = 60;
  const summary = summarizeStmLag(seriesFrom(lags), [SYNC_WINDOW], SAMPLE_MS);
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.stmLag = summary;
  const { violations } = baselineViolations(snap, BASE);
  expect(violations.join(" ")).not.toContain("max STM lag blocks");
  expect(violations.join(" ")).toContain("chaos recovery lag blocks (sync)");
});

test("an unobserved recovery is a note, never a silent pass", () => {
  // Run truncated mid-deadline: there is no post-deadline sample, so there is
  // no measurement — which must read as "unobserved", not as green.
  const summary = summarizeStmLag(seriesFrom(RUN6_LAGS.slice(0, 110)), [SYNC_WINDOW], SAMPLE_MS);
  expect(summary.recoveries[0]!.lagBlocks).toBeNull();
  const snap = snapWith({ count: 10, p50: 7, p95: 18 });
  snap.stmLag = summary;
  const { violations, notes } = baselineViolations(snap, BASE);
  expect(violations).toEqual([]);
  expect(notes.join(" ")).toContain("chaos recovery (sync): run ended before");
});

test("a window left open by a throwing chaos routine is closed, not dropped", () => {
  // p6-chaos closes its windows in `finally`, but a hard failure between the
  // two marks would otherwise leave the window unrecorded and let the outage's
  // samples back into the gate — failing the run for the suite's own kill.
  expect(getChaosWindows()).toEqual([]);
  beginChaosWindow("indexer");
  const open = getChaosWindows();
  expect(open).toHaveLength(1);
  expect(open[0]!.endedAt).toBeGreaterThanOrEqual(open[0]!.startedAt);
  endChaosWindow("indexer");
  expect(getChaosWindows()).toHaveLength(1);
  // Closing twice must not invent a second window.
  endChaosWindow("indexer");
  expect(getChaosWindows()).toHaveLength(1);
});
