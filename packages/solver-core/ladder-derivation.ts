// Price-ladder derivation from the solver's Offer Files book cache.
//
// This is the whole of FR-013/FR-014's derivation half (plan phase N3): pure,
// clock-free, IO-free, and byte-reproducible from a seeded book. It does NOT
// connect to the relay, push, or schedule anything — that is N4.
//
// WHAT A LADDER IS. One entry per DIRECTED token pair, read from the SOLVER's
// side: it receives `tokenIn` and pays `tokenOut`. A maker offer that GIVES X
// and WANTS Y therefore backs the pair `tokenIn = Y, tokenOut = X` and no
// other. Rungs are CUMULATIVE totals as decimal strings, strictly ascending in
// input; the relay quotes any size by linear interpolation between bracketing
// rungs and refuses below the first or above the last (see `interpolateQuote`
// in `relay-ws-contract.ts`, ported from the pinned relay).
//
// THE POLICY (user decision Q-R2-3, 2026-08-20 — the OPTIMAL ladder):
//
//   1. Take every crossable maker offer for the pair.
//   2. Sort them BEST MARGINAL RATE FIRST — most `tokenOut` per `tokenIn`.
//      This is mandatory, not cosmetic: it maximises every quoted prefix and
//      it is what makes the curve CONCAVE, which is the assumption behind the
//      relay's conservative interpolation. Any other order publishes dominated
//      quotes and convex stretches the solver is still held to at job time.
//   3. Emit one rung per whole-offer cumulative boundary — the maximal concave
//      ladder. Every rung is therefore an EXACT whole-offer sum and needs no
//      solver inventory at all.
//   4. Margin/fee policy: NONE. Option B (a conservative sub-curve) was
//      rejected; rungs are the book's exact sums. FR-013's "documented
//      margin/fee policy" is discharged by this sentence.
//
// HONOURABILITY BETWEEN RUNGS. The relay interpolates and treats every
// interpolated point as honourable, but zswap offer files are all-or-nothing.
// Between rungs k and k+1 the chord's slope is exactly offer k+1's marginal
// rate, so an interpolated size `x` is served as: consume offers 1..k WHOLE,
// then trade the residual `x - input[k]` of `tokenIn` for
// `floor(rate_{k+1} * (x - input[k]))` of `tokenOut` out of solver inventory —
// i.e. the solver self-fills the partial offer at that offer's own price,
// never worse. The residual payout is strictly less than one offer's `gives`.
// That is best-effort: if the inventory is not there at job time the job fails
// CLOSED with `job-error` (N5 owns that assertion; see `deriveLadder`'s
// `residualBound` for the number N5 checks against).
//
// DETERMINISM. No wall clock (`nowMs` is a parameter, as in `engine.ts`), no
// randomness, no dependence on input order or on any Map's iteration order:
// offers are totally ordered by content address before anything is grouped,
// and pairs are emitted in lexicographic key order. Same cache state + same
// `nowMs` ⇒ byte-identical frames.
//
// FAIL-CLOSED. Only the native shielded single-leg shape this solver can
// actually settle enters derivation; every other shape is EXCLUDED with a
// recorded reason rather than guessed at. A pair with nothing behind it is
// omitted entirely — never published as an empty or padded ladder.

import {
  MAX_PAIRS_PER_PUSH,
  MAX_RUNGS_PER_PAIR,
  pairKey,
  rejectPair,
  type LadderRejection,
} from "./ladder-schema.ts";
import {
  isCapabilityTokenId,
  isPriceLevelsPair,
  parsePriceLevels,
  parseSolverCapabilities,
  type PriceLevel,
  type PriceLevelsMessage,
  type PriceLevelsPair,
  type SolverCapabilitiesMessage,
} from "./relay-ws-contract.ts";

/** Ceiling `ladder-schema.ts` holds amounts to. A cumulative total past it is
 *  not representable on the wire, so the ladder is truncated there. */
const MAX_U256 = (1n << 256n) - 1n;

/** The book projection derivation needs. `BookOffer` in the solver satisfies it
 *  structurally, so the pure core never imports the solver package. */
