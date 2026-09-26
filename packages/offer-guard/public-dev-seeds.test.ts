import { describe, expect, test } from "bun:test";

import { isPublicDevSeed, KNOWN_PUBLIC_DEV_SEEDS, normalizeSeedHex } from "./mod.ts";

describe("public dev seeds (00050)", () => {
  test("every seed the repository ships is recognised", () => {
    expect(KNOWN_PUBLIC_DEV_SEEDS.length).toBe(6);
    for (const seed of KNOWN_PUBLIC_DEV_SEEDS) expect(isPublicDevSeed(seed)).toBe(true);
  });

  test("the batcher fallback and solver dev seed are in the list", () => {
    // packages/batcher/config.ts BATCHER_SEED and packages/solver/env.ts DEV_SEED.
    expect(KNOWN_PUBLIC_DEV_SEEDS).toContain("0".repeat(63) + "3");
    expect(KNOWN_PUBLIC_DEV_SEEDS).toContain("0".repeat(62) + "21");
  });

  test("any small-integer 32-byte seed counts as public, whatever its spelling", () => {
    expect(isPublicDevSeed("0".repeat(64))).toBe(true);
    expect(isPublicDevSeed("0".repeat(62) + "ff")).toBe(true);
    expect(isPublicDevSeed("0x" + "0".repeat(62) + "05")).toBe(true);
    expect(isPublicDevSeed(("0".repeat(63) + "A").toUpperCase())).toBe(true);
    expect(isPublicDevSeed(`  ${"0".repeat(63)}1\n`)).toBe(true);
  });

  test("a real-looking seed is not public", () => {
    expect(isPublicDevSeed("0".repeat(61) + "100")).toBe(false);
    expect(isPublicDevSeed("7f".repeat(32))).toBe(false);
    // 64-byte (mnemonic-derived) seeds are never repository dev seeds.
    expect(isPublicDevSeed("0".repeat(127) + "1")).toBe(false);
  });

  test("malformed input is not classified here (callers name that separately)", () => {
    expect(isPublicDevSeed("")).toBe(false);
    expect(isPublicDevSeed("xyz")).toBe(false);
    expect(isPublicDevSeed("0".repeat(63))).toBe(false);
  });

  test("normalizeSeedHex strips 0x, whitespace and case", () => {
    expect(normalizeSeedHex(" 0xABcd ")).toBe("abcd");
    expect(normalizeSeedHex("0XFF")).toBe("ff");
  });
});
