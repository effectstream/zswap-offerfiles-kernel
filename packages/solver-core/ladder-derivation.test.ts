import { describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";

import { admissionPairKey } from "./admission-policy.ts";
import {
  buildPriceLevelsFrame,
  buildSolverCapabilitiesFrame,
  DEFAULT_LADDER_RESOURCE_LIMITS,
  deriveLadder,
  HARD_LADDER_RESOURCE_LIMITS,
  MAX_SETTLEMENT_AMOUNT,
  resolveLadderResourceLimits,
  withdrawalPriceLevelsFrame,
  type DerivedLadder,
  type LadderCombinationProvenance,
  type LadderSourceOffer,
} from "./ladder-derivation.ts";
import { interpolateQuote as schemaQuote, rejectLevels } from "./ladder-schema.ts";
import {
  interpolateQuote as relayQuote,
  parsePriceLevels,
  parseSolverCapabilities,
} from "./relay-ws-contract.ts";

const token = (value: number): string => value.toString(16).padStart(64, "0");
const hash = (value: number): string => (10_000 + value).toString(16).padStart(64, "0");
const nullifier = (value: number): string => (1_000_000 + value).toString(16).padStart(64, "0");

const A = token(1);
const B = token(2);
const C = token(3);
const NOW = 1_700_000_000_000;
const OPTIONS = { nowMs: NOW, expiryMarginSeconds: 60 };

const offer = (
  id: number,
  amountIn: bigint,
  amountOut: bigint,
  tokenIn = A,
  tokenOut = B,
  overrides: Partial<LadderSourceOffer> = {},
): LadderSourceOffer => ({
  offerHash: hash(id),
  gives: [{ token: tokenOut, amount: amountOut, kind: "SHIELDED" }],
  wants: [{ token: tokenIn, amount: amountIn, kind: "SHIELDED" }],
  expiresAt: NOW + 3_600_000,
  inputNullifiers: [nullifier(id)],
  ...overrides,
});

interface OracleOffer {
  hash: string;
  input: bigint;
  output: bigint;
}

interface OracleResult {
  input: bigint;
  output: bigint;
  hashes: string[];
}

const compareHashes = (left: readonly string[], right: readonly string[]): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return left.length - right.length;
};

/** Independent test oracle: bit-mask iteration, with no production recursion or frontier map. */
const oracleBest = (
  offers: readonly OracleOffer[],
  budget: bigint,
  maxMakers = 8,
): OracleResult | null => {
  if (offers.length > 20) throw new Error("oracle fixture too large");
  let best: OracleResult | null = null;
  const subsetCount = 2 ** offers.length;
  for (let mask = 1; mask < subsetCount; mask += 1) {
    const selected: OracleOffer[] = [];
    for (let index = 0; index < offers.length; index += 1) {
      if ((mask & 2 ** index) !== 0) selected.push(offers[index]!);
    }
    if (selected.length > maxMakers) continue;
    const input = selected.reduce((sum, entry) => sum + entry.input, 0n);
    const output = selected.reduce((sum, entry) => sum + entry.output, 0n);
    if (input > budget || input > MAX_SETTLEMENT_AMOUNT || output > MAX_SETTLEMENT_AMOUNT) continue;
    const hashes = selected.map((entry) => entry.hash).sort();
    const candidate = { input, output, hashes };
    if (
      best === null ||
      candidate.output > best.output ||
      (candidate.output === best.output && candidate.input < best.input) ||
      (candidate.output === best.output && candidate.input === best.input &&
        candidate.hashes.length < best.hashes.length) ||
      (candidate.output === best.output && candidate.input === best.input &&
        candidate.hashes.length === best.hashes.length &&
        compareHashes(candidate.hashes, best.hashes) < 0)
    ) {
      best = candidate;
    }
  }
  return best;
};

const asOracleOffers = (book: readonly LadderSourceOffer[]): OracleOffer[] =>
  book.map((entry) => ({
    hash: entry.offerHash.toLowerCase(),
    input: entry.wants[0]!.amount,
    output: entry.gives[0]!.amount,
  }));

const selectedCombination = (
  combinations: readonly LadderCombinationProvenance[],
  input: bigint,
): LadderCombinationProvenance | null => {
  let selected: LadderCombinationProvenance | null = null;
  for (const combination of combinations) {
    if (BigInt(combination.input) > input) break;
    selected = combination;
  }
  return selected;
};