export interface LadderSourceLeg {
  token: string;
  amount: bigint;
  kind: "SHIELDED" | "UNSHIELDED";
}

export interface LadderSourceOffer {
  offerHash: string;
  gives: readonly LadderSourceLeg[];
  wants: readonly LadderSourceLeg[];
  /** Epoch ms. `null` means the source published no expiry — see `no-expiry`. */
  expiresAt: number | null;
  inputNullifiers: readonly string[];
}

/** Why an offer in the cache backs no published rung. Diagnostics are returned
 *  as DATA: this module calls no observer, so no untrusted callback can throw
 *  inside derivation (the R-37 containment property at this layer; the push
 *  loop's half belongs to N4). */
export type LadderExclusionReason =
  /** More than one leg on a side: no single directed price describes it. */
  | "multi-leg"
  /** A leg this solver does not settle natively (FR-002 scope is SHIELDED). */
  | "non-shielded-leg"
  | "non-positive-amount"
  | "same-token"
  | "malformed-token"
  | "malformed-hash"
  | "malformed-nullifier"
  /** No expiry at all. The API boundary already rejects these; publishing a
   *  commitment against an unbounded row would have no safety margin. */
  | "no-expiry"
  /** Inside the settlement safety margin — it cannot be honoured at job time. */
  | "expiring"
  /** Caller-supplied: claimed by an in-flight fill, or otherwise spoken for. */
  | "unavailable"
  /** R-07 aggregate budget: an input coin already backing a published rung. */
  | "shared-coin"
  /** Past `maxRungsPerPair`, or past the u256 ceiling on a cumulative total. */
  | "rung-cap"
  /** Past `maxPairs`. */
  | "pair-cap"
  /** The assembled pair failed local wire validation and was dropped whole. */
  | "invalid-pair";

export interface LadderExclusion {
  offerHash: string;
  reason: LadderExclusionReason;
  /** Present for `invalid-pair`: the schema's verdict, for a loud test failure. */
  detail?: LadderRejection | "bad-tokens";
}

/** One published rung and the offer whose whole consumption closes it. */
export interface LadderRungProvenance {
  input: string;
  output: string;
  offerHash: string;
}

export interface LadderPairProvenance {
  tokenIn: string;
  tokenOut: string;
  /** Rung order = consumption order = best marginal rate first. */
  rungs: LadderRungProvenance[];
  /** Largest single-offer `gives` on this pair: the most `tokenOut` inventory
   *  any interpolated size between rungs can require. N5 checks against it. */
  residualBound: string;
}

export interface DeriveLadderOptions {
  /** Passed in, never read from the clock, so derivation stays reproducible. */
  nowMs: number;
  /** Same margin the engine/executor enforce at dequeue (R-38). */
  expiryMarginSeconds: number;
  /** Offers spoken for elsewhere (in-flight claims). Excluded as `unavailable`. */
  unavailableOfferHashes?: Iterable<string>;
  maxPairs?: number;
  maxRungsPerPair?: number;
}

export interface DerivedLadder {
  /** Publishable pairs, lexicographic by (tokenIn, tokenOut). Every entry has
   *  passed BOTH the strict schema and the relay's own admission predicate. */
  levels: PriceLevelsPair[];
  /** FR-013 capabilities: the union of tokens in publishable pairs, lowercase
   *  and sorted. Derived from the same cache, never configured separately. */
  tokenIds: string[];
  provenance: LadderPairProvenance[];
  /** Every cache offer that backs no rung, with its reason. Sorted. */
  excluded: LadderExclusion[];
}

interface Crossable {
  offerHash: string;
  /** What the taker pays and the solver receives = the maker's `wants`. */
  tokenIn: string;
  /** What the solver pays and the taker receives = the maker's `gives`. */
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  nullifiers: string[];
}

const HEX64 = /^[0-9a-f]{64}$/i;

const byOfferHash = (a: { offerHash: string }, b: { offerHash: string }): number =>
  a.offerHash < b.offerHash ? -1 : a.offerHash > b.offerHash ? 1 : 0;

