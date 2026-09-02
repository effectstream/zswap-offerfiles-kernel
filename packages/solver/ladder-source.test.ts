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

describe("ladder source — the cache is the only input", () => {
  test("RF3 pair allowlist and output minimum deterministically constrain publication", () => {
    const allowed = deriveLadderPush(cache(seed(CANONICAL_ROWS)), {
      ...OPTIONS,
      supportedPairs: new Set([`${B}->${A}`]),
      minJobOutput: new Map([[A, 25n]]),
    });
    expect(allowed.priceLevels.levels[0]!.levels).toEqual([
      { input: "20", output: "30" },
      { input: "25", output: "35" },
    ]);
    // Hidden sub-minimum rungs remain in provenance because they are whole
    // offers backing the first admitted cumulative quote.
    expect(allowed.derived.provenance[0]!.rungs).toHaveLength(3);

    const unsupported = deriveLadderPush(cache(seed(CANONICAL_ROWS)), {
      ...OPTIONS,
      supportedPairs: new Set([`${A}->${B}`]),
    });
    expect(unsupported.priceLevels.levels).toEqual([]);
    expect(unsupported.derived.excluded.map(({ reason }) => reason)).toEqual([
      "unsupported-pair", "unsupported-pair", "unsupported-pair",
    ]);

    const missingMinimum = deriveLadderPush(cache(seed(CANONICAL_ROWS)), {
      ...OPTIONS,
      minJobOutput: new Map(),
    });
    expect(missingMinimum.priceLevels.levels).toEqual([]);
    expect(missingMinimum.derived.excluded.map(({ reason }) => reason)).toEqual([
      "minimum-output", "minimum-output", "minimum-output",
    ]);
  });

  // RE-ENCODED at 00006-R2 (FR-003 / SC-002). Was "FR-003/FR-004 executability
  // budgets reach the derivation through the push", with a tokenIn matrix
  // (`[B, 24n]` → two rungs, `[B, 9n]` → nothing, one `mirror-budget` reason).
  // The tokenIn bound is gone — fee sizing spends no tokenIn — so the same
  // snapshots now publish the full ladder, and the tokenOut half is asserted
  // unchanged from a wallet that holds NO tokenIn at all.
  test("FR-003 the tokenOut budget reaches the derivation through the push, and tokenIn does not", () => {
    // The canonical book backs B→A, so tokenIn = B and tokenOut = A (what a
    // residual pays). Worst-case interval residuals are 9 (rung 2) and 4
    // (rung 3); cumulative inputs are 10/20/25.
    const rungs = (spendableInventory: ReadonlyMap<string, bigint>) =>
      deriveLadderPush(cache(seed(CANONICAL_ROWS)), { ...OPTIONS, spendableInventory })
        .priceLevels.levels[0]?.levels ?? [];

    // No tokenOut inventory still publishes the first rung: it opens no
    // interpolation interval, so FR-001's retained-surplus path stays quotable.
    // Asserted with tokenIn EXHAUSTED, which is 00006's operating mode.
    expect(rungs(new Map([[A, 0n], [B, 0n]]))).toEqual([{ input: "10", output: "20" }]);
    expect(rungs(new Map([[A, 9n], [B, 0n]]))).toHaveLength(3);
    // The old tokenIn matrix, inverted: 24 used to cap the ladder at the second
    // rung and 9 used to suppress the pair entirely. Neither bounds anything now.
    expect(rungs(new Map([[A, 1_000n], [B, 24n]]))).toHaveLength(3);
    expect(rungs(new Map([[A, 1_000n], [B, 9n]]))).toHaveLength(3);
    // SC-002: a wallet with NO tokenIn key at all publishes the full ladder.
    expect(rungs(new Map([[A, 1_000n]]))).toHaveLength(3);
    // Absent is OPEN — the pre-budget contract, which dry-run still relies on.
    expect(deriveLadderPush(cache(seed(CANONICAL_ROWS)), OPTIONS)
      .priceLevels.levels[0]!.levels).toHaveLength(3);

    // A withheld rung is reported as DATA, so the push loop can turn it into a
    // loud operator signal rather than a silent trim. Truncation is total: the
    // rung after a withheld one carries the same reason, because a whole-offer
    // cumulative ladder can be cut but not punctured.
    const reasonsFor = (spendableInventory: ReadonlyMap<string, bigint>) =>
      deriveLadderPush(cache(seed(CANONICAL_ROWS)), { ...OPTIONS, spendableInventory })
        .derived.excluded.map(({ reason }) => reason);
    expect(reasonsFor(new Map([[A, 0n], [B, 0n]])))
      .toEqual(["residual-budget", "residual-budget"]);
    // Was `["mirror-budget"]`: nothing is withheld for a tokenIn reason.
    expect(reasonsFor(new Map([[A, 1_000n], [B, 24n]]))).toEqual([]);
    // SC-002, the uncapitalized solver end to end through the push: the
    // whole-maker rung publishes, the interior rungs are withheld by F03 alone.
    const empty = deriveLadderPush(cache(seed(CANONICAL_ROWS)), {
      ...OPTIONS,
      spendableInventory: new Map(),
    });
    expect(empty.withheld).toBeNull();
    expect(empty.priceLevels.levels[0]!.levels).toEqual([{ input: "10", output: "20" }]);
    expect(empty.capabilities.tokenIds).toEqual([A, B]);
    expect(empty.derived.excluded.map(({ reason }) => reason))
      .toEqual(["residual-budget", "residual-budget"]);
  });

  test("a seeded book pushes exactly the canonical ladder and its capabilities", () => {
    const push = deriveLadderPush(cache(seed(CANONICAL_ROWS)), { ...OPTIONS, maxParallelSwaps: 8 });

    expect(push.withheld).toBeNull();
    expect(push.priceLevels.levels).toEqual([
      {
        tokenIn: B,
        tokenOut: A,
        levels: [
          { input: "10", output: "20" },
          { input: "20", output: "30" },
          { input: "25", output: "35" },
        ],
      },
    ]);
    expect(push.capabilities).toEqual({
      type: "solver-capabilities",
      tokenIds: [A, B],
      maxParallelSwaps: 8,
    });
    // Both frames are what the relay itself would admit.
    expect(parsePriceLevels(push.priceLevels)).toEqual(push.priceLevels);
    expect(parseSolverCapabilities(push.capabilities)).toEqual(push.capabilities);
  });

  test("byte-reproducible from the same cache state, whatever order it was built in", () => {
    const forward = deriveLadderPush(cache(seed(CANONICAL_ROWS)), OPTIONS);
    const reverse = deriveLadderPush(cache(seed([...CANONICAL_ROWS].reverse())), OPTIONS);
    expect(JSON.stringify(forward.priceLevels)).toBe(JSON.stringify(reverse.priceLevels));
    expect(JSON.stringify(forward.capabilities)).toBe(JSON.stringify(reverse.capabilities));
  });

  test("the derived ladder loads into the engine's own LadderBook and quotes identically", () => {
    const push = deriveLadderPush(cache(seed(CANONICAL_ROWS)), OPTIONS);
    // `ladder.ts`/`ladder-schema` were retained by N1 for exactly this: one
    // rung/interpolation vocabulary, so what the solver publishes and what it
    // prices against cannot drift apart.
    const ladders = LadderBook.fromPairs(push.priceLevels.levels);
    for (const size of [10n, 12n, 15n, 20n, 25n]) {
      expect(ladders.maxPayout(B, A, size)).toBe(
        interpolateQuote(push.priceLevels.levels[0]!.levels, size),
      );
    }
    expect(ladders.maxPayout(B, A, 12n)).toBe(22n);
    expect(ladders.maxPayout(A, B, 12n)).toBeNull();
  });
});