const assertExactOverPublishedRange = (
  book: readonly LadderSourceOffer[],
  derived: DerivedLadder,
  maxMakers = 8,
): void => {
  expect(derived.levels).toHaveLength(1);
  expect(derived.provenance).toHaveLength(1);
  const pair = derived.levels[0]!;
  const provenance = derived.provenance[0]!;
  const first = BigInt(pair.levels[0]!.input);
  const last = BigInt(pair.levels[pair.levels.length - 1]!.input);
  const oracleOffers = asOracleOffers(book);
  for (let input = first; input <= last; input += 1n) {
    const expected = oracleBest(oracleOffers, input, maxMakers);
    expect(expected).not.toBeNull();
    expect(relayQuote(pair.levels, input)).toBe(expected!.output);
    expect(schemaQuote(pair.levels, input)).toBe(expected!.output);
    const witness = selectedCombination(provenance.combinations, input);
    expect(witness).not.toBeNull();
    expect(BigInt(witness!.input)).toBe(expected!.input);
    expect(BigInt(witness!.output)).toBe(expected!.output);
    expect(witness!.offerHashes).toEqual(expected!.hashes);
  }
  expect(relayQuote(pair.levels, first - 1n)).toBeNull();
  expect(relayQuote(pair.levels, last + 1n)).toBeNull();
};

describe("whole-offer examples and provenance", () => {
  test("reproduces the 14-point hard case and exact witness changes", () => {
    const unit = 1_000_000n;
    const book = [
      offer(1, 10n * unit, 20n * unit),
      offer(2, unit, unit),
      offer(3, 150n * unit, 100n * unit),
    ];
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.levels[0]!.levels).toEqual([
      { input: "1000000", output: "1000000" },
      { input: "9999999", output: "1000000" },
      { input: "10000000", output: "20000000" },
      { input: "10999999", output: "20000000" },
      { input: "11000000", output: "21000000" },
      { input: "149999999", output: "21000000" },
      { input: "150000000", output: "100000000" },
      { input: "150999999", output: "100000000" },
      { input: "151000000", output: "101000000" },
      { input: "159999999", output: "101000000" },
      { input: "160000000", output: "120000000" },
      { input: "160999999", output: "120000000" },
      { input: "161000000", output: "121000000" },
      { input: "1610000000", output: "121000000" },
    ]);
    const provenance = derived.provenance[0]!;
    expect(provenance.terminalInput).toBe("1610000000");
    expect(provenance.nominalTerminalInput).toBe("1610000000");
    expect(provenance.capReasons).toEqual([]);
    expect(selectedCombination(provenance.combinations, 160n * unit)!.offerHashes).toEqual([
      hash(1),
      hash(3),
    ]);
    const samples = [
      [unit, unit],
      [9_900_000n, unit],
      [10n * unit, 20n * unit],
      [11n * unit, 21n * unit],
      [149_990_000n, 21n * unit],
      [150n * unit, 100n * unit],
      [151n * unit, 101n * unit],
      [159_990_000n, 101n * unit],
      [160n * unit, 120n * unit],
      [161n * unit, 121n * unit],
      [1_610n * unit, 121n * unit],
    ] as const;
    for (const [amountIn, expectedOutput] of samples) {
      expect(relayQuote(derived.levels[0]!.levels, amountIn)).toBe(expectedOutput);
    }
    expect(relayQuote(derived.levels[0]!.levels, 1_610n * unit + 1n)).toBeNull();
  });

  test("maps maker gives/wants to the eight-point B-to-A staircase", () => {
    const book = [
      offer(11, 20n, 100n, B, A),
      offer(12, 10n, 40n, B, A),
      offer(13, 30n, 10n, B, A),
    ];
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.levels).toEqual([{
      tokenIn: B,
      tokenOut: A,
      levels: [
        { input: "10", output: "40" },
        { input: "19", output: "40" },
        { input: "20", output: "100" },
        { input: "29", output: "100" },
        { input: "30", output: "140" },
        { input: "59", output: "140" },
        { input: "60", output: "150" },
        { input: "600", output: "150" },
      ],
    }]);
    const provenance = derived.provenance[0]!;
    expect(selectedCombination(provenance.combinations, 30n)!.offerHashes).toEqual([
      hash(11),
      hash(12),
    ]);
    expect(selectedCombination(provenance.combinations, 40n)!.offerHashes).toEqual([
      hash(11),
      hash(12),
    ]);
    expect(selectedCombination(provenance.combinations, 60n)!.offerHashes).toEqual([
      hash(11),
      hash(12),
      hash(13),
    ]);
    for (const [input, output] of [[10n, 40n], [30n, 140n], [40n, 140n], [50n, 140n],
      [60n, 150n], [160n, 150n], [600n, 150n]] as const) {
      expect(relayQuote(derived.levels[0]!.levels, input)).toBe(output);
    }
    expect(derived.levels.some((pair) => pair.tokenIn === A && pair.tokenOut === B)).toBe(false);
    expect(relayQuote(derived.levels[0]!.levels, 601n)).toBeNull();
  });

  test("single offers get one genuine threshold and exactly one 10x tail point", () => {
    const derived = deriveLadder([offer(20, 3_000n, 5_000n)], OPTIONS);
    expect(derived.levels[0]!.levels).toEqual([
      { input: "3000", output: "5000" },
      { input: "30000", output: "5000" },
    ]);
    expect(derived.provenance[0]!.combinations).toEqual([
      { input: "3000", output: "5000", offerHashes: [hash(20)] },
    ]);
  });

  test("adjacent thresholds need no duplicate plateau endpoint", () => {
    const derived = deriveLadder([offer(21, 1n, 1n), offer(22, 1n, 2n)], OPTIONS);
    expect(derived.levels[0]!.levels).toEqual([
      { input: "1", output: "2" },
      { input: "2", output: "3" },
      { input: "20", output: "3" },
    ]);
    expect(new Set(derived.levels[0]!.levels.map((entry) => entry.input)).size).toBe(3);
  });
});

