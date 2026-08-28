import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { admissionPairKey } from "./admission-policy.ts";
import {
  buildPriceLevelsFrame,
  buildSolverCapabilitiesFrame,
  deriveLadder,
  withdrawalPriceLevelsFrame,
  worstCaseIntervalResidual,
  type LadderSourceOffer,
} from "./ladder-derivation.ts";
import { rejectLevels } from "./ladder-schema.ts";
import {
  interpolateQuote,
  isPriceLevelsPair,
  parsePriceLevels,
  parseSolverCapabilities,
} from "./relay-ws-contract.ts";

// Same two token ids as the frozen N0 wire fixture, so the derived frame and
// the pinned one are directly comparable.
const A = `01${"00".repeat(31)}`;
const B = `02${"00".repeat(31)}`;
const C = `03${"00".repeat(31)}`;

const NOW = 1_700_000_000_000;
const MARGIN_SECONDS = 60;
const FAR_FUTURE = NOW + 3_600_000;

const hash = (byte: string): string => byte.repeat(32);
const O1 = hash("11");
const O2 = hash("22");
const O3 = hash("33");

let nullifierSeed = 0;
const nextNullifier = (): string => {
  nullifierSeed += 1;
  return nullifierSeed.toString(16).padStart(64, "0");
};

/** A native shielded single-leg maker offer: gives `outAmount` of `tokenOut`,
 *  wants `inAmount` of `tokenIn`. It backs the tokenIn→tokenOut ladder only. */
const offer = (
  offerHash: string,
  tokenOut: string,
  outAmount: bigint,
  tokenIn: string,
  inAmount: bigint,
  overrides: Partial<LadderSourceOffer> = {},
): LadderSourceOffer => ({
  offerHash,
  gives: [{ token: tokenOut, amount: outAmount, kind: "SHIELDED" }],
  wants: [{ token: tokenIn, amount: inAmount, kind: "SHIELDED" }],
  expiresAt: FAR_FUTURE,
  inputNullifiers: [nextNullifier()],
  ...overrides,
});

const OPTIONS = { nowMs: NOW, expiryMarginSeconds: MARGIN_SECONDS };

/**
 * The canonical worked example from plan question Q-R2-3 (user's book,
 * 2026-08-20): `-10A +10B`, `-5A +5B`, `-20A +10B`. All three GIVE A and WANT
 * B, so they back the B→A ladder only and A→B must be omitted entirely.
 */
const CANONICAL_BOOK = (): LadderSourceOffer[] => [
  offer(O1, A, 10n, B, 10n),
  offer(O2, A, 5n, B, 5n),
  offer(O3, A, 20n, B, 10n),
];

describe("ladder derivation — the canonical provenance fixture", () => {
  test("a seeded book derives exactly the Q-R2-3 rungs, and the unbacked direction is omitted", () => {
    const derived = deriveLadder(CANONICAL_BOOK(), OPTIONS);

    expect(derived.levels).toHaveLength(1);
    const pair = derived.levels[0]!;
    expect(pair.tokenIn).toBe(B);
    expect(pair.tokenOut).toBe(A);
    // {o3} → {o1} → {o2}: best marginal rate first (2 A/B, then the two 1 A/B
    // offers ordered by the documented tie rule, ascending offerHash).
    expect(pair.levels).toEqual([
      { input: "10", output: "20" },
      { input: "20", output: "30" },
      { input: "25", output: "35" },
    ]);
    // Nothing gives B, so nothing backs A→B. Omitted, never published empty.
    expect(derived.levels.some((entry) => entry.tokenIn === A)).toBe(false);
    expect(derived.excluded).toEqual([]);
  });

  test("consumption order is best-marginal-rate-first, recorded rung by rung", () => {
    const { provenance } = deriveLadder(CANONICAL_BOOK(), OPTIONS);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]!.rungs).toEqual([
      { input: "10", output: "20", offerHash: O3 },
      { input: "20", output: "30", offerHash: O1 },
      { input: "25", output: "35", offerHash: O2 },
    ]);
    // The most tokenOut any single offer pays: the ceiling on the inventory an
    // interpolated between-rung size can need.
    expect(provenance[0]!.residualBound).toBe("20");
  });

  test("capabilities come from the same cache: the union of published pairs' tokens", () => {
    const { tokenIds } = deriveLadder(CANONICAL_BOOK(), OPTIONS);
    expect(tokenIds).toEqual([A, B]);
    expect(parseSolverCapabilities(buildSolverCapabilitiesFrame(tokenIds, 8))).toEqual({
      type: "solver-capabilities",
      tokenIds: [A, B],
      maxParallelSwaps: 8,
    });
  });

  test("a token whose only pair is omitted never reaches capabilities", () => {
    // A multi-leg offer is the only thing mentioning C, and multi-leg offers
    // cannot be described by a directed ladder.
    const book = [
      ...CANONICAL_BOOK(),
      {
        ...offer(hash("44"), C, 7n, B, 7n),
        gives: [
          { token: C, amount: 7n, kind: "SHIELDED" as const },
          { token: A, amount: 1n, kind: "SHIELDED" as const },
        ],
      },
    ];
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.tokenIds).toEqual([A, B]);
    expect(derived.excluded).toEqual([{ offerHash: hash("44"), reason: "multi-leg" }]);
  });
});

