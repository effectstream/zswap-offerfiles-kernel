import { expect, test } from "bun:test";

import type { BookOffer } from "./src/book.ts";
import { claimFor, Stock, type Claim } from "./src/stock.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

const offer = (hash: string, nullifiers: string[]): BookOffer => ({
  offerHash: hash,
  gives: [{ token: A, amount: 100n, kind: "SHIELDED" }],
  wants: [{ token: B, amount: 90n, kind: "SHIELDED" }],
  expiresAt: null,
  firstSeenAt: null,
  inputNullifiers: nullifiers,
});

const claim = (hashes: string[], nullifiers: string[], payouts: [string, bigint][] = []): Claim => ({
  offerHashes: hashes,
  nullifiers,
  payouts: new Map(payouts),
});

test("available is balance minus reservations", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1000n });
  expect(stock.available(A)).toBe(1000n);
  stock.reserve(claim(["h1"], ["n1"], [[A, 400n]]));
  expect(stock.available(A)).toBe(600n);
  expect(stock.reserved(A)).toBe(400n);
});

test("available never goes negative when a refresh lands mid-fill", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1000n });
  stock.reserve(claim(["h1"], ["n1"], [[A, 900n]]));
  // The payout settled on chain; the reservation has not been released yet.
  stock.setBalances({ [A]: 100n });
  expect(stock.available(A)).toBe(0n);
});

test("a refresh keeps reservations — they cover payouts that have not settled", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1000n });
  stock.reserve(claim(["h1"], ["n1"], [[A, 400n]]));
  stock.setBalances({ [A]: 1000n });
  expect(stock.reserved(A)).toBe(400n);
  expect(stock.available(A)).toBe(600n);
});

test("release restores the budget and is idempotent", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1000n });
  const c = claim(["h1"], ["n1"], [[A, 400n]]);
  stock.reserve(c);
  stock.release(c);
  expect(stock.available(A)).toBe(1000n);
  expect(stock.reserved(A)).toBe(0n);
  stock.release(c);
  expect(stock.reserved(A)).toBe(0n);
});

test("an offer already committed cannot be committed again", () => {
  const stock = new Stock();
  expect(stock.reserve(claim(["h1"], ["n1"]))).toBe(true);
  expect(stock.reserve(claim(["h1"], ["n2"]))).toBe(false);
});

test("a set sharing a nullifier with a live fill is refused", () => {
  const stock = new Stock();
  stock.reserve(claim(["h1"], ["shared"]));
  // Different offer, same input coin — the classic double-fill.
  expect(stock.reserve(claim(["h2"], ["shared"]))).toBe(false);
});

test("a refused reservation changes nothing", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1000n });
  stock.reserve(claim(["h1"], ["n1"], [[A, 100n]]));
  expect(stock.reserve(claim(["h1", "h2"], ["n2"], [[A, 500n]]))).toBe(false);
  // h2 must not be left committed, and A's budget must not have moved.
  expect(stock.reserved(A)).toBe(100n);
  expect(stock.isClaimed({ offerHashes: ["h2"], nullifiers: [] })).toBe(false);
});

test("isOfferClaimed sees both the hash and the nullifiers", () => {
  const stock = new Stock();
  const o = offer("h1", ["n1", "n2"]);
  expect(stock.isOfferClaimed(o)).toBe(false);
  stock.reserve(claim([], ["n2"]));
  expect(stock.isOfferClaimed(o)).toBe(true);
});

test("claimFor collects every offer's hash and nullifiers", () => {
  const c = claimFor([offer("h1", ["n1"]), offer("h2", ["n2", "n3"])], new Map([[B, 50n]]));
  expect(c.offerHashes).toEqual(["h1", "h2"]);
  expect(c.nullifiers).toEqual(["n1", "n2", "n3"]);
  expect(c.payouts.get(B)).toBe(50n);
});

test("tokens covers held and committed alike", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 10n, [B]: 5n });
  expect(stock.reserve(claim(["h1"], ["n1"], [[B, 5n]]))).toBe(true);
  expect(stock.tokens().sort()).toEqual([A, B].sort());
});

// ── invariants under multiple claims ─────────────────────────────────────────
// The single-claim tests above passed while the aggregate invariant was broken,
// so these exercise claims against each other rather than in isolation.

test("two individually affordable claims cannot together exceed the balance", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 100n });
  expect(stock.reserve(claim(["h1"], ["n1"], [[A, 60n]]))).toBe(true);
  // Affordable against the ORIGINAL balance, not against what is left.
  expect(stock.reserve(claim(["h2"], ["n2"], [[A, 60n]]))).toBe(false);
  expect(stock.reserved(A)).toBe(60n);
});

test("a claim is admitted once the earlier one releases", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 100n });
  const first = claim(["h1"], ["n1"], [[A, 60n]]);
  stock.reserve(first);
  const second = claim(["h2"], ["n2"], [[A, 60n]]);
  expect(stock.reserve(second)).toBe(false);
  stock.release(first);
  expect(stock.reserve(second)).toBe(true);
});

test("releasing one claim twice does not free another claim's budget", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 200n });
  const first = claim(["h1"], ["n1"], [[A, 60n]]);
  const second = claim(["h2"], ["n2"], [[A, 60n]]);
  stock.reserve(first);
  stock.reserve(second);
  stock.release(first);
  stock.release(first);
  // The second claim still holds its 60.
  expect(stock.reserved(A)).toBe(60n);
  expect(stock.available(A)).toBe(140n);
});

test("a multi-token claim is refused whole when any one token is short", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 100n, [B]: 10n });
  expect(stock.reserve(claim(["h1"], ["n1"], [[A, 50n], [B, 50n]]))).toBe(false);
  // Nothing partially applied.
  expect(stock.reserved(A)).toBe(0n);
  expect(stock.isClaimed({ offerHashes: ["h1"], nullifiers: [] })).toBe(false);
});

test("non-positive payouts are refused rather than corrupting the budget", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 100n });
  expect(stock.reserve(claim(["h1"], ["n1"], [[A, 0n]]))).toBe(false);
  expect(stock.reserve(claim(["h2"], ["n2"], [[A, -5n]]))).toBe(false);
  expect(stock.reserved(A)).toBe(0n);
});

test("reserved never exceeds balance and available+reserved is conserved, over random sequences", () => {
  // Deterministic pseudo-random: a fixed seed so a failure is reproducible.
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  const stock = new Stock();
  const BALANCE = 1000n;
  stock.setBalances({ [A]: BALANCE });
  const live: ReturnType<typeof claim>[] = [];

  for (let i = 0; i < 400; i++) {
    const op = rand(3);
    if (op === 0) {
      const amount = BigInt(rand(300) + 1);
      const c = claim([`h${i}`], [`n${i}`], [[A, amount]]);
      if (stock.reserve(c)) live.push(c);
    } else if (op === 1 && live.length > 0) {
      const c = live.splice(rand(live.length), 1)[0];
      stock.release(c);
    } else if (live.length > 0) {
      // Release something already released — the double-release case.
      stock.release(live[rand(live.length)]);
      stock.release(live[rand(live.length)]);
      live.length = 0;
    }

    expect(stock.reserved(A)).toBeGreaterThanOrEqual(0n);
    expect(stock.reserved(A)).toBeLessThanOrEqual(BALANCE);
    expect(stock.available(A) + stock.reserved(A)).toBe(BALANCE);
  }
});