describe("ladder source — book changes and fail-closed withholding", () => {
  test("a consumed offer is gone from the very next derivation (FR-014 cadence)", () => {
    const book = seed(CANONICAL_ROWS);
    expect(deriveLadderPush(cache(book), OPTIONS).priceLevels.levels[0]!.levels).toHaveLength(3);

    // The mirror applies `offer_consumed` by nullifier; the best-rate rung
    // disappears with it.
    expect(book.removeByNullifier(O3)).toEqual([O3]);
    const after = deriveLadderPush(cache(book), OPTIONS);
    expect(after.priceLevels.levels[0]!.levels).toEqual([
      { input: "10", output: "10" },
      { input: "15", output: "15" },
    ]);
    expect(after.derived.provenance[0]!.rungs.map((rung) => rung.offerHash)).toEqual([O1, O2]);
  });

  test("an emptied book withdraws instead of publishing a stale ladder", () => {
    const book = seed(CANONICAL_ROWS);
    for (const offerHash of [O1, O2, O3]) book.remove(offerHash);
    const push = deriveLadderPush(cache(book), OPTIONS);
    expect(push.withheld).toBeNull();
    expect(push.priceLevels).toEqual({ type: "price-levels", levels: [] });
    expect(push.capabilities.tokenIds).toEqual([]);
  });

  test("a cache that is not current publishes nothing at all (FR-005, downstream half)", () => {
    const book = seed(CANONICAL_ROWS);
    const push = deriveLadderPush(cache(book, false), { ...OPTIONS, maxParallelSwaps: 8 });

    expect(push.withheld).toBe("cache-not-current");
    // Not silence: the relay has no version or tombstone concept, so a stale
    // ladder would keep quoting. Withholding IS the explicit empty push.
    expect(push.priceLevels).toEqual({ type: "price-levels", levels: [] });
    expect(push.capabilities).toEqual({
      type: "solver-capabilities",
      tokenIds: [],
      maxParallelSwaps: 8,
    });
    expect(push.derived.levels).toEqual([]);
    expect(parsePriceLevels(push.priceLevels)).toEqual(push.priceLevels);
    // The book itself is untouched — currentness gates publication, not the
    // cache, so it recovers without a resnapshot.
    expect(book.size).toBe(3);
    expect(deriveLadderPush(cache(book), OPTIONS).priceLevels.levels).toHaveLength(1);
  });

  test("offers claimed by an in-flight fill do not back a published rung", () => {
    // The claim set comes from `Stock` at push time (N4 wires it); derivation
    // stays pure and takes it as a parameter.
    const push = deriveLadderPush(cache(seed(CANONICAL_ROWS)), {
      ...OPTIONS,
      unavailableOfferHashes: [O3],
    });
    expect(push.priceLevels.levels[0]!.levels).toEqual([
      { input: "10", output: "10" },
      { input: "15", output: "15" },
    ]);
    expect(push.derived.excluded).toEqual([{ offerHash: O3, reason: "unavailable" }]);
  });

  test("an offer inside the expiry margin stops backing rungs before it dies", () => {
    const book = seed(CANONICAL_ROWS);
    const justInsideMargin = Date.parse(EXPIRES) - 60_000;
    const push = deriveLadderPush(cache(book), {
      nowMs: justInsideMargin,
      expiryMarginSeconds: 60,
    });
    expect(push.priceLevels.levels).toEqual([]);
    expect(push.derived.excluded.map((entry) => entry.reason)).toEqual([
      "expiring",
      "expiring",
      "expiring",
    ]);
    // One millisecond earlier they are all still publishable.
    expect(
      deriveLadderPush(cache(book), { nowMs: justInsideMargin - 1, expiryMarginSeconds: 60 })
        .priceLevels.levels[0]!.levels,
    ).toHaveLength(3);
  });
});
