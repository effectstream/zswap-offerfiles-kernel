// @zswap-da/offer-guard — the checks the node and the batcher must AGREE on,
// defined once.
//
// Two independent gates look at every offer: the batcher (protecting its own
// wallet before paying a Celestia fee) and the node's STM (deciding what gets
// indexed; the authoritative filter, since anyone can post to the namespace
// directly). If their rules drift, one pays for blobs the other rejects.
// This package holds the shared pieces:
//
//   - offerHashFromBlob(): the content address (MIP-0006 offerId) — hex
//     sha256 of the raw MIP-0005 transaction bytes, never the bech32m string
//   - the ordered ladder (cheap → indexed → crypto LAST), as `guardOffer()`
//     for async tools/services with pluggable dedup/liveness checks. The node
//     API and STM use the same validator-owned liveness descriptors through
//     their DB adapters rather than copy this callback wrapper.
//   - DedupStore: a bounded in-memory published-hash set for the batcher,
//     which has no database
//
// The STM cannot call the async guard (its transitions are World.resolve
// generators), so state-machine.ts inlines the SAME ladder in generator form
// over these primitives — if you change the order here, change it there.
import { createHash } from "node:crypto";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import {
  evaluateOfferLiveness,
  getBlankRefState,
  validateZswapOffer,
  verifyOfferCrypto,
  type OfferValidation,
  type UnshieldedSpendRef,
} from "@zswap-da/validator";

/**
 * The MIP-0006 shared Celestia namespace. One namespace = one liquidity pool:
 * every compliant UI, indexer, and bot reads the same offer stream, so an
 * offer made in one dApp is takeable in any other. Per-dApp namespaces would
 * re-silo liquidity, defeating the standard's purpose — deployments MUST NOT
 * override this except for isolated dev/e2e runs.
 *
 * Celestia namespaces are 29 bytes: a version byte plus a 28-byte id. For
 * version-0 (user) namespaces the first 18 id bytes MUST be zero, leaving 10
 * freely chosen bytes — ours is ASCII `mn-swap-v1`. Config carries just that
 * 10-byte suffix; the sync layer right-aligns it into the 28-byte id, which
 * yields exactly the MIP's `0x00` + 18 zero bytes + suffix layout.
 */
export const MIP6_NAMESPACE_ID_SUFFIX_HEX = "6d6e2d737761702d7631"; // "mn-swap-v1"

