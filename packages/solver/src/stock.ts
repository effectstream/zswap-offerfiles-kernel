// What the solver can still commit.
//
// Two kinds of commitment, both released together when a fill reaches a
// terminal outcome:
//   - tokens the solver has promised to pay but has not yet spent on chain;
//   - offers (and the nullifiers they spend) a fill is already working on.
//
// The offer side is what makes double-filling structurally impossible: a Path A
// candidate and a Path B set that share an offer can never both be admitted,
// because the first one enqueued reserves it.

import type { BookOffer } from "./book.ts";

/** Everything one fill commits. Reserved as a unit, released as a unit. */
export interface Claim {
  offerHashes: string[];
  nullifiers: string[];
  /** Token → amount the solver will pay out. */
  payouts: Map<string, bigint>;
}

export function claimFor(offers: BookOffer[], payouts: Map<string, bigint>): Claim {
  return {
    offerHashes: offers.map((o) => o.offerHash),
    nullifiers: offers.flatMap((o) => o.inputNullifiers),
    payouts,
  };
}

/** Content-derived identity, so a claim reconstructed from the same offers and
 *  payouts releases the one it actually reserved. Two distinct live claims can
 *  never collide here: sharing an offer or nullifier is refused by `reserve`. */
export function claimKey(claim: Claim): string {
  const offers = [...claim.offerHashes].sort().join(",");
  const nullifiers = [...claim.nullifiers].sort().join(",");
  const payouts = [...claim.payouts]
    .map(([token, amount]) => `${token}:${amount}`)
    .sort()
    .join(",");
  return `${offers}|${nullifiers}|${payouts}`;
}

export class Stock {
  #balances = new Map<string, bigint>();
  #reserved = new Map<string, bigint>();
  #claimedHashes = new Set<string>();
  #claimedNullifiers = new Set<string>();
  /** Claims currently holding budget, keyed by content — the record that makes
   *  release idempotent. */
  #live = new Map<string, Claim>();

  /** Replace the on-chain view. Reservations survive: they cover payouts that
   *  have not settled yet, so a refresh mid-fill must not free them. */
  setBalances(balances: Record<string, bigint> | Map<string, bigint>): void {
    this.#balances = new Map(
      balances instanceof Map ? balances : Object.entries(balances),
    );
  }

  balance(token: string): bigint {
    return this.#balances.get(token) ?? 0n;
  }

  reserved(token: string): bigint {
    return this.#reserved.get(token) ?? 0n;
  }

  /** Never negative: a reservation outliving its balance (a refresh landing
   *  between spend and confirm) means zero spare, not a negative budget. */
  available(token: string): bigint {
    const spare = this.balance(token) - this.reserved(token);
    return spare > 0n ? spare : 0n;
  }

  /** True when any part of `claim` is already committed. */
  isClaimed(claim: Pick<Claim, "offerHashes" | "nullifiers">): boolean {
    return (
      claim.offerHashes.some((h) => this.#claimedHashes.has(h)) ||
      claim.nullifiers.some((n) => this.#claimedNullifiers.has(n))
    );
  }

  isOfferClaimed(offer: BookOffer): boolean {
    return this.isClaimed({ offerHashes: [offer.offerHash], nullifiers: offer.inputNullifiers });
  }

  /** Commit a claim, all-or-nothing.
   *
   *  Admission is decided HERE, not by whoever evaluated the candidate: two
   *  candidates judged against the same snapshot are each individually
   *  affordable, so a caller-side check lets their sum exceed the balance. The
   *  aggregate check and the commit have to be one step. */
  reserve(claim: Claim): boolean {
    if (this.isClaimed(claim)) return false;
    for (const [token, amount] of claim.payouts) {
      // A non-positive payout is meaningless and would corrupt the budget.
      if (amount <= 0n) return false;
      if (this.available(token) < amount) return false;
    }

    const key = claimKey(claim);
    if (this.#live.has(key)) return false;
    this.#live.set(key, claim);
    for (const hash of claim.offerHashes) this.#claimedHashes.add(hash);
    for (const nullifier of claim.nullifiers) this.#claimedNullifiers.add(nullifier);
    for (const [token, amount] of claim.payouts) {
      this.#reserved.set(token, this.reserved(token) + amount);
    }
    return true;
  }

  /** Release a claim. Idempotent per claim: releasing one twice must not free
   *  budget belonging to a different live claim, so the second call is a no-op
   *  rather than a second subtraction. */
  release(claim: Claim): void {
    const key = claimKey(claim);
    if (!this.#live.delete(key)) return;

    for (const hash of claim.offerHashes) this.#claimedHashes.delete(hash);
    for (const nullifier of claim.nullifiers) this.#claimedNullifiers.delete(nullifier);
    for (const [token, amount] of claim.payouts) {
      const next = this.reserved(token) - amount;
      if (next > 0n) this.#reserved.set(token, next);
      else this.#reserved.delete(token);
    }
  }

  /** Tokens the solver holds or has committed — the set worth publishing a
   *  ladder for. */
  tokens(): string[] {
    return [...new Set([...this.#balances.keys(), ...this.#reserved.keys()])];
  }

  /**
   * One snapshot of `available` for every token this Stock knows about — what
   * publication is allowed to advertise as executable (spec 00005
   * FR-003/FR-004).
   *
   * A snapshot, not a live view: the ladder derivation must be reproducible
   * from its inputs, so the push loop takes one of these per push and the
   * derivation never reads back into executor state. A token absent from the
   * result means zero available, which is what the derivation assumes — so a
   * refresh that emptied the balances withdraws every budget-bounded rung on
   * the next push, exactly as it already withdraws residual authority.
   */
  spendable(): Map<string, bigint> {
    const snapshot = new Map<string, bigint>();
    for (const token of this.tokens()) {
      const available = this.available(token);
      if (available > 0n) snapshot.set(token, available);
    }
    return snapshot;
  }
}
