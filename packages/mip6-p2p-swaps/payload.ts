/**
 * MIP-0006 — on-chain / off-chain payload builders.
 *
 * These construct the payloads defined in the MIP. Publishing to Celestia and
 * serving them from the indexer API are intentionally left to callers for now.
 */

import { encodeOffer } from "@zswap-da/mip5-offer-files";
import type { UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";

import { deriveTokenLegs } from "./derive.ts";
import { assertTwoSided } from "./two-sided.ts";
import type {
  OffchainOfferPayload,
  OfferStatus,
  OnchainOfferPayload,
} from "./types.ts";

/** Build the DA-layer payload (raw MIP-0005 offer bytes + optional note). */
export function buildOnchainOfferPayload(
  offerBytes: Uint8Array,
  unverifiedMessage?: string,
): OnchainOfferPayload {
  if (!(offerBytes instanceof Uint8Array)) {
    throw new TypeError("buildOnchainOfferPayload: offer must be a Uint8Array");
  }
  const payload: OnchainOfferPayload = { version: 1, offer: offerBytes };
  if (unverifiedMessage !== undefined) {
    payload.unverifiedMessage = unverifiedMessage;
  }
  return payload;
}

export interface OffchainOfferInput {
  /** Raw MIP-0005 Transaction bytes (same as OnchainOfferPayload.offer). */
  offerBytes: Uint8Array;
  tx: UnprovenTransaction;
  /** Shielded input nullifiers (hex), already collected by the caller. */
  inputNullifiers: string[];
  firstSeenAt: string;
  status: OfferStatus;
  unverifiedMessage?: string;
  /** Override; otherwise taken from earliestIntentTtl(tx) when present. */
  expiresAt?: string;
  /** When true (default), reject give-only / want-only offers. */
  requireTwoSided?: boolean;
}

/**
 * Earliest intent TTL on the transaction, as an ISO 8601 string.
 * Returns undefined when the offer carries no intent TTL.
 */
export function earliestIntentTtl(tx: UnprovenTransaction): string | undefined {
  const intents = (tx as any).intents;
  if (!intents || typeof intents.values !== "function") return undefined;

  let earliestMs: number | undefined;
  for (const intent of intents.values() as Iterable<any>) {
    const ttl = intent?.ttl;
    if (ttl == null) continue;
    let ms: number;
    if (ttl instanceof Date) {
      ms = ttl.getTime();
    } else if (typeof ttl === "number" || typeof ttl === "bigint") {
      // Ledger TTLs are typically seconds since epoch; treat large values as ms.
      const n = Number(ttl);
      ms = n > 1e12 ? n : n * 1000;
    } else if (typeof ttl === "string") {
      ms = Date.parse(ttl);
    } else {
      continue;
    }
    if (!Number.isFinite(ms)) continue;
    if (earliestMs === undefined || ms < earliestMs) earliestMs = ms;
  }
  return earliestMs === undefined ? undefined : new Date(earliestMs).toISOString();
}

/**
 * Build the indexer discovery payload from offer bytes + a deserialized tx.
 * Derives gives/wants itself (never trusts maker-asserted terms).
 */
export function toOffchainOfferPayload(
  input: OffchainOfferInput,
): OffchainOfferPayload {
  const { gives, wants } = deriveTokenLegs(input.tx);
  if (input.requireTwoSided !== false) {
    assertTwoSided(gives, wants);
  }

  const expiresAt =
    input.expiresAt ?? earliestIntentTtl(input.tx);

  const computed: OffchainOfferPayload["computed"] = {
    gives,
    wants,
    inputNullifiers: input.inputNullifiers,
    firstSeenAt: input.firstSeenAt,
    status: input.status,
  };
  if (expiresAt !== undefined) computed.expiresAt = expiresAt;

  const payload: OffchainOfferPayload = {
    version: 1,
    offerBech32: encodeOffer(input.offerBytes),
    computed,
  };
  if (input.unverifiedMessage !== undefined) {
    payload.unverifiedMessage = input.unverifiedMessage;
  }
  return payload;
}
