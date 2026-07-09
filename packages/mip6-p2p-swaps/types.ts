/**
 * MIP-0006 payload and discovery types.
 *
 * Spec: WIP MIP6 — On-chain Offer Payload / Off-chain Offer Payload.
 */

export type TokenKind = "SHIELDED" | "UNSHIELDED";

/** One give or want leg; `amount` is a non-negative decimal string. */
export interface TokenLeg {
  token: string;
  amount: string;
  type: TokenKind;
}

/**
 * What a maker publishes to a DA layer (Celestia recommended).
 * `offer` is the MIP-0005 raw Transaction bytes — NOT the bech32m string.
 */
export interface OnchainOfferPayload {
  version: 1;
  offer: Uint8Array;
  /** Optional free-form note. UNTRUSTED — not authenticated. */
  unverifiedMessage?: string;
}

export type OfferStatus = "live" | "consumed" | "expired";

/**
 * What an indexer serves for discovery. Everything under `computed` is
 * derived or observed — never trusted from the maker.
 */
export interface OffchainOfferPayload {
  version: 1;
  /** MIP-0005 bech32m rendering for display. */
  offerBech32: string;
  unverifiedMessage?: string;
  computed: {
    gives: TokenLeg[];
    wants: TokenLeg[];
    /** ISO 8601 from the earliest intent TTL, when present. */
    expiresAt?: string;
    /** Shielded input nullifiers (hex) for liveness watching. */
    inputNullifiers: string[];
    /** ISO 8601 when the indexer first saw the offer. */
    firstSeenAt: string;
    status: OfferStatus;
  };
}
