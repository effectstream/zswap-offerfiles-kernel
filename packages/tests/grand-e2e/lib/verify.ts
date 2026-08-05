// Independent re-verification of offer bytes.
//
// The audit must never grade the API using the API. Every "is this offer
// genuine / are these the right legs" question is answered HERE, by running
// the same validator the node runs but from the suite's own process, against
// bytes we decoded ourselves.
//
// The difference from every other validate call in this suite: `crypto:
// "verify"`. The node defers proof verification to the end of its ladder for
// cost reasons; buildOffer uses "defer" because proofs are the node's job. An
// audit has no such excuse — a row can be hash-correct, structurally valid and
// still carry a forged proof, and the only way to know is to pay for
// wellFormed.

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import {
  getBlankRefState,
  validateZswapOfferBytes,
  type OfferValidation,
} from "@zswap-da/validator";

/** Same bound the node enforces (OFFER_MAX_BYTES). */
const MAX_BYTES = 1024 * 1024;

/**
 * Full ladder, proofs and signatures included.
 *
 * `tblock` MATTERS and must be the moment the node accepted the offer, not
 * now. `wellFormed` runs `ttl_check_weak` over the transaction's intents, so
 * any offer with an unshielded leg carries a real deadline (Intent.ttl is
 * non-optional) — and re-validating it after that deadline fails, correctly,
 * for a blob that was perfectly valid when indexed.
 *
 * Measured the hard way: auditing with wall-clock `new Date()` flagged three
 * archived offers as PROOF_INVALID at the end of a 55-minute run. All three
 * had unshielded inputs and intent TTLs that had passed minutes earlier. The
 * code compounded the confusion — validate.ts labels every non-signature
 * wellFormed failure PROOF_INVALID, so an expiry reads as a forged proof.
 *
 * Callers pass the stored `metadata_created_at` (the L2 block timestamp of
 * ingestion). That also makes the audit ask the RIGHT question: not "would we
 * accept this now" but "was this genuinely valid at the moment we accepted
 * it" — which is the invariant the history is supposed to hold.
 */
export function fullyValidate(raw: Uint8Array, acceptedAt: Date): OfferValidation {
  return validateZswapOfferBytes(raw, {
    refState: getBlankRefState(net.id),
    tblock: acceptedAt,
    maxBytes: MAX_BYTES,
    crypto: "verify",
  });
}

/** Convenience for the many call sites holding a stored bech32m string. */
export function fullyValidateBech32(blob: string, acceptedAt: Date): OfferValidation {
  return fullyValidate(OfferFiles.decode(blob), acceptedAt);
}

/**
 * Canonical, order-independent rendering of an offer's legs, for comparing a
 * derivation against what was stored or served. Sorted because neither the DB
 * nor the API promises leg order, and `kind` is included because MIP-0006
 * keeps layers separate — a give of shielded X against a want of unshielded X
 * is two legs, never one.
 */
export function legKey(direction: "G" | "W", leg: { token: string; amount: string; kind?: string; type?: string }): string {
  return `${direction}|${leg.token.toLowerCase()}|${leg.amount}|${leg.kind ?? leg.type ?? "?"}`;
}

/** The legs a transaction actually declares, as a sorted key list. */
export function derivedLegKeys(v: OfferValidation): string[] {
  return [
    ...(v.gives ?? []).map((l) => legKey("G", l)),
    ...(v.wants ?? []).map((l) => legKey("W", l)),
  ].sort();
}
