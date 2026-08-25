// Unshielded offer SHAPES, built from the ledger API directly. (#5 phase (a))
//
// Every unshielded offer this repo has ever seen came from a wallet, and a
// wallet builds exactly one shape: a single intent whose spends and payouts
// sit in the GUARANTEED section. Four other shapes are legal on the wire and
// none of them has ever been built here, so nothing downstream — the reject
// ladder, `collectUnshieldedOutputs`, the fill-vs-cancel classifier — has ever
// been shown to handle them.
//
// This is the `probe-cross-layer.ts` lesson generalised: a wallet is not the
// only way to make a transaction, so "our wallet cannot build it" says nothing
// about what arrives at a permissionless DA namespace. `Intent`,
// `UnshieldedOffer` and `Transaction.fromParts` are public API.
//
// FINDING (phase (a)): `Transaction.fromParts` returns a PRE-PROOF transaction.
//
// Its header is `…(signature[v1],proof-preimage,embedded-fr[v1])`, and the
// validator's ladder deserializes with `("signature","proof","binding")`, which
// refuses it outright — the first build of this kit failed every test on that
// alone. A published offer is a PROVEN transaction; proving is what the
// wallet's `finalizeTransaction` does, and building from parts skips it.
//
// `mockProve()` closes the gap: it re-headers to
// `…(signature[v1],proof,pedersen-schnorr[v1])`, which is what real offers
// carry and what the ladder accepts. So the kit calls it on every shape, and
// the pre-proof form is never handed out.
//
// SCOPE — read this before using these blobs.
//
// These are structurally real and byte-faithful: they serialize, round-trip
// through `Transaction.deserialize`, and hash stably. They are NOT chain-valid.
// The ledger's own docs say a mock-proven transaction "will *not* verify", and
// on top of that these inputs reference UTXOs that were never created and carry
// no signatures. So `wellFormed` fails and nothing here can settle.
//
// That is deliberate and exactly sufficient for phase (a)'s purpose: DECODE,
// DERIVATION and the pre-crypto reject ladder all run before any proof or
// liveness work. It also means these fixtures can never prove anything about
// crypto — a shape that reaches `wellFormed` and fails there has told us
// nothing. Anything needing a real settlement is phase (c) and needs a chain.

import {
  Intent,
  Transaction,
  UnshieldedOffer,
  addressFromKey,
} from "@midnightntwrk/ledger-v9";
import type { UnprovenTransaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

/** Deterministic, so a fixture's hash is stable across runs and machines. */
const key = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);

export const MAKER_KEY = key(0xaa);
export const TAKER_KEY = key(0xbb);
/** Token colours. Real 32-byte raw token types; no contract needs to exist. */
export const GIVE_TOKEN = key(0x11);
export const WANT_TOKEN = key(0x22);

const TTL_MS = 60 * 60 * 1000;

export interface Shape {
  /** Stable id, quoted by tests and by the p4 fixture that submits it. */
  id: string;
  /** What makes this shape different, and why it is worth a fixture. */
  why: string;
  blob: string;
  tx: UnprovenTransaction;
}

/** A spend of a UTXO that does not exist — fine pre-crypto, see SCOPE.
 *  v9: `UtxoSpend.owner` is a tagged SignatureVerifyingKey, not a bare hex
 *  string — schnorr is v8's only (implicit) kind, so tagging keeps the
 *  fixtures' meaning. */
function spend(owner: string, type: string, value: bigint, outputNo = 0) {
  return {
    value,
    owner: { tag: "schnorr" as const, value: owner },
    type,
    intentHash: key(0xcc),
    outputNo,
  } as any;
}

function payout(ownerKey: string, type: string, value: bigint) {
  return {
    value,
    owner: addressFromKey({ tag: "schnorr", value: ownerKey }),
    type,
  } as any;
}

/**
 * One intent: spend `give`, declare a payout of `want` back to the maker.
 * `section` chooses which of the intent's two unshielded offers carries it —
 * the distinction the whole of #5 turns on.
 */
