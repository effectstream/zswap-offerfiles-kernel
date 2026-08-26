import { expect, test } from "bun:test";

import {
  interpolateQuote,
  isPriceLevelArray,
  isPriceLevels,
  LadderBook,
  rejectLevels,
  type PriceLevel,
} from "./src/ladder.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

const rungs = (...pairs: [string, string][]): PriceLevel[] =>
  pairs.map(([input, output]) => ({ input, output }));

// A concave curve: each additional unit of input buys less output.
const CONCAVE = rungs(["100", "100"], ["200", "190"], ["400", "360"]);

test("rejects rungs that are not strictly ascending in input", () => {
  expect(isPriceLevelArray(rungs(["100", "10"], ["100", "20"]))).toBe(false);
  expect(isPriceLevelArray(rungs(["200", "10"], ["100", "20"]))).toBe(false);
  expect(isPriceLevelArray(CONCAVE)).toBe(true);
});

test("rejects non-decimal amounts and malformed colors", () => {
  expect(isPriceLevelArray([{ input: "1.5", output: "10" }])).toBe(false);
  expect(isPriceLevelArray([{ input: "-1", output: "10" }])).toBe(false);
  expect(isPriceLevelArray([{ input: "0x10", output: "10" }])).toBe(false);
  expect(isPriceLevels({ tokenIn: "nothex", tokenOut: B, levels: CONCAVE })).toBe(false);
  expect(isPriceLevels({ tokenIn: A, tokenOut: A, levels: CONCAVE })).toBe(false);
  expect(isPriceLevels({ tokenIn: A, tokenOut: B, levels: CONCAVE })).toBe(true);
});

test("sizes outside the published range are refused, not extrapolated", () => {
  expect(interpolateQuote(CONCAVE, 99n)).toBeNull();
  expect(interpolateQuote(CONCAVE, 401n)).toBeNull();
  expect(interpolateQuote([], 100n)).toBeNull();
});

test("exact rung hits return that rung's output", () => {
  expect(interpolateQuote(CONCAVE, 100n)).toBe(100n);
  expect(interpolateQuote(CONCAVE, 200n)).toBe(190n);
  expect(interpolateQuote(CONCAVE, 400n)).toBe(360n);
});

test("a single-rung ladder quotes only at that exact size", () => {
  const one = rungs(["100", "95"]);
  expect(interpolateQuote(one, 100n)).toBe(95n);
  expect(interpolateQuote(one, 99n)).toBeNull();
  expect(interpolateQuote(one, 101n)).toBeNull();
});

test("interpolation underestimates the concave curve — the solver can always honour it", () => {
  // Midpoint of the [200,400] rung.
  const chord = interpolateQuote(CONCAVE, 300n)!;
  expect(chord).toBe(275n);
  expect(chord).toBeGreaterThan(interpolateQuote(CONCAVE, 200n)!);
  expect(chord).toBeLessThan(interpolateQuote(CONCAVE, 400n)!);

  // The guarantee, stated as it is actually used: sampling the same concave
  // curve more finely can only RAISE the quote at a given size. So a quote read
  // off a coarse ladder is never more than the curve itself would pay, and the
  // solver can always honour what it published.
  const refined = [...CONCAVE.slice(0, 2), { input: "300", output: "280" }, CONCAVE[2]];
  expect(isPriceLevelArray(refined)).toBe(true);
  expect(chord).toBeLessThanOrEqual(interpolateQuote(refined, 300n)!);
});

test("interpolated output is floored, never rounded up", () => {
  // 150 across [100→100, 200→190] is exactly 145; 151 lands on 145.9 → 145.
  expect(interpolateQuote(CONCAVE, 150n)).toBe(145n);
  expect(interpolateQuote(CONCAVE, 151n)).toBe(145n);
});

test("LadderBook quotes by direction and refuses the unposted reverse", () => {
  const book = LadderBook.fromPairs([{ tokenIn: A, tokenOut: B, levels: CONCAVE }]);
  expect(book.maxPayout(A, B, 200n)).toBe(190n);
  expect(book.maxPayout(B, A, 200n)).toBeNull();
  expect(book.size).toBe(1);
});

test("LadderBook rejects an invalid ladder rather than posting a price it cannot honour", () => {
  const book = new LadderBook();
  expect(() =>
    book.set({ tokenIn: A, tokenOut: B, levels: rungs(["200", "10"], ["100", "20"]) }),
  ).toThrow(/input-not-ascending/);
  expect(book.size).toBe(0);
});

// ── schema rules the old validator did not enforce ───────────────────────────

test("an empty ladder is refused, not published as a pair that quotes nothing", () => {
  // The solver used to accept this while the node rejected it, and run.ts then
  // dereferenced levels[length-1] on the empty array.
  expect(isPriceLevelArray([])).toBe(false);
  expect(rejectLevels([])).toBe("empty");
});

test("outputs must ascend — more input can never buy less", () => {
  expect(rejectLevels(rungs(["100", "100"], ["200", "50"]))).toBe("output-not-ascending");
  expect(rejectLevels(rungs(["100", "100"], ["200", "100"]))).toBe("output-not-ascending");
});

test("zero and negative amounts are refused", () => {
  expect(rejectLevels(rungs(["0", "100"]))).toBe("non-positive");
  expect(rejectLevels(rungs(["100", "0"]))).toBe("non-positive");
});

test("a convex ladder is refused, because interpolating it would over-promise", () => {
  // Rising marginal rate: the chord between rungs sits ABOVE the curve, so a
  // quote taken from it promises more than the solver could honour.
  expect(rejectLevels(rungs(["100", "100"], ["200", "150"], ["300", "260"]))).toBe("not-concave");
  // Non-increasing marginal rate is fine.
  expect(rejectLevels(rungs(["100", "100"], ["200", "180"], ["300", "250"]))).toBeNull();
  // A straight line is the boundary case and is allowed.
  expect(rejectLevels(rungs(["100", "100"], ["200", "200"], ["300", "300"]))).toBeNull();
});

test("the rung count is bounded", () => {
  const many = Array.from({ length: 65 }, (_, i) => ({
    input: String((i + 1) * 100),
    output: String((i + 1) * 90),
  }));
  expect(rejectLevels(many)).toBe("too-many-rungs");
});

test("the checked-in dev ladder satisfies the schema", async () => {
  const { loadLadderConfig } = await import("./src/config.ts");
  const { SOLVER_LADDER_CONFIG } = await import("./env.ts");
  const { ladders } = await loadLadderConfig(SOLVER_LADDER_CONFIG);
  for (const pair of ladders.pairs()) expect(rejectLevels(pair.levels)).toBeNull();
});
