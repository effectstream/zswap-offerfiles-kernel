// The sponsorship rule — "is this offer a good enough trade that we will pay
// the Celestia fee for it?" — defined ONCE.
//
// Three places ask it and they must never disagree:
//   * GET /v1/quote's `sponsored` flag, which is what the maker sees before
//     posting;
//   * POST /v1/offers' pre-check on the node, which answers 422 NOT_SPONSORED
//     before forwarding;
//   * the batcher's validateInput, which is authoritative because anyone can
//     call /send-input directly, and which is the one actually holding the
//     wallet that pays.
// A second implementation of "is this a good trade" would drift, and the
// failure mode is silent: the UI promises sponsorship the batcher then
// refuses, or the batcher pays for offers the UI already called bad.
//
// This module is in @zswap-da/offer-guard because that package is already the
// home of the checks the node and the batcher share, and it is the only
// package both depend on.

import type { OfferLeg } from "@zswap-da/validator";

/** Where a price came from. Only `fallback` is not a market price. */
export type PriceSource = "feed" | "seed" | "manual" | "fallback";

/** One token's USD price PER BASE UNIT, as served by GET /v1/prices. */
export interface PriceRow {
  price_usd: string | number;
  source: PriceSource;
}

export interface SponsorshipLegs {
  gives: readonly OfferLeg[];
  wants: readonly OfferLeg[];
}

export interface SponsorshipVerdict {
  verdict: "sponsored" | "not_sponsored" | "unpriced";
  give_usd: number;
  want_usd: number;
  /**
   * `1 − want_usd / give_usd` — how far below reference the maker priced the
   * offer. null when it cannot be stated honestly: no give value at all, or
   * an unpriced leg (the sums are then over the priced legs only and the
   * ratio between them means nothing).
   */
  implied_discount: number | null;
  /** Token colours with no price row, or a `fallback` (demo) one. Deduped. */
  unpriced: string[];
}

/**
 * Slack on the comparison, in USD. The inputs are doubles (see the note on
 * `evaluateSponsorship`), so an offer priced EXACTLY at the threshold — which
 * is what the quote's auto-suggested amount produces, i.e. the common case —
 * must not be refused because the last bit of a multiplication went the wrong
 * way. Absolute, not relative, because the values it protects are ordinary
 * trade sizes; at USD sums large enough for this to matter it is double
 * precision itself, not this constant, that is the limit.
 */
export const SPONSORSHIP_EPSILON_USD = 1e-9;

/**
 * What a process does with an offer that is not worth its Celestia fee.
 * `warn` is the rollout default (D7): a day of warn logs shows what `enforce`
 * would have refused before anything real is refused.
 */
export type SponsorPolicy = "enforce" | "warn" | "off";

/** What to do with an offer whose tokens have no market price at all. */
export type UnpricedPolicy = "allow" | "reject";

export const SPONSOR_POLICIES: readonly SponsorPolicy[] = ["enforce", "warn", "off"];
export const UNPRICED_POLICIES: readonly UnpricedPolicy[] = ["allow", "reject"];

/**
 * Parse one of the two policy variables.
 *
 * Shared because the node and the batcher read the SAME variable names (Q-6):
 * `BATCHER_SPONSOR_POLICY` and `BATCHER_SPONSOR_UNPRICED`. If they parsed them
 * separately, one process could end up in `enforce` and the other in `warn`
 * over the same string — the node answering 422 for offers the batcher would
 * happily have paid for, or worse, the reverse.
 *
 * An unrecognised value THROWS rather than falling back to the default. An
 * operator who typed `enfroce` intends to refuse unsponsored offers; quietly
 * sponsoring everything instead is the exact outcome they were preventing,
 * with nothing anywhere to say it happened.
 */