function makeIntent(section: "guaranteed" | "fallible", ttlMs = TTL_MS): any {
  const intent: any = Intent.new(new Date(Date.now() + ttlMs));
  const offer = UnshieldedOffer.new(
    [spend(MAKER_KEY, GIVE_TOKEN, 100n)],
    [payout(MAKER_KEY, WANT_TOKEN, 125n)],
    [],
  );
  if (section === "guaranteed") intent.guaranteedUnshieldedOffer = offer;
  else intent.fallibleUnshieldedOffer = offer;
  return intent;
}

/**
 * Mock-prove once, then derive BOTH the blob and the exposed transaction from
 * that single result. The mockProve is not cosmetic — see the FINDING above.
 *
 * Deriving both from one call is the point: an earlier cut exposed the
 * pre-proof `tx` alongside the proven `blob`, so a caller reading `shape.tx`
 * and a caller decoding `shape.blob` were looking at different transactions
 * with different headers.
 */
function shape(id: string, why: string, preProof: any): Shape {
  const proven = preProof.mockProve();
  return { id, why, blob: OfferFiles.encode(proven.serialize()), tx: proven };
}

/** Decode back to a Transaction the same way the validator's ladder does. */
export function decodeShape(blob: string): UnprovenTransaction {
  return Transaction.deserialize(
    "signature",
    "proof",
    "binding",
    OfferFiles.decode(blob),
  ) as UnprovenTransaction;
}

/**
 * The five structural shapes.
 *
 * `fromParts` places the intent at physical segment key **1**, not 0 —
 * measured, not assumed. That is precisely why the guaranteed/fallible
 * distinction is observable at all: a guaranteed output's identity uses
 * `intentHash(0)` while a fallible one uses `intentHash(physSeg)` =
 * `intentHash(1)` here, and the two hashes differ.
 */
export function structuralShapes(): Shape[] {
  const shapes: Shape[] = [];

  // CONTROL. The only shape a wallet produces, and the only one anything
  // downstream has ever been tested against. If a test fails on this one, the
  // problem is the test.
  {
    const tx = Transaction.fromParts("undeployed", undefined, undefined, makeIntent("guaranteed"));
    shapes.push(shape("guaranteed-single", "the wallet-built shape — control, everything downstream must keep handling it", tx));
  }

  // The shape the segment rule exists for. `UtxoState::apply_offer` stamps
  // guaranteed outputs with intentHash(0) but fallible ones with the intent's
  // PHYSICAL segment id. A marker computed with the wrong one can never match
  // the on-chain create, so every valid fallible settlement would classify as
  // cancelled. Nothing has ever built one of these to check.
  {
    const tx = Transaction.fromParts("undeployed", undefined, undefined, makeIntent("fallible"));
    shapes.push(shape("fallible-single", "payout sits in the fallible section — identity uses intentHash(physSeg), not intentHash(0)", tx));
  }

  // Two byte-different wrappers around the LITERAL SAME intent. `fromParts`
  // pins segment 1; `fromPartsRandomized` picks another. Same intent, same
  // spends, same payouts — different bytes, therefore a different offer_hash,
  // therefore NOT related by byte-identical dedup.
  //
  // RULED 2026-08-12: that is fine, and no intent-level dedup will be built.
  // The defence is economic — publishing costs a Celestia fee per blob, so
  // re-wrapping one intent is an attack the attacker funds, and the copies all
  // compete for the same inputs so only the first can ever settle. Full
  // reasoning at the submit gate in packages/node/api.ts.
  //
  // The pair stays in the kit as the EVIDENCE for that ruling: it proves the
  // shape is constructible and that dedup does not see it, so the decision
  // rests on a measurement rather than on an assumption about what wallets
  // emit. Phase (d) asserts the ruling rather than re-opening it.
  {
    const intent = makeIntent("guaranteed");
    const a = Transaction.fromParts("undeployed", undefined, undefined, intent);
    const b = Transaction.fromPartsRandomized("undeployed", undefined, undefined, intent);
    shapes.push(shape("same-intent-wrapper-a", "literal same intent as wrapper-b, different segment key → different bytes and hash", a));
    shapes.push(shape("same-intent-wrapper-b", "the duplicate byte-identical dedup cannot see — accepted as two offers by ruling, see api.ts", b));
  }

  // More than one intent in one transaction — what every real settlement looks
  // like (maker intent + taker intent survive the merge verbatim), but never
  // as a PUBLISHED offer. `collectUnshieldedOutputs` iterates all intents and
  // flattens, so a multi-intent offer's outputs currently lose the one thing
  // that would tell them apart.
  {
    const a = Transaction.fromParts("undeployed", undefined, undefined, makeIntent("guaranteed"));
    const b = Transaction.fromPartsRandomized("undeployed", undefined, undefined, makeIntent("guaranteed", TTL_MS + 1000));
    // Merged while still PRE-PROOF: merge combines intent maps, and doing it
    // before proving matches how a real settlement is assembled.
    const merged = (a as any).merge(b);
    shapes.push(shape("multi-intent", "two intents in one published offer — outputs from different intents flatten together", merged));
  }

  return shapes;
}