describe("ladder derivation — determinism", () => {
  test("byte-reproducible from the same cache state, in any input order", () => {
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const rendered = permutations.map((order) => {
      const book = CANONICAL_BOOK();
      const derived = deriveLadder(
        order.map((index) => book[index]!),
        OPTIONS,
      );
      return JSON.stringify(buildPriceLevelsFrame(derived.levels));
    });
    expect(new Set(rendered).size).toBe(1);
    // And the bytes themselves, so a future reordering of the emitter is caught.
    expect(rendered[0]).toBe(
      `{"type":"price-levels","levels":[{"tokenIn":"${B}","tokenOut":"${A}",` +
        `"levels":[{"input":"10","output":"20"},{"input":"20","output":"30"},` +
        `{"input":"25","output":"35"}]}]}`,
    );
  });

  test("pairs and capabilities are emitted in sorted order, not insertion order", () => {
    const book = [
      offer(hash("aa"), C, 4n, B, 2n),
      offer(hash("bb"), A, 4n, C, 2n),
      offer(hash("cc"), B, 4n, A, 2n),
    ];
    const forward = deriveLadder(book, OPTIONS);
    const reversed = deriveLadder([...book].reverse(), OPTIONS);
    expect(forward.levels.map((pair) => [pair.tokenIn, pair.tokenOut])).toEqual([
      [A, B],
      [B, C],
      [C, A],
    ]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.tokenIds).toEqual([A, B, C]);
  });

  test("the tie rule is the ONLY thing that moves the boundaries, and both are honourable", () => {
    // Same three offers, o1 and o2's content addresses swapped, so the tie
    // resolves the other way: {o3} → {o2} → {o1}.
    const swapped = [
      offer(O2, A, 10n, B, 10n),
      offer(O1, A, 5n, B, 5n),
      offer(O3, A, 20n, B, 10n),
    ];
    const derived = deriveLadder(swapped, OPTIONS);
    expect(derived.levels[0]!.levels).toEqual([
      { input: "10", output: "20" },
      { input: "15", output: "25" },
      { input: "25", output: "35" },
    ]);
    // Different rungs, identical quotes: both are subsets of the same concave
    // whole-offer frontier, which is why Q-R2-3 blesses either.
    const canonical = deriveLadder(CANONICAL_BOOK(), OPTIONS).levels[0]!.levels;
    for (let size = 10n; size <= 25n; size += 1n) {
      expect(interpolateQuote(derived.levels[0]!.levels, size)).toBe(
        interpolateQuote(canonical, size),
      );
    }
  });
});

describe("ladder derivation — the frozen relay wire contract", () => {
  const frozen = JSON.parse(
    readFileSync(new URL("./fixtures/relay-ws/v1/price-levels.json", import.meta.url), "utf8"),
  ) as unknown;

  test("derived frames pass the relay's own admission predicates", () => {
    const derived = deriveLadder(CANONICAL_BOOK(), OPTIONS);
    const frame = buildPriceLevelsFrame(derived.levels);
    expect(parsePriceLevels(frame)).toEqual(frame);
    for (const pair of frame.levels) expect(isPriceLevelsPair(pair)).toBe(true);
    // And the strict schema the solver shares with its own quoting code.
    for (const pair of frame.levels) expect(rejectLevels(pair.levels)).toBeNull();
  });

  test("the derived ladder quotes exactly like the frozen fixture, everywhere", () => {
    const parsedFrozen = parsePriceLevels(frozen);
    expect(parsedFrozen).not.toBeNull();
    const frozenLevels = parsedFrozen!.levels[0]!;
    const derived = deriveLadder(CANONICAL_BOOK(), OPTIONS).levels[0]!;

    expect(derived.tokenIn).toBe(frozenLevels.tokenIn);
    expect(derived.tokenOut).toBe(frozenLevels.tokenOut);
    // The fixture is the FRONTIER with both tie boundaries; the derivation
    // publishes one consumption order's subset of it. Q-R2-3: any
    // strictly-ascending subset of frontier points is equally valid, and here
    // that claim is checked rather than argued — every size the relay will
    // quote gets the same answer from both.
    for (let size = 0n; size <= 40n; size += 1n) {
      expect(interpolateQuote(derived.levels, size)).toBe(
        interpolateQuote(frozenLevels.levels, size),
      );
    }
  });

  test("reproduces the N0 gate's pinned quote points", () => {
    const levels = deriveLadder(CANONICAL_BOOK(), OPTIONS).levels[0]!.levels;
    expect(interpolateQuote(levels, 10n)).toBe(20n);
    expect(interpolateQuote(levels, 12n)).toBe(22n);
    expect(interpolateQuote(levels, 15n)).toBe(25n);
    expect(interpolateQuote(levels, 20n)).toBe(30n);
    expect(interpolateQuote(levels, 25n)).toBe(35n);
    // Outside the ladder the relay refuses: the first rung is the minimum
    // trade and the last is the maximum.
    expect(interpolateQuote(levels, 9n)).toBeNull();
    expect(interpolateQuote(levels, 26n)).toBeNull();
  });
});