function parsePolicy<T extends string>(
  key: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of ${allowed.join(" | ")}, got "${value}"`);
  }
  return value as T;
}

export function parseSponsorPolicy(
  raw: string | undefined,
  key = "BATCHER_SPONSOR_POLICY",
): SponsorPolicy {
  return parsePolicy(key, raw, SPONSOR_POLICIES, "warn");
}

export function parseUnpricedPolicy(
  raw: string | undefined,
  key = "BATCHER_SPONSOR_UNPRICED",
): UnpricedPolicy {
  return parsePolicy(key, raw, UNPRICED_POLICIES, "allow");
}

/** Basis points → fraction. 250 bps = 0.025 = the 2.5% default. */
export function sponsorDiscountFromBps(bps: number): number {
  if (!Number.isFinite(bps) || bps < 0 || bps >= 10_000) {
    throw new Error(`sponsor discount must be in [0, 10000) bps, got ${bps}`);
  }
  return bps / 10_000;
}

function toUsd(amount: string, price: string | number): number {
  return Number(amount) * Number(price);
}

/**
 * Decide whether an offer earns its Celestia fee.
 *
 * `sponsored ⇔ want_usd ≤ give_usd × (1 − discount)`: the maker must be asking
 * for at least `discount` less value than they are giving up.
 *
 * ── Why this is the quote's rule, exactly ─────────────────────────────────
 * For a single give leg (amount f, price pf) and a single want leg (amount t,
 * price pt):
 *
 *     want_usd ≤ give_usd·(1 − d)
 *   ⇔ t·pt     ≤ f·pf·(1 − d)
 *   ⇔ t/f      ≤ (pf/pt)·(1 − d)          (f, pt > 0)
 *   ⇔ implied_rate ≤ market_rate·(1 − d)
 *   ⇔ 1 − implied_rate/market_rate ≥ d
 *   ⇔ discount ≥ d
 *
 * and `discount ≥ SPONSOR_DISCOUNT` is precisely what
 * `quoteWithPrices()` reports as `sponsored`. So the batcher's basket-aware
 * USD rule and the maker's per-pair rate rule are one rule, and the property
 * test in sponsorship.test.ts asserts they agree on random pairs rather than
 * trusting this paragraph.
 *
 * ── Doubles ──────────────────────────────────────────────────────────────
 * give_usd/want_usd are computed in double precision, deliberately. This is a
 * POLICY THRESHOLD, not a settlement amount: nothing is transferred on the
 * strength of these numbers, and the prices they multiply are themselves
 * daily reference figures with far less than double precision of accuracy.
 * The amounts that ARE settled stay in bigint, in the ledger and in
 * quoteWithPrices' suggested amount.
 *
 * ── Unpriced ─────────────────────────────────────────────────────────────
 * A leg whose token has no row, or only the deterministic `fallback` demo
 * price, makes the whole verdict `unpriced`: there is no market to be above
 * or below. Test tokens live here, and the CALLER decides what that means
 * (BATCHER_SPONSOR_UNPRICED: `allow` sponsors them, `reject` refuses) — this
 * function never guesses.
 */
export function evaluateSponsorship(
  legs: SponsorshipLegs,
  prices: ReadonlyMap<string, PriceRow>,
  discount: number,
): SponsorshipVerdict {
  if (!Number.isFinite(discount) || discount < 0 || discount >= 1) {
    throw new Error(`sponsor discount must be a fraction in [0, 1), got ${discount}`);
  }

  const unpriced: string[] = [];
  const seenUnpriced = new Set<string>();

  const sum = (side: readonly OfferLeg[]): number => {
    let total = 0;
    for (const leg of side) {
      const color = leg.token.toLowerCase();
      const row = prices.get(color);
      if (row === undefined || row.source === "fallback") {
        if (!seenUnpriced.has(color)) {
          seenUnpriced.add(color);
          unpriced.push(color);
        }
        continue;
      }
      total += toUsd(leg.amount, row.price_usd);
    }
    return total;
  };

  const give_usd = sum(legs.gives);
  const want_usd = sum(legs.wants);

  if (unpriced.length > 0) {
    return { verdict: "unpriced", give_usd, want_usd, implied_discount: null, unpriced };
  }

  // No value given away (an empty give side, or a zero-amount one): there is
  // nothing to discount, so there is nothing to sponsor. Returning
  // not_sponsored with a null ratio is the honest answer — 1 − x/0 is not a
  // number, and reporting NaN downstream would render as "NaN%" in the UI.
  if (!(give_usd > 0)) {
    return { verdict: "not_sponsored", give_usd, want_usd, implied_discount: null, unpriced };
  }

  const threshold = give_usd * (1 - discount);
  const sponsored = want_usd <= threshold + SPONSORSHIP_EPSILON_USD;
  return {
    verdict: sponsored ? "sponsored" : "not_sponsored",
    give_usd,
    want_usd,
    implied_discount: 1 - want_usd / give_usd,
    unpriced,
  };
}

/** The human-readable half of a refusal, shared by the node's 422 and the batcher's reply. */
export function sponsorshipReason(v: SponsorshipVerdict, discount: number): string {
  if (v.verdict === "unpriced") {
    return `no market price for ${v.unpriced.join(", ")}`;
  }
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (v.implied_discount === null) {
    return `offer gives no priced value; sponsorship needs ≥ ${pct(discount)} below reference`;
  }
  const side = v.implied_discount < 0 ? "above" : "below";
  return (
    `wants ${pct(Math.abs(v.implied_discount))} ${side} reference, ` +
    `sponsorship needs ≥ ${pct(discount)} below`
  );
}
