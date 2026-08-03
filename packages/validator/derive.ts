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
 * The offer's shielded output commitments — plaintext fields of the
 * serialized outputs (commitments are the public leaves of the zswap Merkle
 * tree; only coin contents are private). These are the offer's FILL MARKERS:
 * transaction merging preserves outputs verbatim, so a settling tx creates
 * exactly these commitments on-chain, while a cancel creates none of them.
 * Guaranteed + per-segment fallible outputs; transients excluded (created
 * and spent inside the offer tx itself — they mark nothing).
 */
export function collectOutputCommitments(tx: UnprovenTransaction): string[] {
  const commitments: string[] = [];
  const offers = [
    (tx as any).guaranteedOffer ?? (tx as any).guaranteedCoins,
    ...(() => {
      const fallible = (tx as any).fallibleOffer ?? (tx as any).fallibleCoins;
      if (!fallible) return [];
      if (typeof fallible.values === "function") return [...fallible.values()];
      return [fallible];
    })(),
  ].filter(Boolean);
  for (const offer of offers) {
    for (const out of offer.outputs ?? []) {
      const c = (out as any).commitment;
      if (c != null) commitments.push(bytesOrStringToHex(c).toLowerCase());
    }
  }
  return commitments;
}

/**
 * Layer-tagged gives/wants, verbatim from MIP-0006 `deriveTokenLegs`.
 *
 * The codec already nets per (color, layer) and keeps layers separate — the
 * authoritative semantics. An earlier revision re-merged by color only,
 * which NETTED the same color across layers: a give of shielded X against a
 * want of unshielded X cancelled out, misstating the offer's actual terms
 * (and could flip a genuine two-sided offer into NOT_A_SWAP). The DB
 * uniqueness now includes `kind`, so no merging is needed or wanted.
 */
export function deriveLegs(
  tx: UnprovenTransaction,
): { gives: OfferLeg[]; wants: OfferLeg[] } {
  const { gives, wants } = P2pAtomicSwaps.deriveTokenLegs(tx);
  const tag = (l: { token: string; amount: string; type: string }): OfferLeg => ({
    token: l.token,
    amount: l.amount,
    kind: l.type === "UNSHIELDED" ? "UNSHIELDED" : "SHIELDED",
  });
  return { gives: gives.map(tag), wants: wants.map(tag) };
}