describe("ladder derivation — honourability", () => {
  /** Every rung is an exact whole-offer sum of a PREFIX of the consumption
   *  order: no rung needs a single unit of solver inventory. */
  const assertRungsAreWholeOfferSums = (
    book: LadderSourceOffer[],
    options = OPTIONS,
  ): void => {
    const derived = deriveLadder(book, options);
    const byHash = new Map(book.map((entry) => [entry.offerHash.toLowerCase(), entry]));
    for (const pair of derived.provenance) {
      let cumulativeIn = 0n;
      let cumulativeOut = 0n;
      for (const rung of pair.rungs) {
        const source = byHash.get(rung.offerHash)!;
        cumulativeIn += source.wants[0]!.amount;
        cumulativeOut += source.gives[0]!.amount;
        expect(rung.input).toBe(cumulativeIn.toString());
        expect(rung.output).toBe(cumulativeOut.toString());
      }
    }
  };

  test("every canonical rung is an exact whole-offer sum", () => {
    assertRungsAreWholeOfferSums(CANONICAL_BOOK());
  });

  test("every rung of a many-offer, many-rate book is an exact whole-offer sum", () => {
    const book = Array.from({ length: 12 }, (_, index) =>
      offer(
        hash((0x40 + index).toString(16)),
        A,
        BigInt(1_000 - index * 37),
        B,
        BigInt(100 + index),
      ),
    );
    assertRungsAreWholeOfferSums(book);
    const derived = deriveLadder(book, OPTIONS);
    expect(derived.levels[0]!.levels).toHaveLength(12);
    // Sorted best-marginal-rate-first ⇒ concave, which is the assumption
    // behind the relay's interpolation. Proven, not assumed.
    expect(rejectLevels(derived.levels[0]!.levels)).toBeNull();
  });

  test("between rungs the quote is a whole-offer prefix plus a residual at the NEXT offer's own rate", () => {
    // Deliberately non-collinear: three different marginal rates.
    const book = [
      offer(hash("a1"), A, 30n, B, 10n),
      offer(hash("a2"), A, 20n, B, 10n),
      offer(hash("a3"), A, 10n, B, 10n),
    ];
    const derived = deriveLadder(book, OPTIONS);
    const levels = derived.levels[0]!.levels;
    expect(levels).toEqual([
      { input: "10", output: "30" },
      { input: "20", output: "50" },
      { input: "30", output: "60" },
    ]);

    const residualBound = BigInt(derived.provenance[0]!.residualBound);
    const first = BigInt(levels[0]!.input);
    const last = BigInt(levels[levels.length - 1]!.input);
    for (let size = first; size <= last; size += 1n) {
      const quote = interpolateQuote(levels, size)!;
      let index = 0;
      while (index + 1 < levels.length && BigInt(levels[index + 1]!.input) <= size) index += 1;
      const prefixIn = BigInt(levels[index]!.input);
      const prefixOut = BigInt(levels[index]!.output);
      if (prefixIn === size) {
        // An exact rung: whole offers, zero inventory.
        expect(quote).toBe(prefixOut);
        continue;
      }
      const deltaIn = BigInt(levels[index + 1]!.input) - prefixIn;
      const deltaOut = BigInt(levels[index + 1]!.output) - prefixOut;
      const residualIn = size - prefixIn;
      // The chord's slope IS the next offer's marginal rate, so the solver
      // self-fills the partial offer at that offer's own price.
      expect(quote).toBe(prefixOut + (deltaOut * residualIn) / deltaIn);
      const residualOut = quote - prefixOut;
      expect(residualOut).toBeGreaterThan(0n);
      // Strictly less than one whole offer's payout, and never more than the
      // published bound. That bound is what N5's job matrix checks solver
      // inventory against; when it is not there the job fails CLOSED with
      // `job-error` (N5 owns that assertion — see plan phase N5).
      expect(residualOut).toBeLessThan(deltaOut);
      expect(residualOut).toBeLessThanOrEqual(residualBound);
    }
  });

  test("a size below the first rung is refused rather than served from inventory", () => {
    // Q-R2-3's recorded consequence: `-5A +5B` alone could serve 5 B, but rate
    // ordering — not size — fixes rung positions, so small trades are refused
    // until an inventory-backed leading rung exists (deferred optimization).
    const levels = deriveLadder(CANONICAL_BOOK(), OPTIONS).levels[0]!.levels;
    expect(interpolateQuote(levels, 5n)).toBeNull();
  });
});