describe("exact search and deterministic ties", () => {
  test("matches an independent oracle over deterministic random books and insertion orders", () => {
    let state = 0x00009c0;
    const next = (maximum: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % maximum;
    };
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const count = 1 + next(7);
      const book = Array.from({ length: count }, (_, index) =>
        offer(100 + iteration * 10 + index, BigInt(1 + next(7)), BigInt(1 + next(11))));
      const forward = deriveLadder(book, OPTIONS);
      const reversed = deriveLadder([...book].reverse(), OPTIONS);
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
      assertExactOverPublishedRange(book, forward);
      expect(parsePriceLevels(buildPriceLevelsFrame(forward.levels))).toEqual(
        buildPriceLevelsFrame(forward.levels),
      );
    }
  });

  test("uses lower input, then fewer files, then sorted hashes for equal output", () => {
    const lowerInput = deriveLadder([offer(1_001, 2n, 10n), offer(1_002, 3n, 10n)], OPTIONS);
    expect(selectedCombination(lowerInput.provenance[0]!.combinations, 3n)!.offerHashes)
      .toEqual([hash(1_001)]);

    const fewer = deriveLadder([
      offer(1_011, 4n, 8n),
      offer(1_012, 2n, 4n),
      offer(1_013, 2n, 4n),
    ], OPTIONS);
    expect(fewer.provenance[0]!.combinations.find((entry) => entry.input === "4")).toEqual({
      input: "4",
      output: "8",
      offerHashes: [hash(1_011)],
    });

    const lexical = deriveLadder([
      offer(1_022, 1n, 1n),
      offer(1_021, 1n, 1n),
    ], OPTIONS);
    expect(lexical.provenance[0]!.combinations[0]!.offerHashes).toEqual([hash(1_021)]);
  });

  test("keeps dominated files in the candidate universe when they improve a later set", () => {
    const book = [
      offer(1_031, 20n, 100n),
      offer(1_032, 10n, 40n),
      offer(1_033, 30n, 10n),
    ];
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.provenance[0]!.combinations.at(-1)).toEqual({
      input: "60",
      output: "150",
      offerHashes: [hash(1_031), hash(1_032), hash(1_033)],
    });
    expect(derived.excluded.some((entry) => entry.offerHash === hash(1_033))).toBe(false);
  });

  test("distinguishes candidate count from the eight-maker witness limit", () => {
    const book = Array.from({ length: 9 }, (_, index) =>
      offer(1_100 + index, 1n, BigInt(index + 1)));
    const derived = deriveLadder(book, OPTIONS);
    const final = derived.provenance[0]!.combinations.at(-1)!;
    expect(derived.diagnostics.pairs[0]!.candidateOffers).toBe(9);
    expect(derived.diagnostics.pairs[0]!.visitedSubsets).toBe(510);
    expect(final.offerHashes).toHaveLength(8);
    expect(final.output).toBe("44");
    expect(final.offerHashes).not.toContain(hash(1_100));
  });
});

