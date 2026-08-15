import { expect, test } from "bun:test";

import { buildLadders } from "./src/config.ts";
import { loadLadderConfig } from "./src/config.ts";
import { PRICE_SCALE, parseCanonicalPrice } from "./src/engine.ts";
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
    refPricesUsd: { FOO: "2.5" },
    pairs: [{ tokenIn: "FOO", tokenOut: "BAR", levels: LEVELS }],
  });
  expect(ladders.maxPayout(A, B, 1000n)).toBe(1000n);
  expect(refPricesUsd.get(A)).toBe(2_500_000_000n);
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

test("reference prices use one exact positive fixed-point grammar", () => {
  expect(parseCanonicalPrice("1")).toBe(PRICE_SCALE);
  expect(parseCanonicalPrice("2.5")).toBe(2_500_000_000n);
  expect(parseCanonicalPrice("0.000000001")).toBe(1n);
  for (const price of [0, 1, Number.MAX_SAFE_INTEGER + 1, "0", "1.0", "01", "1e3", "0.0000000001", "1.1234567890"]) {
    expect(parseCanonicalPrice(price)).toBeNull();
  }
  expect(() => buildLadders({ refPricesUsd: { [A]: 1 as unknown as string }, pairs: [] })).toThrow(
    /canonical decimal string/,
  );
});

test("duplicate directed pairs are rejected after aliases resolve", () => {
  expect(() =>
    buildLadders({
      tokens: { FOO: A, BAR: B },
      pairs: [
        { tokenIn: "FOO", tokenOut: "BAR", levels: LEVELS },
        { tokenIn: A, tokenOut: B.toUpperCase(), levels: LEVELS },
      ],
    }),
  ).toThrow(/duplicate directed pair/);
});

test("ladder amounts share the canonical positive u256 wire domain", () => {
  for (const levels of [
    [{ input: "01", output: "1" }],
    [{ input: "1", output: "01" }],
    [{ input: "1", output: (1n << 256n).toString() }],
  ]) {
    expect(() => buildLadders({ pairs: [{ tokenIn: A, tokenOut: B, levels }] })).toThrow(
      /invalid ladder/,
    );
  }
});

test("more than the shared maximum of 64 pairs is rejected", () => {
  expect(() =>
    buildLadders({ pairs: Array.from({ length: 65 }, () => ({ tokenIn: A, tokenOut: B, levels: LEVELS })) }),
  ).toThrow(/maximum is 64/);
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
