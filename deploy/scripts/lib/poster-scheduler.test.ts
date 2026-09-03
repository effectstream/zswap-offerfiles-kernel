// Scheduler unit tests. No real time passes: the clock and the timer queue are
// injected, so a "60 second interval" test finishes in microseconds and cannot
// be flaky. Everything asserted here is a property FR-011 states.

import { describe, expect, test } from "bun:test";

import {
  percentile,
  PosterScheduler,
  type SchedulerTimers,
  type TickOutcome,
} from "./poster-scheduler.ts";

// ---------------------------------------------------------------------------
// A controllable clock + timer queue
// ---------------------------------------------------------------------------

class FakeTimers implements SchedulerTimers {
  time = 0;
  #seq = 0;
  #queue = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#queue.set(id, { at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#queue.delete(handle as number);
  }

  get pending(): number {
    return this.#queue.size;
  }

  /** The `at` of the earliest armed timer, or `null`. */
  get nextAt(): number | null {
    let best: number | null = null;
    for (const { at } of this.#queue.values()) best = best === null ? at : Math.min(best, at);
    return best;
  }

  /** Fire the earliest armed timer, moving the clock to its due time, then let
   *  the resulting promise chain settle. Returns false when nothing was armed. */
  async runNext(): Promise<boolean> {
    let bestId: number | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of this.#queue) {
      if (entry.at < bestAt) {
        bestAt = entry.at;
        bestId = id;
      }
    }
    if (bestId === null) return false;
    const entry = this.#queue.get(bestId)!;
    this.#queue.delete(bestId);
    this.time = Math.max(this.time, entry.at);
    entry.fn();
    await drain();
    return true;
  }
}

/** Let every already-queued microtask AND the `await`s inside the scheduler
 *  settle. Two real macrotask turns are plenty for the chain used here. */
async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const ok = (mode: TickOutcome["mode"] = "mint", extra: Partial<TickOutcome> = {}): TickOutcome => ({
  ok: true,
  mode,
  ...extra,
});

// ---------------------------------------------------------------------------

describe("percentile", () => {
  test("is null for an empty window and the sample itself for one value", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
  });

  test("nearest-rank over a sorted copy, input untouched", () => {
    const values = [30, 10, 50, 20, 40];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 100)).toBe(50);
    expect(values).toEqual([30, 10, 50, 20, 40]);
  });

  test("p95 of 100 samples is the 95th smallest", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
  });
});

describe("cadence", () => {
  test("the first tick runs immediately, then one per interval (fixed RATE)", async () => {
    const timers = new FakeTimers();
    const startedAt: number[] = [];
    const scheduler = new PosterScheduler({
      intervalMs: 60_000,
      timers,
      warn: () => undefined,
      tick: async () => {
        startedAt.push(timers.time);
        // A tick that takes real work but less than the interval.
        timers.time += 12_000;
        return ok();
      },
    });

    scheduler.start();
    for (let i = 0; i < 3; i++) await timers.runNext();

    // 0, 60_000, 120_000 — NOT 0, 72_000, 144_000. A 12 s tick must not push
    // the schedule out by 12 s each round.
    expect(startedAt).toEqual([0, 60_000, 120_000]);
    expect(scheduler.stats().ticks).toBe(3);
    expect(scheduler.stats().overruns).toBe(0);
  });

  test("stop() disarms the timer, and start() is idempotent", async () => {
    const timers = new FakeTimers();
    let ran = 0;
    const scheduler = new PosterScheduler({
      intervalMs: 1_000,
      timers,
      tick: async () => {
        ran += 1;
        return ok();
      },
    });
    scheduler.start();
    scheduler.start(); // must not arm a second timer
    expect(timers.pending).toBe(1);
    await timers.runNext();
    expect(ran).toBe(1);
    await scheduler.stop();
    expect(timers.pending).toBe(0);
    expect(await timers.runNext()).toBe(false);
  });
});

describe("no overlap", () => {
  test("the next timer is armed only after the tick settles", async () => {
    const timers = new FakeTimers();
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: (() => void) | null = null;
    const scheduler = new PosterScheduler({
      intervalMs: 1_000,
      timers,
      warn: () => undefined,
      tick: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((r) => {
          release = r;
        });
        concurrent -= 1;
        return ok();
      },
    });

    scheduler.start();
    await timers.runNext(); // starts tick 1, which is now parked
    expect(concurrent).toBe(1);
    // While a tick is in flight there is NO armed timer, so nothing can start.
    expect(timers.pending).toBe(0);

    release!();
    await drain();
    expect(concurrent).toBe(0);
    expect(timers.pending).toBe(1); // the next tick is armed only now
    expect(maxConcurrent).toBe(1);
  });

  test("stop() waits for the in-flight tick", async () => {
    const timers = new FakeTimers();
    let finished = false;
    let release: (() => void) | null = null;
    const scheduler = new PosterScheduler({
      intervalMs: 1_000,
      timers,
      tick: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        finished = true;
        return ok();
      },
    });
    scheduler.start();
    await timers.runNext();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await drain();
    expect(stopped).toBe(false); // still waiting for the tick

    release!();
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
  });

  test("runOnce() refuses to run while a tick is in flight", async () => {
    const timers = new FakeTimers();
    let release: (() => void) | null = null;
    const scheduler = new PosterScheduler({
      intervalMs: 1_000,
      timers,
      tick: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return ok();
      },
    });
    scheduler.start();
    await timers.runNext();
    await expect(scheduler.runOnce()).rejects.toThrow(/already running/);
    release!();
    await drain();
  });
});

