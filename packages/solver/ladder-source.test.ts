import { describe, expect, test } from "bun:test";

import type { ApiZswap } from "@zswap-da/solver-core/api-client";
import { parsePriceLevels, parseSolverCapabilities } from "@zswap-da/solver-core/relay-ws-contract";

import { Book, bookOfferFromApi } from "./src/book.ts";
import { LadderBook, interpolateQuote } from "./src/ladder.ts";
import { deriveLadderPush, type LadderCache } from "./src/ladder-source.ts";

// The frozen wire fixture's token ids, so the cache-driven ladder is directly
// comparable with the pinned relay contract.
const A = `01${"00".repeat(31)}`;
const B = `02${"00".repeat(31)}`;

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const EXPIRES = "2026-06-01T13:00:00.000Z";
const OPTIONS = { nowMs: NOW, expiryMarginSeconds: 60 };

const hash = (byte: string): string => byte.repeat(32);
const O1 = hash("11");
const O2 = hash("22");
const O3 = hash("33");

/** A REST row exactly as the backend serves it, so the ladder is derived from
 *  the real cache projection rather than a hand-built book object. */
const row = (offerId: string, givesA: string, wantsB: string): ApiZswap =>
  ({
    version: 1,
    offerId,
    computed: {
      gives: [{ token: A, amount: givesA, type: "SHIELDED" }],
      wants: [{ token: B, amount: wantsB, type: "SHIELDED" }],
      expiresAt: EXPIRES,
      firstSeenAt: "2026-06-01T11:00:00.000Z",
      inputNullifiers: [offerId],
      status: "live",
    },
  }) as ApiZswap;

/** The Q-R2-3 canonical book: `-10A +10B`, `-5A +5B`, `-20A +10B`. */
const CANONICAL_ROWS: ApiZswap[] = [
  row(O1, "10", "10"),
  row(O2, "5", "5"),
  row(O3, "20", "10"),
];

const seed = (rows: ApiZswap[]): Book => {
  const book = new Book();
  for (const entry of rows) book.upsert(bookOfferFromApi(entry)!);
  return book;
};

const cache = (book: Book, current = true): LadderCache => ({ book, isCurrent: () => current });