describe("ladder derivation — fail closed", () => {
  const reasonsFor = (book: LadderSourceOffer[]): string[] =>
    deriveLadder(book, OPTIONS).excluded.map((entry) => entry.reason);

  test("unsupported offer shapes are excluded, never guessed at", () => {
    const base = offer(hash("55"), A, 10n, B, 10n);
    const cases: Array<[string, LadderSourceOffer]> = [
      ["multi-leg", { ...base, wants: [...base.wants, { token: C, amount: 1n, kind: "SHIELDED" }] }],
      ["non-shielded-leg", { ...base, gives: [{ token: A, amount: 10n, kind: "UNSHIELDED" }] }],
      ["non-shielded-leg", { ...base, wants: [{ token: B, amount: 10n, kind: "UNSHIELDED" }] }],
      ["non-positive-amount", { ...base, gives: [{ token: A, amount: 0n, kind: "SHIELDED" }] }],
      ["non-positive-amount", { ...base, wants: [{ token: B, amount: -1n, kind: "SHIELDED" }] }],
      ["same-token", { ...base, wants: [{ token: A, amount: 10n, kind: "SHIELDED" }] }],
      ["malformed-token", { ...base, gives: [{ token: "not-a-color", amount: 10n, kind: "SHIELDED" }] }],
      ["malformed-hash", { ...base, offerHash: "short" }],
      ["malformed-nullifier", { ...base, inputNullifiers: ["nope"] }],
      ["no-expiry", { ...base, expiresAt: null }],
      // Inside the settlement safety margin: it cannot be honoured at job time.
      ["expiring", { ...base, expiresAt: NOW + MARGIN_SECONDS * 1000 }],
    ];
    for (const [reason, entry] of cases) {
      const derived = deriveLadder([entry], OPTIONS);
      expect(derived.excluded.map((item) => item.reason)).toEqual([reason]);
      expect(derived.levels).toEqual([]);
      expect(derived.tokenIds).toEqual([]);
    }
    // One tick outside the margin is publishable — the boundary is the rule,
    // not a rounding accident.
    expect(
      deriveLadder([{ ...base, expiresAt: NOW + MARGIN_SECONDS * 1000 + 1 }], OPTIONS).levels,
    ).toHaveLength(1);
  });

  test("offers claimed by an in-flight fill are excluded", () => {
    const derived = deriveLadder(CANONICAL_BOOK(), {
      ...OPTIONS,
      unavailableOfferHashes: [O3.toUpperCase()],
    });
    expect(reasonsFor(CANONICAL_BOOK())).toEqual([]);
    expect(derived.excluded).toEqual([{ offerHash: O3, reason: "unavailable" }]);
    // Without the best-rate offer the ladder is the remaining frontier, still
    // exact whole-offer sums.
    expect(derived.levels[0]!.levels).toEqual([
      { input: "10", output: "10" },
      { input: "15", output: "15" },
    ]);
  });

  test("a cache with nothing publishable yields the empty withdrawal, not a padded ladder", () => {
    const derived = deriveLadder(
      [{ ...offer(hash("66"), A, 10n, B, 10n), expiresAt: NOW }],
      OPTIONS,
    );
    expect(derived.levels).toEqual([]);
    expect(derived.tokenIds).toEqual([]);
    const frame = withdrawalPriceLevelsFrame();
    expect(frame).toEqual({ type: "price-levels", levels: [] });
    expect(parsePriceLevels(frame)).toEqual(frame);
    expect(deriveLadder([], OPTIONS)).toEqual({
      levels: [],
      tokenIds: [],
      provenance: [],
      excluded: [],
    });
  });
});

describe("ladder derivation — R-07 aggregate budget over shared coins", () => {
  test("one coin backs at most one published rung, across all pairs", () => {
    // Two conflicting views of the same coin, in DIFFERENT directed pairs.
    // Published independently, each pair looks honourable; together they
    // advertise liquidity that can never both settle.
    const coin = nextNullifier();
    const toA = offer(hash("77"), A, 10n, B, 10n, { inputNullifiers: [coin] });
    const toC = offer(hash("88"), C, 12n, B, 10n, { inputNullifiers: [coin] });

    const derived = deriveLadder([toA, toC], OPTIONS);
    expect(derived.levels).toHaveLength(1);
    // The retained claimant is the smaller content address; stable, and the
    // conflict already means only one of them can ever settle.
    expect(derived.levels[0]!.tokenOut).toBe(A);
    expect(derived.excluded).toEqual([{ offerHash: hash("88"), reason: "shared-coin" }]);
    expect(derived.tokenIds).toEqual([A, B]);

    // Order-independent: the same coin wins either way.
    expect(JSON.stringify(deriveLadder([toC, toA], OPTIONS))).toBe(JSON.stringify(derived));
  });

  test("depth on one pair counts a shared coin once, not twice", () => {
    const coin = nextNullifier();
    const derived = deriveLadder(
      [
        offer(hash("91"), A, 10n, B, 10n, { inputNullifiers: [coin] }),
        offer(hash("92"), A, 9n, B, 10n, { inputNullifiers: [coin] }),
        offer(hash("93"), A, 8n, B, 10n),
      ],
      OPTIONS,
    );
    // Not 30 B deep: the conflicting pair is one coin, so the ladder stops at
    // the two independent offers.
    expect(derived.levels[0]!.levels).toEqual([
      { input: "10", output: "10" },
      { input: "20", output: "18" },
    ]);
    expect(derived.excluded).toEqual([{ offerHash: hash("92"), reason: "shared-coin" }]);
  });

  test("distinct coins are never treated as a conflict", () => {
    const derived = deriveLadder(
      [offer(hash("94"), A, 10n, B, 10n), offer(hash("95"), C, 12n, B, 10n)],
      OPTIONS,
    );
    expect(derived.levels).toHaveLength(2);
    expect(derived.excluded).toEqual([]);
    expect(derived.tokenIds).toEqual([A, B, C]);
  });
});