describe("wire and numeric bounds", () => {
  test("retains the longest safe frontier prefix under the 64-point cap", () => {
    const book = Array.from({ length: 40 }, (_, index) =>
      offer(2_000 + index, BigInt((index + 1) * 100), BigInt(index + 1)));
    const derived = deriveLadder(book, {
      ...OPTIONS,
      resourceLimits: { maxMakersPerCombination: 1 },
    });
    expect(derived.levels[0]!.levels).toHaveLength(64);
    expect(derived.provenance[0]!.combinations).toHaveLength(32);
    expect(derived.provenance[0]!.terminalInput).toBe("3299");
    expect(derived.provenance[0]!.nominalTerminalInput).toBe("32000");
    expect(derived.provenance[0]!.capReasons).toEqual([
      "wire-point-cap",
      "next-omitted-improvement",
    ]);
    expect(relayQuote(derived.levels[0]!.levels, 3_299n)).toBe(32n);
    expect(relayQuote(derived.levels[0]!.levels, 3_300n)).toBeNull();
  });

  test("counts the terminal point: 63 adjacent genuine thresholds fit exactly", () => {
    const book = Array.from({ length: 6 }, (_, index) => {
      const amount = 1n << BigInt(index);
      return offer(2_100 + index, amount, amount);
    });
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.provenance[0]!.combinations).toHaveLength(63);
    expect(derived.levels[0]!.levels).toHaveLength(64);
    expect(derived.levels[0]!.levels.at(-1)).toEqual({ input: "630", output: "63" });
  });

  test("withholds when adjacent omitted improvements leave no safe terminal", () => {
    const book = Array.from({ length: 7 }, (_, index) => {
      const amount = 1n << BigInt(index);
      return offer(2_200 + index, amount, amount);
    });
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.levels).toEqual([]);
    expect(derived.diagnostics.pairs[0]!.reason).toBe("wire-point-cap");
  });

  test("applies the u128 settlement ceiling while retaining u256 wire grammar", () => {
    const cappedInput = MAX_SETTLEMENT_AMOUNT / 10n + 1n;
    const capped = deriveLadder([offer(2_300, cappedInput, 1n)], OPTIONS);
    expect(capped.provenance[0]!.terminalInput).toBe(MAX_SETTLEMENT_AMOUNT.toString());
    expect(capped.provenance[0]!.nominalTerminalInput).toBe((cappedInput * 10n).toString());
    expect(capped.provenance[0]!.capReasons).toEqual(["settlement-amount-cap"]);

    const noTail = deriveLadder([offer(2_301, MAX_SETTLEMENT_AMOUNT, 1n)], OPTIONS);
    expect(noTail.levels).toEqual([]);
    expect(noTail.diagnostics.pairs[0]!.reason).toBe("settlement-amount-cap");

    const tooLarge = deriveLadder([offer(2_302, MAX_SETTLEMENT_AMOUNT + 1n, 1n)], OPTIONS);
    expect(tooLarge.levels).toEqual([]);
    expect(tooLarge.excluded).toEqual([
      { offerHash: hash(2_302), reason: "settlement-amount-cap" },
    ]);

    const wireU256 = (1n << 256n) - 1n;
    expect(rejectLevels([{ input: wireU256.toString(), output: wireU256.toString() }])).toBeNull();
    expect(rejectLevels([{ input: (wireU256 + 1n).toString(), output: "1" }]))
      .toBe("malformed-rung");
  });

  test("prunes overflowing positive descendants but preserves smaller exact combinations", () => {
    const half = MAX_SETTLEMENT_AMOUNT / 2n + 1n;
    const derived = deriveLadder([
      offer(2_310, half, 2n),
      offer(2_311, half, 3n),
      offer(2_312, 1n, 1n),
    ], OPTIONS);
    expect(derived.diagnostics.pairs[0]!.amountCappedSubsets).toBeGreaterThan(0);
    expect(derived.provenance[0]!.combinations.some((entry) => entry.input === (half + 1n).toString()))
      .toBe(true);
  });

  test("enforces the 64-pair cap independently from source and search limits", () => {
    const book = Array.from({ length: 65 }, (_, index) =>
      offer(2_400 + index, 1n, 1n, token(100 + index * 2), token(101 + index * 2)));
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.levels).toHaveLength(64);
    expect(derived.diagnostics.pairs).toHaveLength(65);
    expect(derived.diagnostics.pairs.filter((entry) => entry.reason === "pair-cap")).toHaveLength(1);
  });
});