/**
 * Hostile wire inputs (absorbed from #20).
 *
 * Three reject codes in the ladder had never fired against real bytes:
 * NO_SPENDABLE_INPUT, UNKNOWN_TOKEN and ROOT_UNREADABLE. The plan asked where
 * each is actually rejected, allowing "the ledger's parser structurally
 * precedes our gate" as an answer PROVIDED it is measured.
 *
 * MEASURED (see shapes.test.ts "byte-surgery census"): every single-byte flip
 * across all 15,479 bytes of the real proven fixture yields only
 * BAD_DESERIALIZE (346 positions) or NOT_A_SWAP (2). Never UNKNOWN_TOKEN,
 * never ROOT_UNREADABLE.
 *
 * So the answer is yes, and it changes what those two codes are understood to
 * defend. Any mutation severe enough to make a token tag or a merkle root
 * unparseable also breaks the SCALE stream they are embedded in, and the
 * ledger refuses the whole transaction first. Corrupting a root's VALUE bytes
 * — the one surgery that survives decoding — produces a perfectly parseable
 * root that is simply unknown, which is ROOT_UNKNOWN's business (a liveness
 * check the caller supplies), not ROOT_UNREADABLE's.
 *
 * ROOT_UNREADABLE is therefore a fail-closed guard against a future
 * SERIALIZATION-FORMAT CHANGE — exactly what extract-root.ts's PINNED_INPUT_TAG
 * comment says it is — and not a defence against a hostile publisher. It cannot
 * be driven from the wire. The same argument covers UNKNOWN_TOKEN. Both keep
 * their unit-double coverage (#11's fail-closed floor); neither gets an e2e
 * fixture, because none can exist.
 *
 * RULED 2026-08-12: document and move on. The finding is recorded at both code
 * paths themselves (extract-root.ts and derive.ts) so a future reader meets it
 * where the check lives, not only here. If the SDK ever gains a way to emit
 * offers with arbitrary section/token/encoding configurations, that is the
 * route to driving these paths with real bytes — worth raising upstream then.
 *
 * NO_SPENDABLE_INPUT is different: unreachable by surgery, but trivially
 * CONSTRUCTIBLE, which is why it is the one hostile shape below.
 */
export function hostileShapes(): Shape[] {
  const shapes: Shape[] = [];

  // NO_SPENDABLE_INPUT — declares a payout, spends nothing. Structurally a
  // transaction; semantically not an offer, because there is nothing to swap.
  {
    const intent: any = Intent.new(new Date(Date.now() + TTL_MS));
    intent.guaranteedUnshieldedOffer = UnshieldedOffer.new(
      [],
      [payout(MAKER_KEY, WANT_TOKEN, 125n)],
      [],
    );
    const tx = Transaction.fromParts("undeployed", undefined, undefined, intent);
    shapes.push(shape("no-spendable-input", "outputs but no inputs — NO_SPENDABLE_INPUT, never fired against real bytes", tx));
  }

  return shapes;
}

/** Every shape phase (a) can build, structural and hostile. */
export function allShapes(): Shape[] {
  return [...structuralShapes(), ...hostileShapes()];
}
