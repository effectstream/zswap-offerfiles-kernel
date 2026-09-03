// The give-size draw (00027 FR-002, SC-001).
//
// Two properties are worth the most here. The first is that the draw is really
// LOG-uniform: with a uniform draw over 0.1 … 10 coins roughly 90 % of offers
// would be above 1 coin, which is precisely the book the range exists to avoid,
// and no small sample would notice. The second is that both ends are INCLUSIVE
// — `Math.exp(Math.log(x))` is not exactly `x`, so the clamp is load-bearing
// rather than defensive.

import { describe, expect, test } from "bun:test";

import {
  drawGiveAmount,
  type GiveRange,
  makeGiveSizer,
  makeRng,
  MAX_DRAWABLE_BASE_UNITS,
} from "./poster-size.ts";
import { baseUnitsToCoins, coinsToBaseUnits } from "../../../packages/solver-core/amount.ts";

/** The spec's headline range: 0.1 … 10 WBTC at 6 decimals. */
const RANGE: GiveRange = { minBase: 100_000n, maxBase: 10_000_000n };
const ONE_COIN = 1_000_000n;

/** An RNG that returns a fixed sequence, so a draw can be checked by hand. */
const fixedRng = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
};

const median = (values: bigint[]): bigint => {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2n;
};

// ---------------------------------------------------------------------------