describe("overrun", () => {
  test("an overrunning tick warns, is counted, and the next tick starts immediately", async () => {
    const timers = new FakeTimers();
    const warnings: string[] = [];
    const startedAt: number[] = [];
    const scheduler = new PosterScheduler({
      intervalMs: 60_000,
      timers,
      warn: (msg) => warnings.push(msg),
      tick: async () => {
        startedAt.push(timers.time);
        timers.time += 90_000; // 1.5 intervals
        return ok();
      },
    });

    scheduler.start();
    await timers.runNext(); // tick 1: 0 -> 90_000
    // Next tick is due at 60_000, which is in the past, so it is armed at +0.
    expect(timers.nextAt).toBe(90_000);
    await timers.runNext(); // tick 2 starts at 90_000, immediately

    expect(startedAt).toEqual([0, 90_000]);
    expect(scheduler.stats().overruns).toBe(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("overran");
    expect(warnings[0]).toContain("90000ms");
  });

  test("a tick exactly one interval long counts as an overrun (>=, not >)", async () => {
    const timers = new FakeTimers();
    const scheduler = new PosterScheduler({
      intervalMs: 1_000,
      timers,
      warn: () => undefined,
      tick: async () => {
        timers.time += 1_000;
        return ok();
      },
    });
    scheduler.start();
    await timers.runNext();
    expect(scheduler.stats().overruns).toBe(1);
    expect(timers.nextAt).toBe(1_000); // armed at +0 from "now"
  });
});

describe("counters", () => {
  test("mints count actual mints, not the mode; reoffers count the mode", async () => {
    const timers = new FakeTimers();
    const outcomes: TickOutcome[] = [
      { ok: true, mode: "mint", minted: true, offerId: "aa" },
      // A mint tick that FAILED after minting: the coin exists, the offer does not.
      { ok: false, mode: "mint", minted: true, failure: "post_timeout", error: "no" },
      // A mint tick that failed BEFORE minting: not a mint.
      { ok: false, mode: "mint", minted: false, failure: "mint_failed", error: "no dust" },
      { ok: true, mode: "reoffer", offerId: "bb" },
      { ok: true, mode: "degraded", failure: "insufficient_dust" },
    ];
    let i = 0;
    const scheduler = new PosterScheduler({
      intervalMs: 10,
      timers,
      warn: () => undefined,
      tick: async () => outcomes[i++]!,
    });
    scheduler.start();
    for (let n = 0; n < outcomes.length; n++) await timers.runNext();

    const stats = scheduler.stats();
    expect(stats.ticks).toBe(5);
    expect(stats.mints).toBe(2);
    expect(stats.reoffers).toBe(1);
    expect(stats.degraded).toBe(1);
    expect(stats.success).toBe(3);
    expect(stats.failure).toBe(2);
    expect(stats.lastOfferId).toBe("bb"); // sticky: the degraded tick posted none
    expect(stats.lastMode).toBe("degraded");
  });

  test("consecutive failures accumulate and reset on the first success", async () => {
    const timers = new FakeTimers();
    const results: boolean[] = [false, false, false, true];
    let i = 0;
    const scheduler = new PosterScheduler({
      intervalMs: 10,
      timers,
      warn: () => undefined,
      tick: async () => {
        const good = results[i++]!;
        return good
          ? { ok: true, mode: "mint" as const, minted: true }
          : { ok: false, mode: "mint" as const, failure: "post_timeout", error: "x" };
      },
    });
    scheduler.start();
    await timers.runNext();
    await timers.runNext();
    await timers.runNext();
    expect(scheduler.stats().consecutiveFailures).toBe(3);
    await timers.runNext();
    expect(scheduler.stats().consecutiveFailures).toBe(0);
  });

  test("a THROWING tick is a counted failure, not a crash", async () => {
    const timers = new FakeTimers();
    const scheduler = new PosterScheduler({
      intervalMs: 10,
      timers,
      warn: () => undefined,
      tick: async () => {
        throw new Error("indexer exploded");
      },
    });
    scheduler.start();
    await timers.runNext();
    const stats = scheduler.stats();
    expect(stats.ticks).toBe(1);
    expect(stats.failure).toBe(1);
    expect(stats.lastFailure).toBe("tick_threw");
    expect(stats.lastError).toBe("indexer exploded");
    // and the loop keeps going
    expect(timers.pending).toBe(1);
  });
});

describe("p95", () => {
  test("p50/p95 follow the measured tick durations", async () => {
    const timers = new FakeTimers();
    // 10 ticks of 1..10 units. p50 = 5, p95 = 10 (nearest rank).
    const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let i = 0;
    const scheduler = new PosterScheduler({
      intervalMs: 1_000,
      timers,
      warn: () => undefined,
      tick: async () => {
        timers.time += durations[i++]!;
        return ok();
      },
    });
    scheduler.start();
    for (let n = 0; n < durations.length; n++) await timers.runNext();
    const stats = scheduler.stats();
    expect(stats.p50TickMs).toBe(5);
    expect(stats.p95TickMs).toBe(10);
    expect(stats.lastTickMs).toBe(10);
  });

  test("the window is bounded, so an old slow tick eventually leaves p95", async () => {
    const timers = new FakeTimers();
    let i = 0;
    const scheduler = new PosterScheduler({
      intervalMs: 1_000,
      timers,
      warn: () => undefined,
      durationWindow: 3,
      tick: async () => {
        timers.time += i++ === 0 ? 10_000 : 5;
        return ok();
      },
    });
    scheduler.start();
    await timers.runNext(); // 10_000
    expect(scheduler.stats().p95TickMs).toBe(10_000);
    for (let n = 0; n < 3; n++) await timers.runNext(); // three 5s push it out
    expect(scheduler.stats().p95TickMs).toBe(5);
  });
});