/** The full 29-byte namespace (version 0x00 ‖ 18×0x00 ‖ suffix). */
export function mip6NamespaceBytes(): Uint8Array {
  const suffix = MIP6_NAMESPACE_ID_SUFFIX_HEX;
  const bytes = new Uint8Array(29);
  for (let i = 0; i < 10; i++) {
    bytes[19 + i] = parseInt(suffix.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Content-addressed offer identity (the MIP-0006 `offerId`): hex sha256 over
 * the offer's canonical bytes — the raw MIP-0005 `Transaction`
 * serialization, NOT the bech32m string. Hashing the raw bytes keeps the id
 * stable across display encodings, and (with the on-chain envelope removed)
 * makes it also the hash of the DA blob itself.
 *
 * Throws when the blob is not a decodable `swapoffer1…` string — callers
 * answer those without touching any store.
 */
export function offerHashFromBlob(blob: string): string {
  return createHash("sha256").update(OfferFiles.decode(blob)).digest("hex");
}

/**
 * Content hash from RAW offer bytes — the on-chain (DA) form. Equal to
 * offerHashFromBlob(encode(bytes)) since the hash is over the bytes either
 * way; used by the STM, which ingests raw bytes off Celestia.
 */
export function offerHashFromBytes(rawTx: Uint8Array): string {
  return createHash("sha256").update(rawTx).digest("hex");
}

/**
 * Encode raw offer bytes to the MIP-0005 bech32m string (for storage/display
 * and the indexer API). Thin re-export of the codec so the STM has one import.
 */
export function offerBytesToBech32(rawTx: Uint8Array): string {
  return OfferFiles.encode(rawTx);
}

/**
 * The Celestia read transport, made explicit and testable. The framework
 * fetcher sets `suppliedValue = atob(blob.data)` — a latin1 string whose
 * char codes ARE the raw bytes (0–255). This recovers the Uint8Array. The
 * inverse (bytesToLatin1) mirrors what btoa consumes, so round-trip tests can
 * replicate the exact wire path without a live Celestia node.
 */
export function latin1ToBytes(suppliedValue: string): Uint8Array {
  const out = new Uint8Array(suppliedValue.length);
  for (let i = 0; i < suppliedValue.length; i++) {
    out[i] = suppliedValue.charCodeAt(i) & 0xff;
  }
  return out;
}
export function bytesToLatin1(rawTx: Uint8Array): string {
  let s = "";
  for (const b of rawTx) s += String.fromCharCode(b);
  return s;
}

/** Async liveness/dedup checks a caller can plug in (all optional). */
export interface LivenessChecks {
  /** Already indexed/archived/published? Return the known status if so. */
  isDuplicate?: (offerHash: string) => Promise<string | null>;
  isNullifierSpent?: (nullifier: string) => Promise<boolean>;
  /** Unshielded UTXO currently live (created and unspent)? */
  isUnshieldedLive?: (ref: UnshieldedSpendRef) => Promise<boolean>;
  isKnownRoot?: (root: string) => Promise<boolean>;
}

export interface GuardOpts extends LivenessChecks {
  networkId: string;
  maxBytes: number;
  /** Deterministic block time for `wellFormed`; defaults to now. */
  tblock?: Date;
}

export type GuardResult =
  | { ok: true; offerHash: string; validation: OfferValidation }
  | {
    ok: false;
    code: string;
    reason: string;
    offerHash?: string;
    validation?: OfferValidation;
  };

/**
 * The full ordered ladder for async callers:
 *
 *   structure (crypto deferred) → hash + dedup → liveness → wellFormed LAST
 *
 * Ordering rationale (same as the STM): proof verification dominates every
 * other step by orders of magnitude, so replayed and stale blobs must be
 * discarded by the cheap, indexed checks before crypto runs. Nothing is
 * skipped — `ok: true` always means wellFormed passed.
 */
export async function guardOffer(
  blob: string,
  opts: GuardOpts,
): Promise<GuardResult> {
  const validation = validateZswapOffer(blob, {
    refState: getBlankRefState(opts.networkId),
    tblock: opts.tblock ?? new Date(),
    maxBytes: opts.maxBytes,
    crypto: "defer",
  });
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code ?? "INVALID",
      reason: validation.reason ?? "",
      validation,
    };
  }

  const offerHash = offerHashFromBlob(blob);

  if (opts.isDuplicate) {
    const status = await opts.isDuplicate(offerHash);
    if (status != null) {
      return {
        ok: false,
        code: "DUPLICATE_OFFER",
        reason: `offer already known with status '${status}'`,
        offerHash,
        validation,
      };
    }
  }

  const liveness = await evaluateOfferLiveness(validation, async (descriptor) => {
    switch (descriptor.kind) {
      case "nullifier":
        return opts.isNullifierSpent
          ? !(await opts.isNullifierSpent(descriptor.nullifier))
          : undefined;
      case "unshielded":
        return opts.isUnshieldedLive
          ? await opts.isUnshieldedLive(descriptor.ref)
          : undefined;
      case "root":
        return opts.isKnownRoot
          ? await opts.isKnownRoot(descriptor.root)
          : undefined;
    }
  });
  if (!liveness.ok) {
    return {
      ok: false,
      code: liveness.code,
      reason: liveness.reason,
      offerHash,
      validation,
    };
  }

  const crypto = verifyOfferCrypto(validation.tx!, {
    refState: getBlankRefState(opts.networkId),
    tblock: opts.tblock ?? new Date(),
  });
  if (!crypto.ok) {
    return {
      ok: false,
      code: crypto.code,
      reason: crypto.reason,
      offerHash,
      validation,
    };
  }

  return { ok: true, offerHash, validation };
}

/**
 * Bounded in-memory set of published offer hashes — the batcher's dedup
 * store. The batcher has no database; its job is protecting its own wallet
 * from paying twice for the same bytes, and the realistic attack is a rapid
 * replay burst, which memory covers. Insertion-ordered eviction caps memory.
 *
 * LIMITATION (documented, accepted): the set empties on restart, so a replay
 * straddling a batcher restart costs one duplicate fee. The node-side STM
 * dedup is content-addressed and permanent — the network never indexes the
 * duplicate; only the fee is lost.
 */
export class DedupStore {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 100_000) {}

  has(offerHash: string): boolean {
    return this.seen.has(offerHash);
  }

  add(offerHash: string): void {
    if (this.seen.has(offerHash)) return; // re-add must not evict anything
    if (this.seen.size >= this.maxEntries) {
      // Evict the oldest insertion — Set iterates in insertion order.
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(offerHash);
  }

  get size(): number {
    return this.seen.size;
  }
}

// The sponsorship rule, shared by the quote, the node's POST /v1/offers
// pre-check and the batcher's validateInput. Re-exported here so callers have
// one import from this package, exactly as for the guard ladder above.
export {
  evaluateSponsorship,
  sponsorDiscountFromBps,
  sponsorshipReason,
  SPONSORSHIP_EPSILON_USD,
  type PriceRow,
  type PriceSource,
  type SponsorshipLegs,
  type SponsorshipVerdict,
} from "./sponsorship.ts";