describe("makeRng", () => {
  test("the same seed replays the same stream, a different seed does not", () => {
    const a = Array.from({ length: 8 }, makeRng("seed-a"));
    const b = Array.from({ length: 8 }, makeRng("seed-a"));
    const c = Array.from({ length: 8 }, makeRng("seed-b"));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test("every value is in [0, 1)", () => {
    const rng = makeRng("range-check");
    for (let i = 0; i < 1000; i += 1) {
      const u = rng();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  test("adjacent seeds do not produce adjacent streams (xmur3 avalanches)", () => {
    // A raw `Number(seed)` seed would make GIVE_SIZE_SEED=1 and =2 draw almost
    // the same first value, which is a trap for anyone bisecting a reproduction.
    expect(makeRng("1")()).not.toBeCloseTo(makeRng("2")(), 2);
  });

  test("unseeded draws come from crypto.getRandomValues and differ", () => {
    const unseeded = Array.from({ length: 16 }, makeRng());
    expect(new Set(unseeded).size).toBeGreaterThan(8);
  });
});

describe("drawGiveAmount — the shape of the draw", () => {
  test("u=0 is exactly the minimum and u=1 exactly the maximum (AC-1: inclusive)", () => {
    expect(drawGiveAmount(RANGE, fixedRng(0))).toBe(RANGE.minBase);
    expect(drawGiveAmount(RANGE, fixedRng(1))).toBe(RANGE.maxBase);
  });

  test("u=0.5 is the GEOMETRIC mean, not the arithmetic one", () => {
    // sqrt(0.1 * 10) = 1 coin. An arithmetic midpoint would be 5.05 coins.
    expect(drawGiveAmount(RANGE, fixedRng(0.5))).toBe(ONE_COIN);
    expect(baseUnitsToCoins(drawGiveAmount(RANGE, fixedRng(0.5)))).toBe("1");
  });

  test("min === max degenerates to the fixed size (spec edge case 3)", () => {
    const fixed: GiveRange = { minBase: ONE_COIN, maxBase: ONE_COIN };
    for (const u of [0, 0.25, 0.5, 0.9999]) {
      expect(drawGiveAmount(fixed, fixedRng(u))).toBe(ONE_COIN);
    }
  });

  test("a one-base-unit-wide range still draws inside itself", () => {
    const tiny: GiveRange = { minBase: 100_000n, maxBase: 100_001n };
    for (const u of [0, 0.3, 0.7, 1]) {
      const drawn = drawGiveAmount(tiny, fixedRng(u));
      expect(drawn).toBeGreaterThanOrEqual(tiny.minBase);
      expect(drawn).toBeLessThanOrEqual(tiny.maxBase);
    }
  });

  test("an out-of-contract rng is clamped, never allowed out of range", () => {
    expect(drawGiveAmount(RANGE, fixedRng(-3))).toBe(RANGE.minBase);
    expect(drawGiveAmount(RANGE, fixedRng(7))).toBe(RANGE.maxBase);
    expect(() => drawGiveAmount(RANGE, fixedRng(Number.NaN))).toThrow(/rng\(\) returned/);
  });

  test("an invalid range is refused rather than drawn from", () => {
    expect(() => drawGiveAmount({ minBase: 0n, maxBase: 10n }, fixedRng(0.5))).toThrow(/minBase/);
    expect(() => drawGiveAmount({ minBase: 10n, maxBase: 5n }, fixedRng(0.5))).toThrow(/below minBase/);
    expect(() =>
      drawGiveAmount({ minBase: 1n, maxBase: MAX_DRAWABLE_BASE_UNITS + 1n }, fixedRng(0.5)),
    ).toThrow(/exceeds/);
  });

  test("every drawn amount is a whole number of base units, i.e. 6 decimals (FR-002)", () => {
    const rng = makeRng("six-decimals");
    for (let i = 0; i < 200; i += 1) {
      const drawn = drawGiveAmount(RANGE, rng);
      // A round-trip through the coin spelling is exact only for a value that
      // sits on the 6-decimal grid, which every base-unit integer does.
      expect(coinsToBaseUnits(baseUnitsToCoins(drawn))).toBe(drawn);
    }
  });
});

describe("SC-001 — 20 seeded draws over 0.1 … 10 coins", () => {
  // The seed is PINNED on purpose. A log-uniform draw over 0.1 … 10 has its
  // median at the geometric mean, exactly 1 coin, so "median < 1 coin" over a
  // 20-sample draw is a ~50/50 property of the sample rather than of the
  // distribution. The seed-independent statement of the same property — half
  // the mass below one coin — is asserted in the next describe block.
  const SEED = "size-range";

  test(">= 15 distinct sizes, all in range, median below one coin", () => {
    const sizer = makeGiveSizer(RANGE, SEED);
    const draws = Array.from({ length: 20 }, () => sizer.draw());

    expect(new Set(draws.map(String)).size).toBeGreaterThanOrEqual(15);
    for (const drawn of draws) {
      expect(drawn).toBeGreaterThanOrEqual(RANGE.minBase);
      expect(drawn).toBeLessThanOrEqual(RANGE.maxBase);
    }
    expect(median(draws)).toBeLessThan(ONE_COIN);
  });

  test("the same seed replays the same 20 sizes", () => {
    const first = Array.from({ length: 20 }, makeGiveSizer(RANGE, SEED).draw);
    const again = Array.from({ length: 20 }, makeGiveSizer(RANGE, SEED).draw);
    expect(first).toEqual(again);
  });
});

describe("the distribution is log-uniform, not uniform", () => {
  test("about half of 20 000 draws are below one coin", () => {
    // A UNIFORM draw over the same range would put ~9.1 % below one coin, so
    // this bound separates the two hypotheses by a mile.
    const rng = makeRng("distribution");
    let below = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      if (drawGiveAmount(RANGE, rng) < ONE_COIN) below += 1;
    }
    expect(below / n).toBeGreaterThan(0.47);
    expect(below / n).toBeLessThan(0.53);
  });

  test("each decade of the range gets its share (0.1–1 as likely as 1–10)", () => {
    const rng = makeRng("decades");
    let lower = 0;
    let upper = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const drawn = drawGiveAmount(RANGE, rng);
      if (drawn < ONE_COIN) lower += 1;
      else upper += 1;
    }
    expect(Math.abs(lower - upper) / 10_000).toBeLessThan(0.05);
  });
});

describe("makeGiveSizer", () => {
  test("last() is null until the first draw, then the value just drawn (FR-003)", () => {
    const sizer = makeGiveSizer(RANGE, "last-check");
    expect(sizer.last()).toBeNull();
    const first = sizer.draw();
    expect(sizer.last()).toBe(first);
    const second = sizer.draw();
    expect(sizer.last()).toBe(second);
  });

  test("it refuses an invalid range at construction, not at the first mint", () => {
    expect(() => makeGiveSizer({ minBase: 5n, maxBase: 1n })).toThrow(/below minBase/);
  });

  test("consecutive draws differ, which is the whole point (US1)", () => {
    const sizer = makeGiveSizer(RANGE, "consecutive");
    const a = sizer.draw();
    const b = sizer.draw();
    expect(a).not.toBe(b);
  });
});
