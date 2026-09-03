import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TOKEN_DECIMALS,
  baseUnitsToCoins,
  coinsToBaseUnits,
} from "./amount.ts";

describe("the registry default (00024 FR-001/FR-004)", () => {
  test("is 6 — every token this stack mints or registers", () => {
    expect(DEFAULT_TOKEN_DECIMALS).toBe(6);
  });

  test("is the default parameter of both helpers", () => {
    expect(coinsToBaseUnits("1")).toBe(1_000_000n);
    expect(baseUnitsToCoins(1_000_000n)).toBe("1");
  });
});

describe("coinsToBaseUnits", () => {
  test("scales whole coins by 10^decimals", () => {
    expect(coinsToBaseUnits("1000", 6)).toBe(1_000_000_000n);
    expect(coinsToBaseUnits(1000n, 6)).toBe(1_000_000_000n);
    expect(coinsToBaseUnits(1, 6)).toBe(1_000_000n);
    expect(coinsToBaseUnits("0", 6)).toBe(0n);
  });

  test("is exact on fractions — 1.5 is 1_500_000, not a float", () => {
    expect(coinsToBaseUnits("1.5", 6)).toBe(1_500_000n);
    expect(coinsToBaseUnits(1.5, 6)).toBe(1_500_000n);
    expect(coinsToBaseUnits("0.000001", 6)).toBe(1n);
    // 0.1 + 0.2 territory: string maths never sees the float.
    expect(coinsToBaseUnits("0.3", 6)).toBe(300_000n);
    expect(coinsToBaseUnits("1.", 6)).toBe(1_000_000n);
  });

  test("keeps working past 2^53 and up to the Uint<64> ceiling", () => {
    expect(coinsToBaseUnits("9007199254740993", 6)).toBe(9_007_199_254_740_993_000_000n);
    // 2^64 − 1 base units, expressed as coins.
    expect(coinsToBaseUnits("18446744073709.551615", 6)).toBe(18_446_744_073_709_551_615n);
  });

  test("honours other decimals — nothing hard-codes 6", () => {
    expect(coinsToBaseUnits("1.5", 8)).toBe(150_000_000n);
    expect(coinsToBaseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(coinsToBaseUnits("1000", 0)).toBe(1000n);
  });

  test("refuses precision finer than the token carries (Q9 — never round)", () => {
    expect(() => coinsToBaseUnits("1.0000005", 6)).toThrow(/7 decimal places/);
    expect(() => coinsToBaseUnits("0.1", 0)).toThrow(/1 decimal places/);
  });

  test("trailing zeros are not precision", () => {
    expect(coinsToBaseUnits("1.5000000", 6)).toBe(1_500_000n);
    expect(coinsToBaseUnits("1.000000000", 6)).toBe(1_000_000n);
    expect(coinsToBaseUnits("1.0", 0)).toBe(1n);
  });

  test("refuses negatives, exponents, separators and junk", () => {
    expect(() => coinsToBaseUnits("-1", 6)).toThrow(/not a whole-coin amount/);
    expect(() => coinsToBaseUnits(-1n, 6)).toThrow(/must not be negative/);
    expect(() => coinsToBaseUnits("1e6", 6)).toThrow(/not a whole-coin amount/);
    expect(() => coinsToBaseUnits(1e21, 6)).toThrow(/not a whole-coin amount/);
    expect(() => coinsToBaseUnits("1,000", 6)).toThrow(/not a whole-coin amount/);
    expect(() => coinsToBaseUnits("", 6)).toThrow(/not a whole-coin amount/);
    expect(() => coinsToBaseUnits(Number.NaN, 6)).toThrow(/not a whole-coin amount/);
  });

  test("refuses a decimals outside [0, 38]", () => {
    expect(() => coinsToBaseUnits("1", -1)).toThrow(/decimals must be an integer/);
    expect(() => coinsToBaseUnits("1", 39)).toThrow(/decimals must be an integer/);
    expect(() => coinsToBaseUnits("1", 1.5)).toThrow(/decimals must be an integer/);
  });
});

describe("baseUnitsToCoins", () => {
  test("renders exactly, with no trailing zeros", () => {
    expect(baseUnitsToCoins(1_500_000n, 6)).toBe("1.5");
    expect(baseUnitsToCoins(1_000_000n, 6)).toBe("1");
    expect(baseUnitsToCoins(1_000_000_000n, 6)).toBe("1000");
    expect(baseUnitsToCoins(1n, 6)).toBe("0.000001");
    expect(baseUnitsToCoins(0n, 6)).toBe("0");
    expect(baseUnitsToCoins(1000n, 6)).toBe("0.001");
  });

  test("0 decimals is the identity", () => {
    expect(baseUnitsToCoins(1000n, 0)).toBe("1000");
  });

  test("refuses negatives and a decimals outside [0, 38]", () => {
    expect(() => baseUnitsToCoins(-1n, 6)).toThrow(/must not be negative/);
    expect(() => baseUnitsToCoins(1n, 39)).toThrow(/decimals must be an integer/);
  });
});

describe("round trips", () => {
  const cases: Array<[bigint, number]> = [
    [0n, 6],
    [1n, 6],
    [999_999n, 6],
    [1_000_000n, 6],
    [1_000_000_000n, 6],
    [18_446_744_073_709_551_615n, 6],
    [1234n, 0],
    [12_345_678_901_234_567_890n, 18],
  ];

  for (const [base, decimals] of cases) {
    test(`${base} base units at ${decimals} decimals survives both directions`, () => {
      expect(coinsToBaseUnits(baseUnitsToCoins(base, decimals), decimals)).toBe(base);
    });
  }
});
