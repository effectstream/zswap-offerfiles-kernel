// What to fill, decided mechanically from posted prices and stock.
//
// Pure: no IO, no wallet, no clock of its own — `nowMs` is passed in so the
// decisions are reproducible in a test.
//
// Two shapes of fill:
//   Path A — the solver is the counterparty, paying from its own inventory.
//   Path B — two or more offers cover each other and the solver only merges
//            them. An exactly-crossing set needs no inventory at all, which is
//            why it outranks everything else.
//
// Sign convention throughout: from the SOLVER's side. An offer's `gives` is
// what the solver receives, its `wants` is what the solver pays. So a positive
// net is a surplus the solver keeps; a negative net is a top-up it must fund.

import type { BookOffer } from "./book.ts";
import type { Book } from "./book.ts";
import type { LadderBook } from "./ladder.ts";
import type { Stock } from "./stock.ts";

export interface EngineConfig {
  ladders: LadderBook;
  /** Color → reference price, for valuing a crossing set's residual. An
   *  exactly-crossing set never consults it. */
  refPricesUsd: Map<string, number>;
  stock: Stock;
  expiryMarginSeconds: number;
  /** Longest crossing cycle to enumerate. 2 is a straight A↔B cross. */
  maxCycleLen: number;
}

export type Candidate =
  | { kind: "pathA"; offers: [BookOffer]; payouts: Map<string, bigint>; maxPay: bigint }
  | { kind: "pathB"; offers: BookOffer[]; net: Map<string, bigint>; payouts: Map<string, bigint> };

/** Per-token net across a set, from the solver's side. Zero entries are
 *  dropped, so an exactly-crossing set nets to an empty map. */
export function netOf(offers: BookOffer[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  const add = (token: string, delta: bigint): void => {
    const next = (net.get(token) ?? 0n) + delta;
    if (next === 0n) net.delete(token);
    else net.set(token, next);
  };
  for (const offer of offers) {
    for (const leg of offer.gives) add(leg.token, leg.amount);
    for (const leg of offer.wants) add(leg.token, -leg.amount);
  }
  return net;
}

/** What the solver must supply for a set to balance: the negative nets, sign
 *  flipped. Empty for an exact crossing. */
export function payoutsFor(net: Map<string, bigint>): Map<string, bigint> {
  const payouts = new Map<string, bigint>();
  for (const [token, amount] of net) {
    if (amount < 0n) payouts.set(token, -amount);
  }
  return payouts;
}

/** Decimal places a reference price is held to once scaled to an integer. */
export const PRICE_SCALE_DP = 9;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DP);

/** A reference price as a scaled integer, or null if it cannot be represented
 *  exactly enough to trust. Bounded so the scaling itself stays inside the
 *  double's exact-integer range. */
export function scalePrice(price: number): bigint | null {
  if (!Number.isFinite(price) || price < 0) return null;
  const scaled = price * Number(PRICE_SCALE);
  if (!Number.isSafeInteger(Math.round(scaled))) return null;
  return BigInt(Math.round(scaled));
}

/**
 * Value a set's residual at reference prices, exactly.
 *
 * The result is scaled by 10^PRICE_SCALE_DP; only its SIGN is load-bearing, so
 * the scale never has to be undone. Doing this in `Number` loses the low bits
 * of a large amount: a residual of exactly −1 against amounts above 2^53 came
 * out as 0 and passed a `< 0` rejection, admitting a set that loses money.
 *
 * Returns null when a token with a non-zero net has no usable price — an
 * unjudgeable residual must not be taken on faith.
 */
export function residualValue(
  net: Map<string, bigint>,
  refPricesUsd: Map<string, number>,
): bigint | null {
  let total = 0n;
  for (const [token, amount] of net) {
    const price = refPricesUsd.get(token);
    if (price === undefined) return null;
    const scaled = scalePrice(price);
    if (scaled === null) return null;
    total += amount * scaled;
  }
  return total;
}

/** An offer is workable while it is outside the expiry margin and not already
 *  committed to an in-flight fill. `expiresAt` is a floor, so the margin is
 *  what keeps a settlement from starting against a deadline it cannot beat. */
export function isWorkable(
  offer: BookOffer,
  stock: Stock,
  nowMs: number,
  expiryMarginSeconds: number,
): boolean {
  if (stock.isOfferClaimed(offer)) return false;
  if (offer.expiresAt === null) return true;
  return nowMs < offer.expiresAt - expiryMarginSeconds * 1000;
}

/** Two offers spending the same coin can never both settle; merging them
 *  produces a transaction that is structurally fine and fails on chain. */
export function nullifiersDisjoint(offers: BookOffer[]): boolean {
  const seen = new Set<string>();
  for (const offer of offers) {
    for (const nullifier of offer.inputNullifiers) {
      if (seen.has(nullifier)) return false;
      seen.add(nullifier);
    }
  }
  return true;
}

