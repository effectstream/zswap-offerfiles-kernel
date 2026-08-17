import { describe, expect, test } from "bun:test";
import { SolverLevelsRegistry } from "./solver-levels.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const T0 = Date.parse("2026-08-14T12:00:00.000Z");

const pair = (
  tokenIn: string,
  tokenOut: string,
  levels: Array<{ input: string; output: string }>,
) => ({ tokenIn, tokenOut, levels });

const AB = pair(A, B, [
  { input: "1000", output: "900" },
  { input: "2000", output: "1700" },
  { input: "4000", output: "3000" },
]);
const BC = pair(B, C, [
  { input: "1000", output: "2000" },
  { input: "2000", output: "3900" },
]);

describe("SolverLevelsRegistry grouped liquidity view", () => {
  test("returns one stable-sorted, detached snapshot while preserving legacy all() shape", () => {
    const registry = new SolverLevelsRegistry({ ttlMs: 60_000 });
    registry.publish("solver-one", [BC, AB], 9_007_199_254_740_993n, T0);

    const envelope = registry.liquidityEnvelope("solver-one", T0 + 10_000);
    expect(envelope).toEqual({
      schemaVersion: 1,
      source: "offer-files-solver",
      generatedAt: "2026-08-14T12:00:10.000Z",
      snapshots: [
        {
          solverId: "solver-one",
          version: "9007199254740993",
          updatedAt: "2026-08-14T12:00:00.000Z",
          expiresAt: "2026-08-14T12:01:00.000Z",
          pairs: [AB, BC],
        },
      ],
    });

    envelope.snapshots[0].pairs[0].levels[0].output = "999999";
    expect(registry.quote(A, B, 1000n, T0 + 10_001)).toBe(900n);

    const legacy = registry.all(T0 + 10_001);
    expect(legacy.map((entry) => `${entry.tokenIn}|${entry.tokenOut}`)).toEqual([
      `${A}|${B}`,
      `${B}|${C}`,
    ]);
    expect(Object.keys(legacy[0]).sort()).toEqual(
      ["levels", "solverId", "tokenIn", "tokenOut", "updatedAt", "version"].sort(),
    );
  });

  test("stores expiry once so later TTL extension cannot revive or prolong a publication", () => {
    let ttlMs = 60_000;
    const registry = new SolverLevelsRegistry({ ttlMs: () => ttlMs });
    registry.publish("solver-one", [AB], 1n, T0);
    ttlMs = 600_000;

    const atCutoff = registry.liquiditySnapshot("solver-one", T0 + 60_000);
    expect(atCutoff).toMatchObject({
      version: "1",
      updatedAt: "2026-08-14T12:00:00.000Z",
      expiresAt: "2026-08-14T12:01:00.000Z",
      pairs: [],
    });
    expect(registry.quote(A, B, 1000n, T0 + 60_000)).toBeNull();
    expect(registry.all(T0 + 60_000)).toEqual([]);
  });

  test("stores expiry once so later TTL shortening cannot expire a publication early", () => {
    let ttlMs = 60_000;
    const registry = new SolverLevelsRegistry({ ttlMs: () => ttlMs });
    registry.publish("solver-one", [AB], 1n, T0);
    ttlMs = 1;

    expect(registry.liquiditySnapshot("solver-one", T0 + 2)?.pairs).toHaveLength(1);
    expect(registry.liquiditySnapshot("solver-one", T0 + 2)?.expiresAt).toBe(
      "2026-08-14T12:01:00.000Z",
    );
  });

  test("distinguishes explicit withdrawal, expiry tombstone, and unknown identity", () => {
    const registry = new SolverLevelsRegistry({ ttlMs: 60_000 });
    registry.publish("solver-one", [AB], 1n, T0);
    registry.publish("solver-one", [], 2n, T0 + 30_000);

    expect(registry.liquiditySnapshot("solver-one", T0 + 40_000)).toEqual({
      solverId: "solver-one",
      version: "2",
      updatedAt: "2026-08-14T12:00:30.000Z",
      expiresAt: "2026-08-14T12:01:30.000Z",
      pairs: [],
    });
    expect(registry.liquiditySnapshot("unknown", T0 + 40_000)).toBeNull();
    expect(registry.liquidityEnvelope("unknown", T0 + 40_000)).toEqual({
      schemaVersion: 1,
      source: "offer-files-solver",
      generatedAt: "2026-08-14T12:00:40.000Z",
      snapshots: [],
    });
  });

  test("invalid injected TTL fails closed without extending freshness", () => {
    const registry = new SolverLevelsRegistry({ ttlMs: () => Number.POSITIVE_INFINITY });
    registry.publish("solver-one", [AB], 1n, T0);
    expect(registry.liquiditySnapshot("solver-one", T0)).toEqual({
      solverId: "solver-one",
      version: "1",
      updatedAt: "2026-08-14T12:00:00.000Z",
      expiresAt: "2026-08-14T12:00:00.000Z",
      pairs: [],
    });
  });

  test("invalid observation times throw before expiry can mutate a live declaration", () => {
    const registry = new SolverLevelsRegistry({ ttlMs: 60_000 });
    registry.publish("solver-one", [AB], 1n, T0);

    expect(() => registry.publish("solver-one", [], 2n, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => registry.quoteDetails(A, B, 1000n, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => registry.all(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => registry.liquiditySnapshot("solver-one", Number.POSITIVE_INFINITY)).toThrow();

    expect(registry.quote(A, B, 1000n, T0 + 1)).toBe(900n);
    expect(registry.liquiditySnapshot("solver-one", T0 + 1)?.pairs).toHaveLength(1);
  });
});