const FULL = [
  { input: "5", output: "5" }, { input: "9", output: "5" },
  { input: "10", output: "20" }, { input: "14", output: "20" },
  { input: "15", output: "25" }, { input: "19", output: "25" },
  { input: "20", output: "30" }, { input: "24", output: "30" },
  { input: "25", output: "35" }, { input: "250", output: "35" },
];
describe("whole-offer ladder source", () => {
  test("publishes the staircase, winning witnesses and terminal with validated frames", () => {
    const push = deriveLadderPush(cache(seed(CANONICAL_ROWS)), { ...OPTIONS, maxParallelSwaps: 8 });
    expect(push.withheld).toBeNull();
    expect(push.priceLevels.levels).toEqual([{ tokenIn: B, tokenOut: A, levels: FULL }]);
    expect(push.capabilities).toEqual({ type: "solver-capabilities", tokenIds: [A, B], maxParallelSwaps: 8 });
    expect(parsePriceLevels(push.priceLevels)).toEqual(push.priceLevels);
    expect(parseSolverCapabilities(push.capabilities)).toEqual(push.capabilities);
    expect(push.derived.provenance[0]!.combinations).toEqual([
      { input: "5", output: "5", offerHashes: [O2] },
      { input: "10", output: "20", offerHashes: [O3] },
      { input: "15", output: "25", offerHashes: [O2, O3] },
      { input: "20", output: "30", offerHashes: [O1, O3] },
      { input: "25", output: "35", offerHashes: [O1, O2, O3] },
    ]);
  });
  test("forwards admission policy and retains only admitted thresholds", () => {
    const allowed = deriveLadderPush(cache(seed(CANONICAL_ROWS)), {
      ...OPTIONS, supportedPairs: new Set([`${B}->${A}`]), minJobOutput: new Map([[A, 25n]]),
    });
    expect(allowed.priceLevels.levels[0]!.levels).toEqual(FULL.slice(4));
    expect(allowed.derived.provenance[0]!.combinations).toHaveLength(3);
    for (const policy of [{ supportedPairs: new Set([`${A}->${B}`]) }, { minJobOutput: new Map<string, bigint>() }]) {
      expect(deriveLadderPush(cache(seed(CANONICAL_ROWS)), { ...OPTIONS, ...policy }).priceLevels.levels).toEqual([]);
    }
  });
  test("order independent and relay interpolation evaluates constant plateaus", () => {
    const push = deriveLadderPush(cache(seed(CANONICAL_ROWS)), OPTIONS);
    expect(push).toEqual(deriveLadderPush(cache(seed([...CANONICAL_ROWS].reverse())), OPTIONS));
    const ladders = LadderBook.fromPairs(push.priceLevels.levels);
    for (const [input, output] of [[5n, 5n], [9n, 5n], [10n, 20n], [12n, 20n], [15n, 25n], [250n, 35n]]) {
      expect(ladders.maxPayout(B, A, input)).toBe(output);
      expect(interpolateQuote(push.priceLevels.levels[0]!.levels, input)).toBe(output);
    }
    expect(ladders.maxPayout(B, A, 251n)).toBeNull();
  });
  test("deletion and reservations replace witnesses on the next derivation", () => {
    const book = seed(CANONICAL_ROWS);
    const reserved = deriveLadderPush(cache(book), { ...OPTIONS, unavailableOfferHashes: [O3] });
    expect(reserved.derived.provenance[0]!.combinations).toEqual([
      { input: "5", output: "5", offerHashes: [O2] },
      { input: "10", output: "10", offerHashes: [O1] },
      { input: "15", output: "15", offerHashes: [O1, O2] },
    ]);
    expect(reserved.derived.excluded).toEqual([{ offerHash: O3, reason: "unavailable" }]);
    book.removeByNullifier(O3);
    expect(deriveLadderPush(cache(book), OPTIONS).priceLevels).toEqual(reserved.priceLevels);
  });
  test("empty, stale, expiring and aborted books withdraw with diagnostics", () => {
    expect(deriveLadderPush(cache(seed([])), OPTIONS).priceLevels.levels).toEqual([]);
    const stale = deriveLadderPush(cache(seed(CANONICAL_ROWS), false), OPTIONS);
    expect(stale.withheld).toBe("cache-not-current");
    expect(stale.capabilities.tokenIds).toEqual([]);
    const expired = deriveLadderPush(cache(seed(CANONICAL_ROWS)), { ...OPTIONS, nowMs: Date.parse(EXPIRES) - 60_000 });
    expect(expired.priceLevels.levels).toEqual([]);
    expect(expired.derived.excluded.every((entry) => entry.reason === "expiring")).toBe(true);
    const aborted = deriveLadderPush(cache(seed(CANONICAL_ROWS)), { ...OPTIONS, shouldAbort: () => true });
    expect(aborted.withheld).toBe("derivation-failed");
    expect(aborted.derived.diagnostics.stopReason).toBe("aborted");
  });
  test("source limit is enforced before any full copy, including lower controls", () => {
    const book = seed(CANONICAL_ROWS);
    book.all = () => { throw new Error("overlimit books must not be copied"); };
    const push = deriveLadderPush(cache(book), { ...OPTIONS, resourceLimits: { maxSourceOffers: 2 } });
    expect(push.priceLevels.levels).toEqual([]);
    expect(push.withheldReason).toBe("source-offer-cap");
    expect(push.derived.diagnostics).toMatchObject({ stopReason: "source-offer-cap", sourceOffersScanned: 0 });
    expect(push.derived.limits.maxSourceOffers).toBe(2);
  });
  test("search limits withhold unproved pairs; invalid limits never read the source", () => {
    const book = seed(CANONICAL_ROWS);
    const limited = deriveLadderPush(cache(book), { ...OPTIONS, resourceLimits: { maxVisitedSubsetsPerPair: 1 } });
    expect(limited.priceLevels.levels).toEqual([]);
    expect(limited.derived.diagnostics.pairs[0]!.reason).toBe("pair-search-cap");
    book.all = () => { throw new Error("invalid controls must not read the book"); };
    const invalid = deriveLadderPush(cache(book), { ...OPTIONS, resourceLimits: { maxWirePointsPerPair: 65 } });
    expect(invalid.derived.diagnostics.stopReason).toBe("invalid-resource-limit");
  });
});