export type SetVerdict =
  | { ok: true; net: Map<string, bigint>; payouts: Map<string, bigint>; residual: bigint }
  | { ok: false; reason: string };

/** Should the solver settle this set as one merged transaction? */
export function evaluateSet(
  offers: BookOffer[],
  cfg: EngineConfig,
  nowMs: number,
): SetVerdict {
  if (offers.length < 2) return { ok: false, reason: "a crossing needs at least two offers" };
  if (new Set(offers.map((o) => o.offerHash)).size !== offers.length) {
    return { ok: false, reason: "duplicate offer in set" };
  }
  for (const offer of offers) {
    if (!isWorkable(offer, cfg.stock, nowMs, cfg.expiryMarginSeconds)) {
      return { ok: false, reason: `offer ${offer.offerHash.slice(0, 10)} is claimed or near expiry` };
    }
  }
  if (!nullifiersDisjoint(offers)) {
    return { ok: false, reason: "offers share an input coin" };
  }

  const net = netOf(offers);
  const payouts = payoutsFor(net);

  // An exact crossing is self-funding: the offers cover each other and the
  // solver only merges them. No prices needed, no inventory touched.
  if (net.size === 0) return { ok: true, net, payouts, residual: 0n };

  for (const [token, amount] of payouts) {
    if (cfg.stock.available(token) < amount) {
      return {
        ok: false,
        reason: `stock ${cfg.stock.available(token)} < ${amount} ${token.slice(0, 8)}`,
      };
    }
  }

  const residual = residualValue(net, cfg.refPricesUsd);
  if (residual === null) return { ok: false, reason: "unpriced token in residual" };
  if (residual < 0n) return { ok: false, reason: `residual ${residual} is negative` };
  return { ok: true, net, payouts, residual };
}

/** Path A: the solver takes the whole offer from inventory. Single-leg offers
 *  only — a multi-leg offer has no single posted price to check. */
export function evaluatePathA(
  offer: BookOffer,
  cfg: EngineConfig,
  nowMs: number,
): { ok: true; payouts: Map<string, bigint>; maxPay: bigint } | { ok: false; reason: string } {
  if (offer.gives.length !== 1 || offer.wants.length !== 1) {
    return { ok: false, reason: "multi-leg offer has no single posted price" };
  }
  if (!isWorkable(offer, cfg.stock, nowMs, cfg.expiryMarginSeconds)) {
    return { ok: false, reason: "claimed or near expiry" };
  }

  const give = offer.gives[0];
  const want = offer.wants[0];
  const maxPay = cfg.ladders.maxPayout(give.token, want.token, give.amount);
  if (maxPay === null) {
    return { ok: false, reason: `no ladder for ${give.token.slice(0, 8)}→${want.token.slice(0, 8)} at ${give.amount}` };
  }
  // At-or-better than the posted price. Equality qualifies: the solver
  // published that price and must honour it.
  if (want.amount > maxPay) {
    return { ok: false, reason: `wants ${want.amount} > posted ${maxPay}` };
  }
  if (cfg.stock.available(want.token) < want.amount) {
    return { ok: false, reason: `stock ${cfg.stock.available(want.token)} < ${want.amount}` };
  }
  return { ok: true, payouts: new Map([[want.token, want.amount]]), maxPay };
}

/** Every exactly-crossing pair currently in the book.
 *
 *  A pair crosses exactly when each offer's give covers the other's want on
 *  both tokens. Enumerated by walking one direction's bucket and looking up
 *  the mirrored (amount, token) in the reverse bucket, so this stays linear in
 *  book size rather than quadratic. */
export function findExactCrossings(
  book: Book,
  cfg: EngineConfig,
  nowMs: number,
): Candidate[] {
  const found: Candidate[] = [];
  const paired = new Set<string>();

  for (const { giveToken, wantToken } of book.pairs()) {
    // Each unordered pair of buckets is visited twice; skip the second visit.
    if (giveToken > wantToken) continue;

    const forward = book.byPair(giveToken, wantToken);
    const reverse = book.byPair(wantToken, giveToken);
    if (forward.length === 0 || reverse.length === 0) continue;

    // Reverse offers indexed by what they give and want, so a forward offer
    // finds its exact mirror in one lookup.
    const mirror = new Map<string, BookOffer[]>();
    for (const offer of reverse) {
      const key = `${offer.gives[0].amount}|${offer.wants[0].amount}`;
      const bucket = mirror.get(key);
      if (bucket) bucket.push(offer);
      else mirror.set(key, [offer]);
    }

    for (const offer of forward) {
      if (paired.has(offer.offerHash)) continue;
      // The mirror must give exactly what this offer wants, and want exactly
      // what this offer gives.
      const key = `${offer.wants[0].amount}|${offer.gives[0].amount}`;
      for (const counterpart of mirror.get(key) ?? []) {
        if (paired.has(counterpart.offerHash)) continue;
        const verdict = evaluateSet([offer, counterpart], cfg, nowMs);
        if (!verdict.ok) continue;
        found.push({
          kind: "pathB",
          offers: [offer, counterpart],
          net: verdict.net,
          payouts: verdict.payouts,
        });
        paired.add(offer.offerHash);
        paired.add(counterpart.offerHash);
        break;
      }
    }
  }

  return found;
}

