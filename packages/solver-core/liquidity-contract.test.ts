import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES,
  createSolverLiquidityEnvelope,
  createSolverLiquiditySnapshot,
  parsePositiveU64String,
  parseSolverLiquidityEnvelope,
  parseSolverLiquidityEnvelopeJson,
} from "./liquidity-contract.ts";

const LIVE_FIXTURE = new URL(
  "./fixtures/offer-files-data-lineage/v1/upstream-liquidity-200-live.json",
  import.meta.url,
);
const WITHDRAWN_FIXTURE = new URL(
  "./fixtures/offer-files-data-lineage/v1/upstream-liquidity-200-withdrawn.json",
  import.meta.url,
);

const fixture = (url: URL): string => readFileSync(url, "utf8");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("solver liquidity v1 fixtures", () => {
  test("producer mirrors remain byte-for-byte pinned and parse beyond JS safe integers", () => {
    const liveRaw = fixture(LIVE_FIXTURE);
    const withdrawnRaw = fixture(WITHDRAWN_FIXTURE);
    expect(sha256(liveRaw)).toBe("ad6957d37093d6ca961ad232b7c0799f934ab08b646ef7939559ae43e4dd0617");
    expect(sha256(withdrawnRaw)).toBe(
      "a36571f9d54895efe3b092b505678376b6c99ba3de4a65ca25b514fda2e615ea",
    );

    const live = parseSolverLiquidityEnvelopeJson(liveRaw);
    const withdrawn = parseSolverLiquidityEnvelopeJson(withdrawnRaw);
    expect(live?.snapshots).toHaveLength(1);
    expect(withdrawn?.snapshots[0].pairs).toEqual([]);
    expect(parsePositiveU64String(live?.snapshots[0].version)).toBe(9_007_199_254_740_993n);
    expect(parsePositiveU64String(withdrawn?.snapshots[0].version)).toBe(
      9_007_199_254_740_994n,
    );
  });

  test("builder canonicalizes pair order and reproduces the live fixture value", () => {
    const expected = parseSolverLiquidityEnvelopeJson(fixture(LIVE_FIXTURE));
    expect(expected).not.toBeNull();
    const source = expected!.snapshots[0];
    const snapshot = createSolverLiquiditySnapshot({
      solverId: source.solverId,
      version: source.version,
      updatedAtMs: Date.parse(source.updatedAt),
      expiresAtMs: Date.parse(source.expiresAt),
      pairs: [...source.pairs].reverse(),
    });
    const actual = createSolverLiquidityEnvelope(Date.parse(expected!.generatedAt), [snapshot]);
    expect(actual).toEqual(expected);

    snapshot.pairs[0].levels[0].output = "999999";
    expect(actual.snapshots[0].pairs[0].levels[0].output).toBe("900");
  });

  test("builder rejects noncanonical token identities instead of rewriting them", () => {
    expect(() =>
      createSolverLiquiditySnapshot({
        solverId: "solver-one",
        version: "1",
        updatedAtMs: 1_000,
        expiresAtMs: 2_000,
        pairs: [
          {
            tokenIn: "A".repeat(64),
            tokenOut: "b".repeat(64),
            levels: [{ input: "1", output: "1" }],
          },
        ],
      }),
    ).toThrow("invalid solver liquidity snapshot");
  });
});

describe("solver liquidity v1 strict decoder", () => {
  const liveValue = () => JSON.parse(fixture(LIVE_FIXTURE)) as any;

  test("rejects open, lossy, noncanonical, duplicate, and unstable objects", () => {
    const extra = liveValue();
    extra.extra = true;
    expect(parseSolverLiquidityEnvelope(extra)).toBeNull();

    const numericVersion = liveValue();
    numericVersion.snapshots[0].version = 9_007_199_254_740_992;
    expect(parseSolverLiquidityEnvelope(numericVersion)).toBeNull();

    const uppercaseToken = liveValue();
    uppercaseToken.snapshots[0].pairs[0].tokenIn = "A".repeat(64);
    expect(parseSolverLiquidityEnvelope(uppercaseToken)).toBeNull();

    const unstablePairs = liveValue();
    unstablePairs.snapshots[0].pairs.reverse();
    expect(parseSolverLiquidityEnvelope(unstablePairs)).toBeNull();

    const duplicatePair = liveValue();
    duplicatePair.snapshots[0].pairs = [
      duplicatePair.snapshots[0].pairs[0],
      structuredClone(duplicatePair.snapshots[0].pairs[0]),
    ];
    expect(parseSolverLiquidityEnvelope(duplicatePair)).toBeNull();

    const badTimestamp = liveValue();
    badTimestamp.snapshots[0].updatedAt = "2026-08-14T12:00:00Z";
    expect(parseSolverLiquidityEnvelope(badTimestamp)).toBeNull();
  });

  test("rejects multiple filtered snapshots, oversized bodies, and malformed JSON", () => {
    const multiple = liveValue();
    multiple.snapshots.push(structuredClone(multiple.snapshots[0]));
    expect(parseSolverLiquidityEnvelope(multiple)).toBeNull();
    expect(
      parseSolverLiquidityEnvelopeJson(" ".repeat(MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES + 1)),
    ).toBeNull();
    expect(parseSolverLiquidityEnvelopeJson("{")).toBeNull();
    expect(parseSolverLiquidityEnvelopeJson(new Uint8Array([0xff]))).toBeNull();
  });
});
