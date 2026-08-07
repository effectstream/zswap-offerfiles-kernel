import { expect, test } from "bun:test";

import { buildLadders } from "./src/config.ts";
import { loadLadderConfig } from "./src/config.ts";
import { SOLVER_LADDER_CONFIG } from "./env.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const LEVELS = [
  { input: "1000", output: "1000" },
  { input: "100000", output: "99000" },
];

test("aliases resolve to colors in both pairs and reference prices", () => {
  const { ladders, refPricesUsd } = buildLadders({
    tokens: { FOO: A, BAR: B },
    refPricesUsd: { FOO: 2.5 },
    pairs: [{ tokenIn: "FOO", tokenOut: "BAR", levels: LEVELS }],
  });
  expect(ladders.maxPayout(A, B, 1000n)).toBe(1000n);
  expect(refPricesUsd.get(A)).toBe(2.5);
});

test("raw colors work without any alias map, and are lowercased", () => {
  const { ladders } = buildLadders({
    pairs: [{ tokenIn: A.toUpperCase(), tokenOut: B, levels: LEVELS }],
  });
  expect(ladders.maxPayout(A, B, 1000n)).toBe(1000n);
});

test("an unknown alias names itself and the aliases that do exist", () => {
  expect(() =>
    buildLadders({ tokens: { FOO: A }, pairs: [{ tokenIn: "NOPE", tokenOut: "FOO", levels: LEVELS }] }),
  ).toThrow(/"NOPE" is neither a 64-hex color nor a known alias \(FOO\)/);
});

test("an alias pointing at a non-color is rejected rather than posted", () => {
  expect(() =>
    buildLadders({ tokens: { FOO: "not-a-color" }, pairs: [{ tokenIn: "FOO", tokenOut: B, levels: LEVELS }] }),
  ).toThrow(/not a 64-hex color/);
});

test("a negative or non-finite reference price is rejected", () => {
  expect(() => buildLadders({ refPricesUsd: { [A]: -1 }, pairs: [] })).toThrow(/non-negative/);
  expect(() => buildLadders({ refPricesUsd: { [A]: NaN }, pairs: [] })).toThrow(/non-negative/);
});

test("the checked-in dev config loads and posts both directions", async () => {
  const { ladders, refPricesUsd } = await loadLadderConfig(SOLVER_LADDER_CONFIG);
  expect(ladders.size).toBe(2);
  expect(refPricesUsd.size).toBe(2);
  for (const pair of ladders.pairs()) {
    expect(ladders.maxPayout(pair.tokenIn, pair.tokenOut, 1000n)).toBe(1000n);
  }
});

test("a missing config file points at the bootstrap script", async () => {
  await expect(loadLadderConfig("/nonexistent/ladders.json")).rejects.toThrow(/bootstrap-dev/);
});