/** How generous an offer is to the solver, as output-per-input scaled to keep
 *  the comparison in integers. Higher is better: more received per unit paid. */
const generosity = (offer: BookOffer): bigint => {
  const give = offer.gives[0]?.amount ?? 0n;
  const want = offer.wants[0]?.amount ?? 0n;
  if (want === 0n) return give > 0n ? BigInt(Number.MAX_SAFE_INTEGER) : 0n;
  return (give * 1_000_000n) / want;
};

/** Cycles through the token graph, up to `maxCycleLen` legs.
 *
 *  A cycle A→B→C→A is one offer per edge: each offer's want is the next
 *  offer's give. Unlike an exact 2-cycle the amounts need not line up — the
 *  solver funds any shortfall, and `evaluateSet` decides whether the residual
 *  is worth it. Only the most generous offer on each edge is considered: a
 *  worse-priced offer on the same edge can only lower the residual, so if the
 *  best one fails the predicate none of the others would pass it. */
export function findCycleCrossings(
  book: Book,
  cfg: EngineConfig,
  nowMs: number,
  exclude: Set<string> = new Set(),
): Candidate[] {
  // Best available offer per directed edge.
  const bestOnEdge = new Map<string, BookOffer>();
  const outgoing = new Map<string, string[]>();
  for (const { giveToken, wantToken } of book.pairs()) {
    const usable = book
      .byPair(giveToken, wantToken)
      .filter((o) => !exclude.has(o.offerHash) && isWorkable(o, cfg.stock, nowMs, cfg.expiryMarginSeconds));
    if (usable.length === 0) continue;
    const best = usable.reduce((a, b) => (generosity(b) > generosity(a) ? b : a));
    bestOnEdge.set(pairKeyOf(giveToken, wantToken), best);
    const from = outgoing.get(giveToken);
    if (from) from.push(wantToken);
    else outgoing.set(giveToken, [wantToken]);
  }

  const found: Candidate[] = [];
  const used = new Set(exclude);

  // `giveToken` is what the solver receives on that edge, so a cycle walks
  // give → want → give → … back to the token it started from.
  for (const start of outgoing.keys()) {
    const walk = (token: string, path: BookOffer[]): void => {
      if (found.length > 0 && path.length === 0) return;
      for (const next of outgoing.get(token) ?? []) {
        const offer = bestOnEdge.get(pairKeyOf(token, next));
        if (!offer || used.has(offer.offerHash)) continue;
        if (path.some((o) => o.offerHash === offer.offerHash)) continue;

        const extended = [...path, offer];
        if (next === start) {
          if (extended.length < 2) continue;
          const verdict = evaluateSet(extended, cfg, nowMs);
          if (verdict.ok) {
            found.push({
              kind: "pathB",
              offers: extended,
              net: verdict.net,
              payouts: verdict.payouts,
            });
            for (const o of extended) used.add(o.offerHash);
            return;
          }
          continue;
        }
        if (extended.length >= cfg.maxCycleLen) continue;
        walk(next, extended);
      }
    };
    walk(start, []);
  }

  return found;
}

const pairKeyOf = (giveToken: string, wantToken: string): string => `${giveToken}|${wantToken}`;

/** Everything worth settling right now, best first.
 *
 *  Ordering is by how little the solver has to commit: an exact crossing costs
 *  no inventory at all, a residual cycle costs only the shortfall, and Path A
 *  funds the whole other side. Taking an offer onto the books when it could
 *  have been matched spends capacity for nothing. */
export function findCandidates(book: Book, cfg: EngineConfig, nowMs: number): Candidate[] {
  const exact = findExactCrossings(book, cfg, nowMs);
  const spokenFor = new Set(exact.flatMap((c) => c.offers.map((o) => o.offerHash)));

  const cycles = findCycleCrossings(book, cfg, nowMs, spokenFor);
  for (const candidate of cycles) {
    for (const offer of candidate.offers) spokenFor.add(offer.offerHash);
  }

  const pathA: Candidate[] = [];
  for (const offer of book.all()) {
    if (spokenFor.has(offer.offerHash)) continue;
    const verdict = evaluatePathA(offer, cfg, nowMs);
    if (verdict.ok) {
      pathA.push({ kind: "pathA", offers: [offer], payouts: verdict.payouts, maxPay: verdict.maxPay });
    }
  }

  return [...exact, ...cycles, ...pathA];
}
