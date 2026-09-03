// The node's half of the fee-sponsorship gate: answer "this offer will not be
// sponsored" at submission time, with numbers, instead of letting the maker
// discover it from an opaque failure after the blob has crossed the network.
//
// This is a MIRROR of the batcher's gate, never a second opinion. The batcher
// holds the wallet and stays authoritative — anyone can POST to its
// /send-input directly, bypassing this route entirely — and both sides call the
// same `evaluateSponsorship` over the same prices (the batcher polls this
// node's GET /v1/prices for them). What this adds is EARLINESS and a readable
// 422; what it must never add is a different answer.
//
// It is also deliberately not the last word for the NETWORK: the MIP-0006
// namespace is permissionless, so an unsponsored offer posted straight to
// Celestia is still indexed. The gate protects a fee, not the order book.

import {
  evaluateSponsorship,
  sponsorshipReason,
  type SponsorshipLegs,
} from "@zswap-da/offer-guard";

import { sponsorDiscount, sponsorPolicy, sponsorUnpriced } from "./env.ts";
import { pricesForColors } from "./prices.ts";

/** The 422 body (master plan §3). `null` from the check means "carry on". */
export interface SponsorshipRefusal {
  error: "NOT_SPONSORED" | "UNPRICED_TOKEN";
  reason: string;
  give_usd?: number;
  want_usd?: number;
  implied_discount?: number | null;
  unpriced?: string[];
  sponsor_discount: number;
}

/** Two decimals — a policy threshold shown to a human, not a settled amount. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface SponsorshipCheckOptions {
  /** Injected in tests; defaults to `console.warn`. */
  warn?: (line: string) => void;
}

/**
 * Decide whether `POST /v1/offers` should refuse this offer.
 *
 * Returns the 422 body, or null to continue. Never throws for a pricing
 * reason: a database that cannot answer is a 500, and an offer whose tokens
 * have no market is governed by `BATCHER_SPONSOR_UNPRICED`.
 */
export async function checkOfferSponsorship(
  dbConn: any,
  legs: SponsorshipLegs,
  options: SponsorshipCheckOptions = {},
): Promise<SponsorshipRefusal | null> {
  const policy = sponsorPolicy();
  if (policy === "off") return null;

  const warn = options.warn ?? ((line: string) => console.warn(line));
  const discount = sponsorDiscount();
  const colors = [...legs.gives, ...legs.wants].map((leg) => leg.token);
  const prices = await pricesForColors(dbConn, colors);
  const verdict = evaluateSponsorship(legs, prices, discount);

  if (verdict.verdict === "sponsored") return null;

  if (verdict.verdict === "unpriced") {
    // No market to be above or below. Test tokens live here, and D7's default
    // is to keep them flowing — the site must not close because a token has
    // no CoinGecko listing.
    if (sponsorUnpriced() === "allow") return null;
    const refusal: SponsorshipRefusal = {
      error: "UNPRICED_TOKEN",
      reason: sponsorshipReason(verdict, discount),
      unpriced: verdict.unpriced,
      sponsor_discount: discount,
    };
    if (policy === "warn") {
      warn(`[API] would refuse (policy=warn) — UNPRICED_TOKEN: ${refusal.reason}`);
      return null;
    }
    return refusal;
  }

  const refusal: SponsorshipRefusal = {
    error: "NOT_SPONSORED",
    reason: sponsorshipReason(verdict, discount),
    give_usd: round2(verdict.give_usd),
    want_usd: round2(verdict.want_usd),
    implied_discount: verdict.implied_discount,
    sponsor_discount: discount,
  };
  if (policy === "warn") {
    // One line per offer, unthrottled: these lines ARE the warn rollout (D7).
    // An operator counts them for a day, then switches to `enforce`.
    warn(
      `[API] would refuse (policy=warn) — NOT_SPONSORED: ${refusal.reason} ` +
        `(give_usd ${refusal.give_usd}, want_usd ${refusal.want_usd})`,
    );
    return null;
  }
  return refusal;
}

/** One line for the startup log: what will this node actually do? */
export function describeSponsorshipPolicy(): string {
  const policy = sponsorPolicy();
  return policy === "off"
    ? "sponsorship pre-check: policy=off"
    : `sponsorship pre-check: policy=${policy} unpriced=${sponsorUnpriced()} ` +
      `discount=${(sponsorDiscount() * 100).toFixed(2)}%`;
}