/**
 * Total order for consumption: BEST MARGINAL RATE FIRST, ties by content
 * address ascending.
 *
 * Rate is `amountOut / amountIn` (tokenOut per tokenIn) compared by
 * cross-multiplication, so there is no division and no float anywhere.
 *
 * THE TIE RULE, stated once and depended on everywhere: two offers at the same
 * marginal rate are ordered by ASCENDING `offerHash`. The content address is
 * the only totally-ordered, insertion-order-independent key the cache has, so
 * this is what makes the ladder byte-reproducible; any rate-preserving order
 * would be equally honourable (the boundaries differ, the frontier does not).
 */
const byMarginalRateThenHash = (a: Crossable, b: Crossable): number => {
  const left = a.amountOut * b.amountIn;
  const right = b.amountOut * a.amountIn;
  if (left > right) return -1;
  if (left < right) return 1;
  return byOfferHash(a, b);
};

/** Reduce a cache offer to the one shape a directed ladder can describe, or say
 *  why it cannot. Unsupported shapes are excluded, never coerced. */
function toCrossable(
  offer: LadderSourceOffer,
  options: DeriveLadderOptions,
  unavailable: ReadonlySet<string>,
): Crossable | LadderExclusionReason {
  if (typeof offer.offerHash !== "string" || !HEX64.test(offer.offerHash)) return "malformed-hash";
  const offerHash = offer.offerHash.toLowerCase();
  if (unavailable.has(offerHash)) return "unavailable";
  if (offer.gives.length !== 1 || offer.wants.length !== 1) return "multi-leg";

  const give = offer.gives[0]!;
  const want = offer.wants[0]!;
  if (give.kind !== "SHIELDED" || want.kind !== "SHIELDED") return "non-shielded-leg";
  if (typeof give.token !== "string" || !HEX64.test(give.token)) return "malformed-token";
  if (typeof want.token !== "string" || !HEX64.test(want.token)) return "malformed-token";
  if (typeof give.amount !== "bigint" || typeof want.amount !== "bigint") return "non-positive-amount";
  if (give.amount <= 0n || want.amount <= 0n) return "non-positive-amount";

  const tokenOut = give.token.toLowerCase();
  const tokenIn = want.token.toLowerCase();
  if (tokenIn === tokenOut) return "same-token";

  if (offer.inputNullifiers.some((n) => typeof n !== "string" || !HEX64.test(n))) {
    return "malformed-nullifier";
  }
  // An offer with no declared expiry cannot be held outside a settlement safety
  // margin. `bookOfferFromApi` already refuses such rows; this is depth.
  if (offer.expiresAt === null) return "no-expiry";
  if (options.nowMs >= offer.expiresAt - options.expiryMarginSeconds * 1000) return "expiring";

  return {
    offerHash,
    tokenIn,
    tokenOut,
    amountIn: want.amount,
    amountOut: give.amount,
    nullifiers: [...new Set(offer.inputNullifiers.map((n) => n.toLowerCase()))].sort(),
  };
}

/**
 * Derive every publishable ladder and the capabilities that go with it.
 *
 * Pure. Same offers (in any order) + same options ⇒ byte-identical result.
 */