describe("fail-closed limits and cancellation", () => {
  test("exports measured defaults and rejects raised, zero, fractional and unknown-runtime controls", () => {
    expect(DEFAULT_LADDER_RESOURCE_LIMITS).toEqual({
      maxSourceOffers: 4_096,
      maxVisitedSubsetsPerPair: 100_000,
      maxVisitedSubsetsTotal: 200_000,
      maxMakersPerCombination: 8,
      maxWirePointsPerPair: 64,
      maxPairs: 64,
    });
    expect(HARD_LADDER_RESOURCE_LIMITS).toEqual(DEFAULT_LADDER_RESOURCE_LIMITS);
    expect(resolveLadderResourceLimits({ maxPairs: 3 })).toEqual({
      ok: true,
      limits: { ...DEFAULT_LADDER_RESOURCE_LIMITS, maxPairs: 3 },
    });
    for (const value of [0, 1.5, 65, Number.NaN]) {
      const derived = deriveLadder([offer(3_000, 1n, 1n)], {
        ...OPTIONS,
        resourceLimits: { maxPairs: value },
      });
      expect(derived.levels).toEqual([]);
      expect(derived.diagnostics.stopReason).toBe("invalid-resource-limit");
      expect(derived.diagnostics.invalidResourceLimit!.field).toBe("maxPairs");
    }
  });

  test("the source scan cap counts malformed offers and withdraws the full snapshot", () => {
    const malformed = offer(3_010, 1n, 1n, A, B, { offerHash: "bad" });
    const derived = deriveLadder([malformed, offer(3_011, 1n, 1n), offer(3_012, 1n, 1n)], {
      ...OPTIONS,
      resourceLimits: { maxSourceOffers: 2 },
    });
    expect(derived.levels).toEqual([]);
    expect(derived.diagnostics.stopReason).toBe("source-offer-cap");
    expect(derived.diagnostics.sourceOffersScanned).toBe(3);
  });

  test("pair search exhaustion withholds that pair without sorting a partial frontier", () => {
    const derived = deriveLadder([
      offer(3_020, 1n, 1n),
      offer(3_021, 2n, 2n),
      offer(3_022, 4n, 4n),
    ], {
      ...OPTIONS,
      resourceLimits: { maxVisitedSubsetsPerPair: 3 },
    });
    expect(derived.levels).toEqual([]);
    expect(derived.diagnostics.pairs[0]).toMatchObject({
      status: "withheld",
      reason: "pair-search-cap",
      visitedSubsets: 3,
    });
  });

  test("global exhaustion retains completed proven pairs and withholds the rest", () => {
    const derived = deriveLadder([
      offer(3_030, 1n, 1n, A, B),
      offer(3_031, 2n, 2n, A, B),
      offer(3_032, 1n, 1n, B, C),
      offer(3_033, 2n, 2n, B, C),
      offer(3_034, 1n, 1n, C, A),
    ], {
      ...OPTIONS,
      resourceLimits: { maxVisitedSubsetsTotal: 5 },
    });
    expect(derived.levels).toHaveLength(1);
    expect(derived.diagnostics.stopReason).toBe("global-search-cap");
    expect(derived.diagnostics.visitedSubsets).toBe(5);
    expect(derived.diagnostics.pairs.map((entry) => entry.reason)).toEqual([
      null,
      "global-search-cap",
      "global-search-cap",
    ]);
    expect(derived.tokenIds).toEqual([A, B]);
    expect(derived.provenance).toHaveLength(1);
    expect(derived.diagnostics.pairs[0]).toMatchObject({ status: "published", wirePoints: 4 });
  });

  for (const failure of ["aborted", "abort-check-failed"] as const) {
    for (const [checkpoint, stopAt, expectedVisits] of [
      ["before search", 16, 1],
      ["during search", 17, 256],
      ["after search", 18, 511],
      ["after encoding", 19, 511],
    ] as const) {
      test(`one-shot ${failure} on a later pair ${checkpoint} withdraws every pair`, () => {
        const book = [
          offer(3_080, 1n, 1n, A, B),
          ...Array.from({ length: 9 }, (_, index) => offer(3_081 + index, 1n, 1n, B, C)),
          offer(3_090, 1n, 1n, C, A),
        ];
        expect(deriveLadder(book, OPTIONS).levels).toHaveLength(3);

        // One initial check + eleven scan checks + three checks for the first
        // completed pair precede the second pair's checks. Its 510 subsets
        // cross one periodic cancellation checkpoint (total visit 256).
        let calls = 0;
        const shouldAbort = (): boolean => {
          calls += 1;
          if (calls !== stopAt) return false;
          if (failure === "abort-check-failed") throw new Error("supersession check failed");
          return true;
        };
        const derived = deriveLadder(book, { ...OPTIONS, shouldAbort });
        expect(calls).toBe(stopAt);
        expect(shouldAbort()).toBe(false);
        expect(derived.levels).toEqual([]);
        expect(derived.tokenIds).toEqual([]);
        expect(derived.provenance).toEqual([]);
        expect(derived.diagnostics.stopReason).toBe(failure);
        expect(derived.diagnostics.visitedSubsets).toBe(expectedVisits);
        expect(derived.diagnostics.pairs).toHaveLength(3);
        expect(derived.diagnostics.pairs[0]).toMatchObject({
          tokenIn: A,
          tokenOut: B,
          visitedSubsets: 1,
          storedExactInputs: 1,
        });
        for (const pair of derived.diagnostics.pairs) {
          expect(pair).toMatchObject({
            status: "withheld",
            reason: failure,
            frontierCombinations: 0,
            wirePoints: 0,
          });
        }
        expect(derived.excluded).toContainEqual({ offerHash: hash(3_080), reason: failure });
        expect(derived.excluded).toContainEqual({ offerHash: hash(3_090), reason: failure });
      });
    }
  }

  test("abort checks cover initial scan, subset work, post-search and post-encoding", () => {
    const immediately = deriveLadder([offer(3_040, 1n, 1n)], {
      ...OPTIONS,
      shouldAbort: () => true,
    });
    expect(immediately.diagnostics.stopReason).toBe("aborted");

    let subsetCalls = 0;
    const duringSubset = deriveLadder(
      Array.from({ length: 9 }, (_, index) => offer(3_050 + index, 1n << BigInt(index), 1n)),
      {
        ...OPTIONS,
        shouldAbort: () => ++subsetCalls >= 12,
      },
    );
    expect(duringSubset.diagnostics.stopReason).toBe("aborted");
    expect(duringSubset.diagnostics.visitedSubsets).toBe(256);

    let postEncodingCalls = 0;
    const afterEncoding = deriveLadder([offer(3_060, 1n, 1n)], {
      ...OPTIONS,
      shouldAbort: () => ++postEncodingCalls >= 5,
    });
    expect(postEncodingCalls).toBe(5);
    expect(afterEncoding.levels).toEqual([]);
    expect(afterEncoding.diagnostics.stopReason).toBe("aborted");
  });

  test("abort predicate exceptions fail closed", () => {
    let calls = 0;
    const derived = deriveLadder([offer(3_070, 1n, 1n)], {
      ...OPTIONS,
      shouldAbort: () => {
        calls += 1;
        if (calls === 4) throw new Error("supersession source failed");
        return false;
      },
    });
    expect(derived.levels).toEqual([]);
    expect(derived.diagnostics.stopReason).toBe("abort-check-failed");
  });
});