describe("ladder derivation — bounds", () => {
  test("a pair deeper than the rung cap publishes its best-rate prefix", () => {
    const book = Array.from({ length: 5 }, (_, index) =>
      offer(hash((0xb0 + index).toString(16)), A, BigInt(50 - index), B, 10n),
    );
    const derived = deriveLadder(book, { ...OPTIONS, maxRungsPerPair: 3 });
    expect(derived.levels[0]!.levels).toEqual([
      { input: "10", output: "50" },
      { input: "20", output: "99" },
      { input: "30", output: "147" },
    ]);
    expect(rejectLevels(derived.levels[0]!.levels)).toBeNull();
    expect(derived.excluded).toEqual([
      { offerHash: hash("b3"), reason: "rung-cap" },
      { offerHash: hash("b4"), reason: "rung-cap" },
    ]);
  });

  test("pairs past the cap are dropped whole, with their offers accounted for", () => {
    const derived = deriveLadder(
      [
        offer(hash("c1"), B, 4n, A, 2n),
        offer(hash("c2"), C, 4n, B, 2n),
        offer(hash("c3"), A, 4n, C, 2n),
      ],
      { ...OPTIONS, maxPairs: 2 },
    );
    expect(derived.levels.map((pair) => [pair.tokenIn, pair.tokenOut])).toEqual([
      [A, B],
      [B, C],
    ]);
    expect(derived.excluded).toEqual([{ offerHash: hash("c3"), reason: "pair-cap" }]);
    // C survives in capabilities only because the SURVIVING B→C pair still
    // pays it out — not because its own dropped pair was published.
    expect(derived.tokenIds).toEqual([A, B, C]);
  });

  test("a cumulative total past the wire's u256 ceiling skips that offer, keeping the rest", () => {
    const huge = (1n << 255n) + 7n;
    const derived = deriveLadder(
      [
        offer(hash("d1"), A, huge, B, huge),
        offer(hash("d2"), A, huge, B, huge),
        offer(hash("d3"), A, 5n, B, 10n),
      ],
      OPTIONS,
    );
    // d1 and d2 are the same rate, so the tie rule takes d1 first; d2's
    // cumulative total would not fit in the wire's u256 amount, so it is
    // skipped — and derivation CONTINUES, because the offers are already in
    // descending-rate order, so any subset of them is still concave and still
    // a set of exact whole-offer sums.
    expect(derived.levels[0]!.levels).toEqual([
      { input: huge.toString(), output: huge.toString() },
      { input: (huge + 10n).toString(), output: (huge + 5n).toString() },
    ]);
    expect(derived.excluded).toEqual([{ offerHash: hash("d2"), reason: "rung-cap" }]);
    expect(rejectLevels(derived.levels[0]!.levels)).toBeNull();
  });
});

describe("ladder derivation — the invariants hold over a generated corpus", () => {
  /** Seeded mulberry32: a deterministic corpus, so a failure is reproducible
   *  from the seed alone rather than being a flake nobody can re-run. (A plain
   *  LCG was tried first and its low-order bits are periodic — `% 4` never
   *  fired, and the shared-coin case silently went untested. Measured, then
   *  replaced.) */
  const mulberry32 = (seed: number) => {
    let state = seed >>> 0;
    return (bound: number): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) % bound;
    };
  };

  test("240 generated books: every emitted frame is admissible, honourable and order-independent", () => {
    const next = mulberry32(20260820);
    const tokens = [A, B, C];

    for (let iteration = 0; iteration < 240; iteration += 1) {
      const book: LadderSourceOffer[] = [];
      const coins: string[] = [];
      const count = 1 + next(12);
      for (let index = 0; index < count; index += 1) {
        // Most offers land on one hot pair, so ladders get deep enough for the
        // ordering and concavity invariants to have something to say; the rest
        // scatter, including the degenerate same-token shape.
        const hot = next(10) < 7;
        const outToken = hot ? A : tokens[next(3)]!;
        const inToken = hot
          ? B
          : next(4) === 0
            ? outToken
            : tokens[(tokens.indexOf(outToken) + 1 + next(2)) % 3]!;
        // Reuse an earlier coin sometimes, so the aggregate-budget rule is
        // exercised rather than assumed absent.
        const coin =
          coins.length > 0 && next(4) === 0 ? coins[next(coins.length)]! : nextNullifier();
        coins.push(coin);
        const entry = offer(
          `${iteration.toString(16).padStart(4, "0")}${index.toString(16).padStart(2, "0")}`.padEnd(64, "0"),
          outToken,
          BigInt(1 + next(1_000)),
          inToken,
          BigInt(1 + next(1_000)),
          { inputNullifiers: [coin] },
        );
        // Sprinkle in the shapes derivation must refuse.
        if (next(11) === 0) entry.gives = [{ token: outToken, amount: 5n, kind: "UNSHIELDED" }];
        if (next(13) === 0) entry.expiresAt = NOW;
        if (next(17) === 0) {
          entry.gives = [
            { token: outToken, amount: 5n, kind: "SHIELDED" },
            { token: inToken, amount: 5n, kind: "SHIELDED" },
          ];
        }
        book.push(entry);
      }

      const derived = deriveLadder(book, OPTIONS);
      const byHash = new Map(book.map((entry) => [entry.offerHash, entry]));

      // 1. Every emitted pair is admissible to the relay AND to the strict
      //    schema, so no derivable book can produce a frame that the relay
      //    would silently discard (which would freeze the previous ladder).
      const frame = buildPriceLevelsFrame(derived.levels);
      expect(parsePriceLevels(frame)).toEqual(frame);
      for (const pair of derived.levels) expect(rejectLevels(pair.levels)).toBeNull();

      // 2. Every rung is an exact whole-offer sum of a prefix of that pair's
      //    consumption order, and the order is best-marginal-rate-first.
      const publishedCoins = new Set<string>();
      for (const pair of derived.provenance) {
        let cumulativeIn = 0n;
        let cumulativeOut = 0n;
        let previousOut = 0n;
        let previousIn = 0n;
        for (const rung of pair.rungs) {
          const source = byHash.get(rung.offerHash)!;
          cumulativeIn += source.wants[0]!.amount;
          cumulativeOut += source.gives[0]!.amount;
          expect(rung.input).toBe(cumulativeIn.toString());
          expect(rung.output).toBe(cumulativeOut.toString());
          if (previousIn > 0n) {
            // Rate non-increasing, by cross-multiplication.
            expect(source.gives[0]!.amount * previousIn).toBeLessThanOrEqual(
              previousOut * source.wants[0]!.amount,
            );
          }
          previousIn = source.wants[0]!.amount;
          previousOut = source.gives[0]!.amount;
          // 3. R-07: one coin backs at most one published rung, across pairs.
          for (const coin of source.inputNullifiers) {
            expect(publishedCoins.has(coin)).toBe(false);
            publishedCoins.add(coin);
          }
        }
      }

      // 4. Capabilities are exactly the union of published pairs' tokens.
      expect(derived.tokenIds).toEqual(
        [...new Set(derived.levels.flatMap((pair) => [pair.tokenIn, pair.tokenOut]))].sort(),
      );

      // 5. Order-independence: reversing the cache changes nothing.
      expect(JSON.stringify(deriveLadder([...book].reverse(), OPTIONS))).toBe(
        JSON.stringify(derived),
      );
    }
  });
});

