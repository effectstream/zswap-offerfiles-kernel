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
 * Full ladder, proofs and signatures included. `tblock` is wall clock: the
 * suite runs against a live chain whose block time tracks it, and the only
 * time-sensitive step is wellFormed's TTL check, which a freshly-published
 * offer passes either way.
 */
export function fullyValidate(raw: Uint8Array): OfferValidation {
  return validateZswapOfferBytes(raw, {
    refState: getBlankRefState(net.id),
    tblock: new Date(),
    maxBytes: MAX_BYTES,
    crypto: "verify",
  });
}

/** Convenience for the many call sites holding a stored bech32m string. */
export function fullyValidateBech32(blob: string): OfferValidation {
  return fullyValidate(OfferFiles.decode(blob));
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
