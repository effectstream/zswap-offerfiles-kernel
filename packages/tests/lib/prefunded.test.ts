import { afterEach, describe, expect, test } from "bun:test";

import {
  requireBalance,
  requireDistinctTokenColors,
  requireTokenColor,
} from "./prefunded.ts";

const touched = new Map<string, string | undefined>();

const setEnv = (name: string, value: string | undefined): void => {
  if (!touched.has(name)) touched.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  for (const [name, value] of touched) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  touched.clear();
});

describe("externally prefunded chain-test prerequisites", () => {
  test("rejects a missing token color with a same-chain funding instruction", () => {
    setEnv("E2E_TEST_TOKEN", undefined);
    expect(() => requireTokenColor("E2E_TEST_TOKEN")).toThrow("same-chain externally issued inventory");
  });

  test("normalizes valid colors and rejects duplicate identities", () => {
    setEnv("E2E_TEST_TOKEN_A", "AA".repeat(32));
    setEnv("E2E_TEST_TOKEN_B", "aa".repeat(32));
    expect(requireTokenColor("E2E_TEST_TOKEN_A")).toBe("aa".repeat(32));
    expect(() => requireDistinctTokenColors(["E2E_TEST_TOKEN_A", "E2E_TEST_TOKEN_B"]))
      .toThrow("must identify distinct externally issued tokens");
  });

  test("fails clearly when the named wallet has insufficient external inventory", () => {
    expect(() => requireBalance("maker-1", "bb".repeat(32), 9n, 10n))
      .toThrow("Provision same-chain token inventory");
  });

  test("accepts exact required inventory", () => {
    expect(() => requireBalance("maker-1", "bb".repeat(32), 10n, 10n)).not.toThrow();
  });
});
