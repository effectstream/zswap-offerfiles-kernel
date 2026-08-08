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

const { baselineViolations } = await import("./metrics.ts");

/** A snapshot whose every other metric is comfortably inside baseline. */
function snapWith(bookRead: { count: number; p50: number; p95: number }) {
  return {
    submit: { count: 29, p50: 2627, p95: 6000, max: 7295 },
    publishToIndexedMs: { count: 33, p50: 17606, p95: 22000, max: 23176 },
    stmLag: { samples: 115, maxLagBlocks: 90, lastLagBlocks: 2 },
    sseDeliveryLagMs: { count: 21, p50: 1830, p95: 2308, max: 2785 },
    bookReadMs: { ...bookRead, max: bookRead.p95 },
    batcherQueueDepthMax: 1,
    rss: { syncStartKb: 1, syncEndKb: 1, indexerStartKb: 1, indexerEndKb: 1 },
    dbSizeBytes: 1,
    stormApiMs: { count: 200, p50: 6, p95: 103, max: 377 },
  } as any;
}

const BASE = {
  submitP95Ms: 6654,
  publishToIndexedP95Ms: 23983,
  bookReadP50Ms: 8,
  bookReadP95Ms: 20,
  maxStmLagBlocks: 95,
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

test("the committed baseline.json actually carries the median key", async () => {
  // Guards the fix end-to-end: the gate reads bookReadP50Ms, so a baseline
  // without it silently reverts to tail-only enforcement.
  const base = (await import("./baseline.json")).default as Record<string, unknown>;
  expect(typeof base["bookReadP50Ms"]).toBe("number");
  expect(base["bookReadP50Ms"]).toBeLessThan(base["bookReadP95Ms"] as number);
});