export function deriveLadder(
  offers: Iterable<LadderSourceOffer>,
  options: DeriveLadderOptions,
): DerivedLadder {
  const maxPairs = options.maxPairs ?? MAX_PAIRS_PER_PUSH;
  const maxRungs = options.maxRungsPerPair ?? MAX_RUNGS_PER_PAIR;
  const unavailable = new Set(
    [...(options.unavailableOfferHashes ?? [])].map((hash) => hash.toLowerCase()),
  );

  const excluded: LadderExclusion[] = [];
  const crossable: Crossable[] = [];
  for (const offer of offers) {
    const reduced = toCrossable(offer, options, unavailable);
    if (typeof reduced === "string") {
      excluded.push({
        offerHash: typeof offer.offerHash === "string" ? offer.offerHash.toLowerCase() : "",
        reason: reduced,
      });
      continue;
    }
    crossable.push(reduced);
  }

  // R-07, the aggregate-budget property, at coin granularity.
  //
  // The finding was "aggregate levels overcommit SHARED output inventory". At
  // the relay the sharing is not per-token stock — every rung is funded by the
  // maker offer itself — it is the INPUT COIN: two offers that spend the same
  // coin are conflicting views of it and at most one can ever settle, yet they
  // can sit in different directed pairs and each publish full depth. Counting
  // both would advertise liquidity that does not exist, on two pairs that each
  // look locally honourable. So a coin backs at most ONE published rung across
  // ALL pairs; the retained claimant is the lexicographically smallest content
  // address. That choice is arbitrary but stable — comparing rates across
  // different directed pairs is meaningless — and the conflict itself already
  // means only one of them can settle. Every published pair is therefore
  // independently honourable, and their SUM is honourable too.
  //
  // Upstream #47's marker dedup makes this rare at the backend, but the cache
  // is not the backend: a resync race, or a node without that rule, can put
  // both rows in front of derivation.
  const claimedCoins = new Set<string>();
  const retained: Crossable[] = [];
  for (const offer of [...crossable].sort(byOfferHash)) {
    if (offer.nullifiers.some((nullifier) => claimedCoins.has(nullifier))) {
      excluded.push({ offerHash: offer.offerHash, reason: "shared-coin" });
      continue;
    }
    for (const nullifier of offer.nullifiers) claimedCoins.add(nullifier);
    retained.push(offer);
  }

  const byPair = new Map<string, Crossable[]>();
  for (const offer of retained) {
    const key = pairKey(offer.tokenIn, offer.tokenOut);
    const bucket = byPair.get(key);
    if (bucket) bucket.push(offer);
    else byPair.set(key, [offer]);
  }

  const assembled: Array<{ pair: PriceLevelsPair; provenance: LadderPairProvenance }> = [];
  // Sorted keys, so no Map iteration order reaches the output.
  for (const key of [...byPair.keys()].sort()) {
    const bucket = [...byPair.get(key)!].sort(byMarginalRateThenHash);
    const levels: PriceLevel[] = [];
    const rungs: LadderRungProvenance[] = [];
    let cumulativeIn = 0n;
    let cumulativeOut = 0n;
    let residualBound = 0n;

    for (const offer of bucket) {
      if (levels.length >= maxRungs) {
        excluded.push({ offerHash: offer.offerHash, reason: "rung-cap" });
        continue;
      }
      const nextIn = cumulativeIn + offer.amountIn;
      const nextOut = cumulativeOut + offer.amountOut;
      if (nextIn > MAX_U256 || nextOut > MAX_U256) {
        // Not representable on the wire. A PREFIX of a concave ladder is still
        // a concave ladder of exact whole-offer sums, so truncate rather than
        // drop the pair.
        excluded.push({ offerHash: offer.offerHash, reason: "rung-cap" });
        continue;
      }
      cumulativeIn = nextIn;
      cumulativeOut = nextOut;
      if (offer.amountOut > residualBound) residualBound = offer.amountOut;
      const rung = { input: cumulativeIn.toString(), output: cumulativeOut.toString() };
      levels.push(rung);
      rungs.push({ ...rung, offerHash: offer.offerHash });
    }

    if (levels.length === 0) continue;
    const [tokenIn, tokenOut] = [bucket[0]!.tokenIn, bucket[0]!.tokenOut];
    const pair: PriceLevelsPair = { tokenIn, tokenOut, levels };

    // Local frame validation, BEFORE anything can be pushed. A frame the relay
    // rejects is discarded SILENTLY and the previous ladder stays live, so a
    // malformed push freezes the solver stale instead of withdrawing it. Both
    // predicates run: the strict schema (positive, ascending in BOTH columns,
    // concave, distinct 64-hex colors) and the relay's own admission rule.
    const rejection = rejectPair(pair);
    if (rejection !== null || !isPriceLevelsPair(pair)) {
      for (const rung of rungs) {
        excluded.push({
          offerHash: rung.offerHash,
          reason: "invalid-pair",
          ...(rejection === null ? {} : { detail: rejection }),
        });
      }
      continue;
    }
    assembled.push({
      pair,
      provenance: { tokenIn, tokenOut, rungs, residualBound: residualBound.toString() },
    });
  }

  const published = assembled.slice(0, maxPairs);
  for (const dropped of assembled.slice(maxPairs)) {
    for (const rung of dropped.provenance.rungs) {
      excluded.push({ offerHash: rung.offerHash, reason: "pair-cap" });
    }
  }

  const tokenIds = [
    ...new Set(published.flatMap(({ pair }) => [pair.tokenIn, pair.tokenOut])),
  ].sort();

  return {
    levels: published.map(({ pair }) => pair),
    tokenIds,
    provenance: published.map(({ provenance }) => provenance),
    excluded: excluded.sort(
      (a, b) => byOfferHash(a, b) || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
    ),
  };
}

