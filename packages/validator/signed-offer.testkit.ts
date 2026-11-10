// Chain-valid offers with a chosen intent TTL, built offline (00056 T1/T2).
//
// shapes.testkit.ts builds unshielded SHAPES that are mock-proven and
// unsigned, so they can never pass `wellFormed`. The intent TTL bound is
// checked INSIDE `wellFormed`, so testing it needs offers that pass every
// other check there. These do:
//
//   - the unshielded spend is signed with a real key over the intent's own
//     `signatureData(segment)`;
//   - the transaction is proven with a prover that is never called — an
//     unshielded-only transaction has no ZK proofs to make — and then bound,
//     exactly the markers a wallet-finalized offer carries.
//
// The kernel validator accepts them in full (proofs, signatures, binding) when
// the TTL is inside `tblock <= ttl <= tblock + global_ttl`. The UTXO they spend
// does not exist, so indexed liveness needs a `created_unshielded` row for
// `spend` (tests seed it); they can never settle on a chain.
//
// `withIntent` merges an offer with an otherwise empty, bound intent carrying a
// TTL: applied to the committed shielded fixture it yields a MIXED offer
// (shielded legs + an intent), which the ledger treats with both rules.

import {
  Intent,
  LedgerParameters,
  SignatureEnabled,
  Transaction,
  UnshieldedOffer,
  addressFromKey,
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
} from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import { collectUnshieldedSpends } from "./derive.ts";
import type { UnshieldedSpendRef } from "./types.ts";

const hex32 = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);

/** Token colours, as in shapes.testkit.ts. */
export const SIGNED_GIVE_TOKEN = hex32(0x11);
export const SIGNED_WANT_TOKEN = hex32(0x22);

/** A prover for transactions that need no proofs; any call is a test bug. */
const NO_PROVER = {
  check: async (): Promise<(bigint | undefined)[]> => {
    throw new Error("signed-offer testkit: unexpected proof check");
  },
  prove: async (): Promise<Uint8Array> => {
    throw new Error("signed-offer testkit: unexpected proof request");
  },
  lookupKey: async () => {
    throw new Error("signed-offer testkit: unexpected key lookup");
  },
};

const COST_MODEL = () => LedgerParameters.initialParameters().transactionCostModel.runtimeCostModel;

async function proveAndBind(preProof: any): Promise<any> {
  const proven = await preProof.prove(NO_PROVER, COST_MODEL());
  return proven.bind();
}

export interface SignedOffer {
  /** Raw MIP-0005 transaction bytes (what Celestia carries). */
  bytes: Uint8Array;
  /** bech32m `swapoffer1…` form (what the API and batcher take). */
  blob: string;
  /** The TTL written into the intent. */
  ttl: Date;
  /** The spent UTXO, as the validator derives it (seed it as live). */
  spend: UnshieldedSpendRef;
}

/**
 * A signed, bound, unshielded-only offer: spend 100 of SIGNED_GIVE_TOKEN,
 * declare a payout of 125 SIGNED_WANT_TOKEN to the maker, one intent with
 * `ttl`. A fresh random maker key per call, so markers never collide.
 */
export async function signedUnshieldedOffer(
  ttl: Date,
  networkId = "undeployed",
): Promise<SignedOffer> {
  const sk = sampleSigningKey();
  const vk = signatureVerifyingKey(sk);
  const intent: any = Intent.new(ttl);
  intent.guaranteedUnshieldedOffer = UnshieldedOffer.new(
    [{ value: 100n, owner: vk, type: SIGNED_GIVE_TOKEN, intentHash: hex32(0xcc), outputNo: 0 } as any],
    [{ value: 125n, owner: addressFromKey(vk), type: SIGNED_WANT_TOKEN } as any],
    [],
  );
  const tx: any = Transaction.fromParts(networkId, undefined, undefined, intent);
  // Sign each intent over its own segment's signature data, then write the
  // signed intents back (the getter hands out copies).
  const signed = new Map<number, any>();
  for (const [segment, it] of tx.intents as Map<number, any>) {
    const signature = new SignatureEnabled(signData(sk, it.signatureData(segment)));
    it.guaranteedUnshieldedOffer = it.guaranteedUnshieldedOffer.addSignatures([signature]);
    signed.set(segment, it);
  }
  tx.intents = signed;
  const bound = await proveAndBind(tx);
  const bytes: Uint8Array = bound.serialize();
  const spends = collectUnshieldedSpends(bound);
  if (spends.length !== 1) throw new Error(`expected one unshielded spend, got ${spends.length}`);
  return { bytes, blob: OfferFiles.encode(bytes), ttl, spend: spends[0]! };
}

/**
 * `offerBytes` (a proven, bound offer) merged with a bound intent that carries
 * only `ttl`. For the shielded fixture this is a mixed offer: shielded legs
 * (root-bound) plus an intent (TTL-bound).
 */
export async function withIntent(
  offerBytes: Uint8Array,
  ttl: Date,
  networkId = "undeployed",
): Promise<{ bytes: Uint8Array; blob: string; ttl: Date }> {
  const offer: any = Transaction.deserialize("signature", "proof", "binding", offerBytes);
  const intentOnly: any = Transaction.fromPartsRandomized(
    networkId,
    undefined,
    undefined,
    Intent.new(ttl) as any,
  );
  const merged = offer.merge(await proveAndBind(intentOnly));
  const bytes: Uint8Array = merged.serialize();
  return { bytes, blob: OfferFiles.encode(bytes), ttl };
}
