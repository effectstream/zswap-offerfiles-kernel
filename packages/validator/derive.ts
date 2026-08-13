import { Buffer } from "node:buffer";
import { addressFromKey } from "@midnight-ntwrk/ledger-v8";
import type { UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";
import { P2pAtomicSwaps, UnknownTokenTagError } from "@effectstream/mip-zswap-offer/mip6";

import type { OfferLeg, UnshieldedSpendRef } from "./types.ts";

// Re-export so existing validator consumers keep a single import path.
//
// UNKNOWN_TOKEN, like ROOT_UNREADABLE, is NOT reachable from the wire —
// measured 2026-08-12 (#5 phase (a)); see the census note in extract-root.ts
// for the method and numbers. A token tag lives inside the transaction's SCALE
// stream, so a tag mutation bad enough to be unrecognised also breaks
// deserialization, and the ledger refuses the transaction first.
//
// The check stays: it is a fail-closed guard against a ledger upgrade
// introducing a tag this code does not know, which is a real risk and exactly
// what it should cover. It just cannot be driven by a hostile publisher, so it
// has no e2e fixture and its unit doubles are the complete coverage. Worth
// raising with the SDK if it ever grows a way to emit offers with arbitrary
// token configurations.
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
 * The offer's own UNSHIELDED outputs — its fill markers on that layer, the
 * counterpart of `collectOutputCommitments`.
 *
 * A settling transaction pays the maker exactly what the offer asked for, and
 * merging preserves outputs verbatim, so a genuine settlement creates all of
 * these on chain while a maker walking away creates none. That is the same
 * proof the shielded path gets from output commitments — and until now the
 * unshielded path had no equivalent, which is why every unshielded
 * consumption classified `consumed`.
 *
 * Identified by (owner, tokenType, value) and NOT by intent hash or output
 * index — on the belief that those belong to the SETTLING intent, unknowable at
 * publish time. REFUTED by experiment (2026-08-07, grand-e2e
 * REMAINING-ISSUES.md #5): per-party intents survive Transaction.merge, and the
 * payout's creating-intent hash is intentHash(0) of the offer's own intent —
 * computable RIGHT HERE, from `tx`, at ingestion. When #5 lands this function
 * returns exact (owner, intentHash(0), outputNo) identities instead of shapes;
 * shape matching is interim and forgeable across same-shape offers.
 */
export function collectUnshieldedOutputs(
  tx: UnprovenTransaction,
): { owner: string; tokenType: string; value: string }[] {
  const outputs: { owner: string; tokenType: string; value: string }[] = [];
  const intents = (tx as any).intents;
  if (!intents || typeof intents.values !== "function") return outputs;
  for (const intent of intents.values() as Iterable<any>) {
    for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer].filter(Boolean)) {
      for (const out of offer.outputs ?? []) {
        const owner = bytesOrStringToHex(out.owner ?? out.address);
        const tokenType = bytesOrStringToHex(out.type ?? out.tokenType);
        const value = String(out.value ?? out.amount ?? "");
        if (owner && tokenType && value) outputs.push({ owner, tokenType, value });
      }
    }
  }
  return outputs;
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
