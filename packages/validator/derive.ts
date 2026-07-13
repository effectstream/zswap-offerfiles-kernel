import { Buffer } from "node:buffer";
import { addressFromKey } from "@midnight-ntwrk/ledger-v8";
import type { UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";
import { P2pAtomicSwaps, UnknownTokenTagError } from "@effectstream/mip-zswap-offer/mip6";

import type { OfferLeg, UnshieldedSpendRef } from "./types.ts";

// Re-export so existing validator consumers keep a single import path.
export { UnknownTokenTagError };

// Normalize a value that may be a Uint8Array or a hex string into lowercase
// hex (no `0x` prefix). ledger-v8 returns nullifiers / owner keys / intent
// hashes as either form depending on the field. Mirrors the helper in the
// node's state-machine so indexing and validation agree byte-for-byte.
export function bytesOrStringToHex(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex").toLowerCase();
  }
  if (typeof value === "string") {
    const clean = value.startsWith("0x") || value.startsWith("0X")
      ? value.slice(2)
      : value;
    return clean.toLowerCase();
  }
  return String(value).toLowerCase();
}

// The set of shielded offers carried by a transaction: the guaranteed segment
// plus every non-guaranteed (fallible) segment.
function shieldedOffersOf(tx: UnprovenTransaction): any[] {
  const offers: any[] = [];
  if (tx.guaranteedOffer) offers.push(tx.guaranteedOffer);
  const fallible = tx.fallibleOffer as any;
  if (fallible && typeof fallible.values === "function") {
    for (const segOffer of fallible.values() as Iterable<any>) {
      if (segOffer) offers.push(segOffer);
    }
  }
  return offers;
}

// Collect every shielded nullifier the offer consumes, across guaranteed +
// fallible segments and both `inputs` and `transients`. The Midnight fetcher
// detects consumption segment-agnostically, so indexing must match.
export function collectNullifiers(tx: UnprovenTransaction): string[] {
  const nullifiers: string[] = [];
  for (const o of shieldedOffersOf(tx)) {
    for (const input of o.inputs ?? []) {
      nullifiers.push(bytesOrStringToHex(input.nullifier));
    }
    for (const t of o.transients ?? []) {
      nullifiers.push(bytesOrStringToHex(t.nullifier));
    }
  }
  return nullifiers;
}

// Collect the (owner, intentHash, outputNo) triples for every unshielded UTXO
// the offer spends. `UtxoSpend.owner` is a raw SignatureVerifyingKey; apply
// `addressFromKey` so it matches the 32-byte address the indexer reports on
// consumption (the `midnight-unshielded-spend` path).
export function collectUnshieldedSpends(
  tx: UnprovenTransaction,
): UnshieldedSpendRef[] {
  const spends: UnshieldedSpendRef[] = [];
  const intents = (tx as any).intents;
  if (intents && typeof intents.values === "function") {
    for (const intent of intents.values() as Iterable<any>) {
      const unshieldedOffers = [
        intent.guaranteedUnshieldedOffer,
        intent.fallibleUnshieldedOffer,
      ].filter(Boolean);
      for (const offer of unshieldedOffers) {
        for (const spend of offer.inputs ?? []) {
          const ownerSvk = bytesOrStringToHex(spend.owner);
          spends.push({
            owner: addressFromKey(ownerSvk).toLowerCase(),
            intentHash: bytesOrStringToHex(spend.intentHash).toLowerCase(),
            outputNo: Number(spend.outputNo),
          });
        }
      }
    }
  }
  return spends;
}

/**
 * Untagged gives/wants for DB/API compatibility.
 *
 * Delegates to MIP-0006 `P2pAtomicSwaps.deriveTokenLegs`, then merges by token
 * color only (dropping SHIELDED/UNSHIELDED) so `offer_file_tokens` uniqueness
 * `(offer_file_id, token_color, direction)` is preserved. Callers that need
 * layer tags should use `@effectstream/mip-zswap-offer/mip6` directly.
 */
export function deriveLegs(
  tx: UnprovenTransaction,
): { gives: OfferLeg[]; wants: OfferLeg[] } {
  const { gives: taggedGives, wants: taggedWants } = P2pAtomicSwaps.deriveTokenLegs(tx);

  // Re-merge by color: same hex on both layers net against each other, matching
  // the pre-MIP6 validator behavior and the DB unique key.
  const merged = new Map<string, bigint>();
  for (const g of taggedGives) {
    merged.set(g.token, (merged.get(g.token) ?? 0n) + BigInt(g.amount));
  }
  for (const w of taggedWants) {
    merged.set(w.token, (merged.get(w.token) ?? 0n) - BigInt(w.amount));
  }

  const gives: OfferLeg[] = [];
  const wants: OfferLeg[] = [];
  for (const [token, delta] of merged) {
    if (delta > 0n) gives.push({ token, amount: delta.toString() });
    else if (delta < 0n) wants.push({ token, amount: (-delta).toString() });
  }
  return { gives, wants };
}