describe("eligibility and shared-coin policy", () => {
  test("preserves every existing validity exclusion and rejects ambiguous identities", () => {
    const shared = nullifier(9_999);
    const duplicateA = offer(4_010, 1n, 1n, A, B, { inputNullifiers: [nullifier(4_010)] });
    const duplicateB = offer(4_010, 2n, 2n, A, B, { inputNullifiers: [nullifier(4_011)] });
    const book: LadderSourceOffer[] = [
      { ...offer(4_001, 1n, 1n), gives: [
        { token: B, amount: 1n, kind: "SHIELDED" },
        { token: C, amount: 1n, kind: "SHIELDED" },
      ] },
      { ...offer(4_002, 1n, 1n), gives: [{ token: B, amount: 1n, kind: "UNSHIELDED" }] },
      offer(4_003, 0n, 1n),
      offer(4_004, 1n, 1n, A, A),
      offer(4_005, 1n, 1n, A, "zz"),
      offer(4_006, 1n, 1n, A, B, { offerHash: "zz" }),
      offer(4_007, 1n, 1n, A, B, { inputNullifiers: ["zz"] }),
      offer(4_008, 1n, 1n, A, B, { expiresAt: null }),
      offer(4_009, 1n, 1n, A, B, { expiresAt: NOW + 60_000 }),
      duplicateA,
      duplicateB,
      offer(4_012, 1n, 1n, A, B, { inputNullifiers: [shared] }),
      offer(4_013, 2n, 3n, A, B, { inputNullifiers: [shared] }),
      offer(4_014, MAX_SETTLEMENT_AMOUNT + 1n, 1n),
      offer(4_015, 1n, 1n),
    ];
    const derived = deriveLadder(book, {
      ...OPTIONS,
      unavailableOfferHashes: [hash(4_015).toUpperCase()],
    });
    const reasons = new Set(derived.excluded.map((entry) => entry.reason));
    for (const reason of [
      "multi-leg",
      "non-shielded-leg",
      "non-positive-amount",
      "same-token",
      "malformed-token",
      "malformed-hash",
      "malformed-nullifier",
      "no-expiry",
      "expiring",
      "duplicate-offer",
      "shared-coin",
      "settlement-amount-cap",
      "unavailable",
    ]) expect(reasons.has(reason as never)).toBe(true);
    expect(derived.provenance[0]!.combinations.at(-1)!.offerHashes).toEqual([hash(4_012)]);
  });

  test("directed allowlist and output minimum filter the exact frontier", () => {
    const book = [offer(4_100, 2n, 5n), offer(4_101, 3n, 5n)];
    const unsupported = deriveLadder(book, {
      ...OPTIONS,
      supportedPairs: new Set([admissionPairKey(B, A)]),
    });
    expect(unsupported.levels).toEqual([]);
    expect(unsupported.diagnostics.pairs[0]!.reason).toBe("unsupported-pair");

    const missingMinimum = deriveLadder(book, { ...OPTIONS, minJobOutput: new Map([[C, 1n]]) });
    expect(missingMinimum.levels).toEqual([]);
    expect(missingMinimum.diagnostics.pairs[0]!.reason).toBe("minimum-output");

    const admitted = deriveLadder(book, { ...OPTIONS, minJobOutput: new Map([[B, 8n]]) });
    expect(admitted.provenance[0]!.combinations).toEqual([
      { input: "5", output: "10", offerHashes: [hash(4_100), hash(4_101)] },
    ]);
    expect(admitted.levels[0]!.levels).toEqual([
      { input: "5", output: "10" },
      { input: "50", output: "10" },
    ]);
  });
});