describe("ladder frames — malformed output is unrepresentable", () => {
  const okPair = { tokenIn: B, tokenOut: A, levels: [{ input: "10", output: "20" }] };

  test("the builder refuses every frame the relay would discard or the schema rejects", () => {
    expect(() => buildPriceLevelsFrame([{ ...okPair, levels: [] }])).toThrow(/empty/);
    expect(() =>
      buildPriceLevelsFrame([
        { ...okPair, levels: [{ input: "10", output: "20" }, { input: "10", output: "30" }] },
      ]),
    ).toThrow(/input-not-ascending/);
    expect(() =>
      buildPriceLevelsFrame([
        { ...okPair, levels: [{ input: "10", output: "20" }, { input: "20", output: "20" }] },
      ]),
    ).toThrow(/output-not-ascending/);
    // Convex: the relay's interpolation would promise more than the book holds.
    expect(() =>
      buildPriceLevelsFrame([
        {
          ...okPair,
          levels: [
            { input: "10", output: "10" },
            { input: "20", output: "21" },
            { input: "30", output: "33" },
          ],
        },
      ]),
    ).toThrow(/not-concave/);
    expect(() => buildPriceLevelsFrame([{ ...okPair, tokenIn: A }])).toThrow(/bad-tokens/);
    expect(() => buildPriceLevelsFrame([{ ...okPair, tokenOut: "zz" }])).toThrow(/bad-tokens/);
    expect(() =>
      buildPriceLevelsFrame([{ ...okPair, levels: [{ input: "1.5", output: "20" }] }]),
    ).toThrow(/malformed-rung/);
    expect(() =>
      buildPriceLevelsFrame([{ ...okPair, levels: [{ input: "0", output: "20" }] }]),
    ).toThrow(/non-positive/);
  });

  test("a built frame always round-trips through the relay's parser", () => {
    const frame = buildPriceLevelsFrame([okPair]);
    expect(parsePriceLevels(frame)).toEqual(frame);
    // The builder copies rather than aliases, so a later caller mutation
    // cannot retroactively invalidate a frame that was already validated.
    okPair.levels[0]!.input = "0";
    expect(frame.levels[0]!.levels[0]!.input).toBe("10");
  });

  test("capabilities refuse anything but the relay's 64-hex token grammar", () => {
    expect(() => buildSolverCapabilitiesFrame(["nope"])).toThrow(/not a token id/);
    expect(() => buildSolverCapabilitiesFrame([`${A}00`])).toThrow(/not a token id/);
    // The relay applies `maxParallelSwaps` only when it is a positive integer,
    // and registers the tokens regardless; the builder mirrors that rather
    // than inventing a stricter rule.
    expect(buildSolverCapabilitiesFrame([A], 0)).toEqual({
      type: "solver-capabilities",
      tokenIds: [A],
    });
    expect(buildSolverCapabilitiesFrame([A.toUpperCase()], 4)).toEqual({
      type: "solver-capabilities",
      tokenIds: [A],
      maxParallelSwaps: 4,
    });
    expect(buildSolverCapabilitiesFrame([])).toEqual({
      type: "solver-capabilities",
      tokenIds: [],
    });
  });
});

// ── FR-003 / FR-004: only executable liquidity is published ─────────────────
//
// Findings P4-F03 and P4-F04. Before this, derivation had no inventory input at
// all: it published every interior rung regardless of whether the solver could
// pay the residual tokenOut those rungs promise, and regardless of whether the
// wallet could fund the fee-sizing mirror a job at that size forces the executor
// to build. Both were discovered only AFTER a taker's job had been routed, and
// the relay kept quoting the same unexecutable rung afterwards.

/**
 * Strictly descending marginal rates 2 → 1 → 0.5, so the ladder is concave and
 * each offer's own worst-case interval residual is distinct:
 *
 *   O1  gives 20 A wants 10 B — rate 2,   cumulative (10, 20), worst 18
 *   O2  gives 10 A wants 10 B — rate 1,   cumulative (20, 30), worst 9
 *   O3  gives 20 A wants 40 B — rate 0.5, cumulative (60, 50), worst 19
 *
 * The pair is B→A: tokenIn = B (what the fee-sizing mirror spends), tokenOut =
 * A (what a residual pays out). O1's 18 is never required — the first rung opens
 * no interpolation interval.
 */