/**
 * Build the `price-levels` frame, refusing to produce one the relay would
 * discard.
 *
 * This is the only constructor: a malformed frame is unrepresentable because
 * the builder throws instead of returning one. It re-parses its own output
 * through the relay's `parsePriceLevels`, so what it returns is exactly what
 * the relay admits — no frame reaches the socket on the strength of the
 * derivation's own reasoning alone.
 *
 * `{ levels: [] }` is legitimate and is the fail-closed WITHDRAWAL frame: an
 * empty publication removes the solver's pairs, which is what a cache that
 * cannot honour anything must send (and what N4 must send before a graceful
 * stop that keeps the socket open — R-41).
 */
export function buildPriceLevelsFrame(pairs: readonly PriceLevelsPair[]): PriceLevelsMessage {
  for (const pair of pairs) {
    const rejection = rejectPair(pair);
    if (rejection !== null) {
      throw new Error(
        `refusing to build price-levels: ${pair?.tokenIn ?? "?"}→${pair?.tokenOut ?? "?"} is ${rejection}`,
      );
    }
  }
  const frame: PriceLevelsMessage = {
    type: "price-levels",
    levels: pairs.map((pair) => ({
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      levels: pair.levels.map((rung) => ({ input: rung.input, output: rung.output })),
    })),
  };
  if (parsePriceLevels(frame) === null) {
    throw new Error("refusing to build price-levels: the relay would discard this frame");
  }
  return frame;
}

/** The explicit withdrawal frame. Named because "push an empty ladder" is a
 *  deliberate act — the relay has no version or tombstone concept, so this is
 *  the only way to retract without dropping the socket. */
export const withdrawalPriceLevelsFrame = (): PriceLevelsMessage => buildPriceLevelsFrame([]);

/**
 * Build the `solver-capabilities` frame, refusing malformed token ids.
 *
 * The relay keeps the token list only when EVERY id matches its 64-hex
 * grammar; a single bad id silently drops the whole registration. So this
 * throws rather than let that happen. `maxParallelSwaps` is included only when
 * it is a positive integer, matching the relay's own asymmetry.
 */
export function buildSolverCapabilitiesFrame(
  tokenIds: readonly string[],
  maxParallelSwaps?: number,
): SolverCapabilitiesMessage {
  for (const tokenId of tokenIds) {
    if (!isCapabilityTokenId(tokenId)) {
      throw new Error(`refusing to build solver-capabilities: ${String(tokenId)} is not a token id`);
    }
  }
  const frame: SolverCapabilitiesMessage = {
    type: "solver-capabilities",
    tokenIds: tokenIds.map((tokenId) => tokenId.toLowerCase()),
  };
  if (
    typeof maxParallelSwaps === "number" &&
    Number.isInteger(maxParallelSwaps) &&
    maxParallelSwaps > 0
  ) {
    frame.maxParallelSwaps = maxParallelSwaps;
  }
  if (parseSolverCapabilities(frame) === null) {
    throw new Error("refusing to build solver-capabilities: the relay would discard this frame");
  }
  return frame;
}