describe("shared schema and frame builders", () => {
  test("allows equal-output plateaus and convex jumps but rejects decreasing output", () => {
    const staircase = [
      { input: "1", output: "1" },
      { input: "9", output: "1" },
      { input: "10", output: "20" },
    ];
    expect(rejectLevels(staircase)).toBeNull();
    expect(rejectLevels([
      { input: "1", output: "1" },
      { input: "2", output: "2" },
      { input: "3", output: "100" },
    ])).toBeNull();
    expect(rejectLevels([
      { input: "1", output: "2" },
      { input: "2", output: "1" },
    ])).toBe("output-decreasing");
  });

  test("preserves amount, positivity, input-order, token and size checks", () => {
    expect(rejectLevels([])).toBe("empty");
    expect(rejectLevels([{ input: "0", output: "1" }])).toBe("non-positive");
    expect(rejectLevels([{ input: "1.5", output: "1" }])).toBe("malformed-rung");
    expect(rejectLevels([{ input: "2", output: "1" }, { input: "2", output: "2" }]))
      .toBe("input-not-ascending");
    expect(rejectLevels(Array.from({ length: 65 }, (_, index) => ({
      input: String(index + 1),
      output: "1",
    })))).toBe("too-many-rungs");
    expect(() => buildPriceLevelsFrame([{ tokenIn: A, tokenOut: A, levels: [
      { input: "1", output: "1" },
    ] }])).toThrow(/bad-tokens/);
  });

  test("builders round-trip accepted frames, clone input, and emit withdrawals/capabilities", () => {
    const pair = { tokenIn: A, tokenOut: B, levels: [
      { input: "1", output: "1" },
      { input: "10", output: "1" },
    ] };
    const frame = buildPriceLevelsFrame([pair]);
    expect(parsePriceLevels(frame)).toEqual(frame);
    pair.levels[0]!.input = "0";
    expect(frame.levels[0]!.levels[0]!.input).toBe("1");
    expect(withdrawalPriceLevelsFrame()).toEqual({ type: "price-levels", levels: [] });
    expect(parseSolverCapabilities(buildSolverCapabilitiesFrame([B, A], 8))).toEqual({
      type: "solver-capabilities",
      tokenIds: [B, A],
      maxParallelSwaps: 8,
    });
    expect(() => buildSolverCapabilitiesFrame(["bad"])).toThrow(/not a token id/);
  });
});