const BUDGET_BOOK = (): LadderSourceOffer[] => [
  offer(O1, A, 20n, B, 10n),
  offer(O2, A, 10n, B, 10n),
  offer(O3, A, 20n, B, 40n),
];

const publishedRungs = (
  book: LadderSourceOffer[],
  extra: Record<string, unknown> = {},
): Array<[string, string]> => {
  const derived = deriveLadder(book, { ...OPTIONS, ...extra });
  return (derived.levels[0]?.levels ?? []).map((rung) => [rung.input, rung.output]);
};

const exclusionsBy = (
  book: LadderSourceOffer[],
  extra: Record<string, unknown> = {},
): Array<[string, string]> =>
  deriveLadder(book, { ...OPTIONS, ...extra }).excluded.map(
    (entry) => [entry.offerHash, entry.reason],
  );

const inventory = (entries: Array<[string, bigint]>): ReadonlyMap<string, bigint> =>
  new Map(entries);

describe("ladder derivation — the residual tokenOut budget (FR-003)", () => {
  test("the worst-case interval residual IS the relay's own arithmetic, not an estimate", () => {
    const rungs = deriveLadder(BUDGET_BOOK(), OPTIONS).levels[0]!.levels;
    const offers = [
      { amountIn: 10n, amountOut: 20n },
      { amountIn: 10n, amountOut: 10n },
      { amountIn: 40n, amountOut: 20n },
    ];

    for (let index = 1; index < rungs.length; index += 1) {
      const low = rungs[index - 1]!;
      const high = rungs[index]!;
      // Scan every size the relay will quote while the maker prefix is still
      // `low`. `high.input` itself is EXCLUDED on purpose: at that size the
      // prefix becomes `high`, so the residual there is zero, not the whole
      // offer's payout. That off-by-one is exactly why the closed form carries
      // `amountIn - 1`.
      let worst = 0n;
      for (let size = BigInt(low.input); size < BigInt(high.input); size += 1n) {
        const quoted = interpolateQuote(rungs, size)!;
        const residual = quoted - BigInt(low.output);
        if (residual > worst) worst = residual;
      }
      expect(worst, `${low.input}..${high.input}`)
        .toBe(worstCaseIntervalResidual(offers[index]!));
    }
    // The two numbers the truncation matrix below is built on.
    expect(worstCaseIntervalResidual(offers[1]!)).toBe(9n);
    expect(worstCaseIntervalResidual(offers[2]!)).toBe(19n);
    // An offer that admits no interior size needs no inventory at all.
    expect(worstCaseIntervalResidual({ amountIn: 1n, amountOut: 1_000n })).toBe(0n);
  });

  test("a rung whose interval the solver cannot pay for is withheld, and truncates the ladder", () => {
    const mirrorOpen = inventory([[B, 1_000n]]);
    // Zero tokenOut: the FIRST rung still publishes. It opens no interpolation
    // interval (below it the relay quotes nothing, at it the quote is exactly
    // its own output), so FR-001's retained-surplus path stays advertised by a
    // solver holding no tokenOut whatsoever.
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...mirrorOpen, [A, 0n]]),
    })).toEqual([["10", "20"]]);
    // 8 < 9: same verdict at the boundary below.
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...mirrorOpen, [A, 8n]]),
    })).toEqual([["10", "20"]]);
    // 9 affords O2's interval but not O3's 19.
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...mirrorOpen, [A, 9n]]),
    })).toEqual([["10", "20"], ["20", "30"]]);
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...mirrorOpen, [A, 18n]]),
    })).toEqual([["10", "20"], ["20", "30"]]);
    // 19 affords the whole book — identical to the unbounded ladder.
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...mirrorOpen, [A, 19n]]),
    })).toEqual(publishedRungs(BUDGET_BOOK()));
  });

  test("truncation is total: no rung above a withheld one is published either", () => {
    // A rung's cumulative totals assume every earlier offer is consumed, so the
    // ladder can be cut but never punctured. Both later offers are reported.
    expect(exclusionsBy(BUDGET_BOOK(), {
      spendableInventory: inventory([[A, 0n], [B, 1_000n]]),
    })).toEqual([[O2, "residual-budget"], [O3, "residual-budget"]]);
    expect(exclusionsBy(BUDGET_BOOK(), {
      spendableInventory: inventory([[A, 9n], [B, 1_000n]]),
    })).toEqual([[O3, "residual-budget"]]);
    expect(exclusionsBy(BUDGET_BOOK(), {
      spendableInventory: inventory([[A, 19n], [B, 1_000n]]),
    })).toEqual([]);
  });

  test("provenance and residualBound shrink with the ladder, so the executor's depth check follows", () => {
    const { provenance } = deriveLadder(BUDGET_BOOK(), {
      ...OPTIONS,
      spendableInventory: inventory([[A, 9n], [B, 1_000n]]),
    });
    expect(provenance[0]!.rungs.map((rung) => rung.offerHash)).toEqual([O1, O2]);
    // 20 (O1's gives), not 20-then-O3's: a withheld rung cannot widen the bound
    // the executor re-checks a resolved route against.
    expect(provenance[0]!.residualBound).toBe("20");
  });
});