describe("implemented work and state bounds", () => {
  test("adversarial 39,202-state monotone frontier keeps encoding bounded", () => {
    const book = Array.from({ length: 16 }, (_, index) => {
      const amount = 1n << BigInt(index);
      return offer(5_000 + index, amount, amount);
    });
    const started = performance.now();
    const derived = deriveLadder(book, OPTIONS);
    const elapsedMs = performance.now() - started;
    expect(derived.diagnostics.visitedSubsets).toBe(39_202);
    expect(derived.diagnostics.peakStoredExactInputs).toBe(39_202);
    expect(derived.diagnostics.pairs[0]!.reason).toBe("wire-point-cap");
    expect(elapsedMs).toBeLessThan(250);
    console.log(`A4 monotone-frontier: ${elapsedMs.toFixed(2)}ms, 39202 exact states`);
  });

  test("64-pair global-exhaustion refresh stops at 200,000 visits within 250ms", () => {
    // Warm the recursive search and BigInt map paths before measuring production-parity work.
    deriveLadder(Array.from({ length: 12 }, (_, index) => {
      const amount = 1n << BigInt(index);
      return offer(5_100 + index, amount, amount);
    }), OPTIONS);

    const book: LadderSourceOffer[] = [];
    for (let pairIndex = 0; pairIndex < 64; pairIndex += 1) {
      const tokenIn = token(10_000 + pairIndex * 2);
      const tokenOut = token(10_001 + pairIndex * 2);
      for (let offerIndex = 0; offerIndex < 20; offerIndex += 1) {
        const amount = 1n << BigInt(offerIndex);
        const id = 6_000 + pairIndex * 20 + offerIndex;
        book.push(offer(id, amount, amount, tokenIn, tokenOut));
      }
    }
    const started = performance.now();
    const derived = deriveLadder(book, OPTIONS);
    const elapsedMs = performance.now() - started;
    expect(derived.diagnostics.sourceOffersScanned).toBe(1_280);
    expect(derived.diagnostics.visitedSubsets).toBe(200_000);
    expect(derived.diagnostics.stopReason).toBe("global-search-cap");
    expect(derived.diagnostics.peakStoredExactInputs).toBeLessThanOrEqual(100_000);
    expect(derived.diagnostics.pairs).toHaveLength(64);
    expect(elapsedMs).toBeLessThan(250);
    console.log(
      `A4 full-refresh: ${elapsedMs.toFixed(2)}ms, 200000 visits, ` +
        `${derived.diagnostics.peakStoredExactInputs} peak exact states`,
    );
  });
});