describe("ladder derivation — the fee-sizing tokenIn budget (FR-004)", () => {
  test("published rung inputs are capped by the tokenIn the mirror can actually spend", () => {
    const residualOpen = inventory([[A, 1_000n]]);
    // `interpolateQuote` refuses any size above the LAST rung's input, so the
    // published list's tail is the ceiling on a job's amountIn — and the mirror
    // spends a job's FULL amountIn of tokenIn out of the solver's own wallet.
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...residualOpen, [B, 59n]]),
    })).toEqual([["10", "20"], ["20", "30"]]);
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...residualOpen, [B, 60n]]),
    })).toEqual(publishedRungs(BUDGET_BOOK()));
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([...residualOpen, [B, 19n]]),
    })).toEqual([["10", "20"]]);
    expect(exclusionsBy(BUDGET_BOOK(), {
      spendableInventory: inventory([...residualOpen, [B, 19n]]),
    })).toEqual([[O2, "mirror-budget"], [O3, "mirror-budget"]]);
  });

  test("a solver that cannot fund the smallest rung publishes NOTHING for that pair", () => {
    // The availability consequence, stated as a test: this is not a degraded
    // ladder, it is no ladder. An unfunded solver is unquotable rather than
    // quotable-and-refusing, which is the whole point of FR-004.
    for (const tokenIn of [0n, 9n]) {
      const derived = deriveLadder(BUDGET_BOOK(), {
        ...OPTIONS,
        spendableInventory: inventory([[A, 1_000n], [B, tokenIn]]),
      });
      expect(derived.levels, String(tokenIn)).toEqual([]);
      expect(derived.tokenIds, String(tokenIn)).toEqual([]);
      expect(derived.excluded.map((entry) => entry.reason), String(tokenIn))
        .toEqual(["mirror-budget", "mirror-budget", "mirror-budget"]);
    }
  });

  test("a token missing from the snapshot is zero, never open", () => {
    // The snapshot is the complete view of what the solver can move, so an
    // absent token must not read as "unconstrained" — that would restore
    // exactly the fail-open publication F03/F04 are about.
    expect(publishedRungs(BUDGET_BOOK(), { spendableInventory: inventory([]) })).toEqual([]);
    expect(publishedRungs(BUDGET_BOOK(), { spendableInventory: inventory([[A, 1_000n]]) }))
      .toEqual([]);
  });
});

describe("ladder derivation — budgets alongside the rest of the policy", () => {
  test("no inventory at all is OPEN, which is what keeps dry-run publication unchanged", () => {
    // The one fail-open default here, and it is deliberate: the live push always
    // supplies a snapshot, and the executor re-checks both numbers against the
    // same Stock before any wallet mutation.
    expect(publishedRungs(BUDGET_BOOK(), { spendableInventory: null }))
      .toEqual(publishedRungs(BUDGET_BOOK()));
    expect(publishedRungs(BUDGET_BOOK(), { spendableInventory: undefined }))
      .toEqual(publishedRungs(BUDGET_BOOK()));
  });

  test("the tighter of the two budgets wins, and the mirror is reported first", () => {
    // Both stop the same rung: the mirror check runs first so an unfundable
    // wallet reads as unfundable rather than as short of tokenOut.
    expect(exclusionsBy(BUDGET_BOOK(), {
      spendableInventory: inventory([[A, 0n], [B, 0n]]),
    })).toEqual([
      [O1, "mirror-budget"], [O2, "mirror-budget"], [O3, "mirror-budget"],
    ]);
    // Mirror allows two rungs, residual allows all three ⇒ two.
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([[A, 19n], [B, 59n]]),
    })).toEqual([["10", "20"], ["20", "30"]]);
    // Residual allows one, mirror allows all three ⇒ one.
    expect(publishedRungs(BUDGET_BOOK(), {
      spendableInventory: inventory([[A, 0n], [B, 1_000n]]),
    })).toEqual([["10", "20"]]);
  });

  test("a budget-bounded ladder is still a frame the relay admits, and still reproducible", () => {
    const options = { ...OPTIONS, spendableInventory: inventory([[A, 9n], [B, 59n]]) };
    const derived = deriveLadder(BUDGET_BOOK(), options);
    // Concavity and strict ascent survive truncation — a prefix of a concave
    // whole-offer ladder is one.
    expect(rejectLevels(derived.levels[0]!.levels)).toBeNull();
    expect(isPriceLevelsPair(derived.levels[0]!)).toBe(true);
    const frame = buildPriceLevelsFrame(derived.levels);
    expect(parsePriceLevels(frame)).toEqual(frame);
    // Same inputs in any order ⇒ byte-identical output; the budget is a plain
    // snapshot, so nothing about it can leak iteration order.
    const reversed = deriveLadder([...BUDGET_BOOK()].reverse(), options);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(derived));
  });

  test("budgets compose with the pair allowlist and the output minimum", () => {
    const options = {
      ...OPTIONS,
      spendableInventory: inventory([[A, 9n], [B, 1_000n]]),
      supportedPairs: new Set([admissionPairKey(B, A)]),
      minJobOutput: new Map([[A, 25n]]),
    };
    // Budget truncates to rungs {10,20} {20,30}; the minimum then hides the
    // sub-25 rung, leaving one publishable quote. The budget runs FIRST
    // (deliberately conservative — the surviving first rung no longer needs its
    // residual, but re-deriving executability after an unrelated policy filter
    // would couple the two).
    expect(publishedRungs(BUDGET_BOOK(), options)).toEqual([["20", "30"]]);
    // The allowlist is directed: the unbacked direction publishes nothing even
    // with inventory on both sides.
    expect(publishedRungs(BUDGET_BOOK(), {
      ...options,
      supportedPairs: new Set([admissionPairKey(A, B)]),
    })).toEqual([]);
  });
});
