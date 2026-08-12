import { Transaction } from "@midnight-ntwrk/ledger-v8";
import type { UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles, OFFER_HRP } from "@effectstream/mip-zswap-offer/mip5";
import { P2pAtomicSwaps } from "@effectstream/mip-zswap-offer/mip6";

import {
  collectNullifiers,
  collectUnshieldedSpends,
  collectOutputCommitments,
  deriveLegs,
  UnknownTokenTagError,
} from "./derive.ts";
import { buildStrictness } from "./refstate.ts";
import { extractOfferInputRoots, RootExtractError } from "./extract-root.ts";
import type {
  OfferRejectCode,
  OfferValidation,
  ValidateOpts,
} from "./types.ts";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// `identifiers()` is only needed for dedup; never let it sink a validation.
function safeIdentifiers(tx: UnprovenTransaction): string[] {
  try {
    return tx.identifiers();
  } catch {
    return [];
  }
}

/**
 * `bech32m` packs 8 bits into every 5-bit character, so the encoded string is
 * always ~1.6× the payload, plus the `swapoffer1` HRP and the 6-char checksum.
 * Anything longer than this bound cannot decode to <= maxBytes, so it can be
 * rejected on the raw string — before spending the O(n) decode on a blob whose
 * only purpose may be to make us do that work.
 */
function maxEncodedChars(maxBytes: number): number {
  return Math.ceil((maxBytes * 8) / 5) + OFFER_HRP.length + 7;
}

/**
 * Verify the offer's zero-knowledge proofs and signatures (`wellFormed`).
 *
 * This is the single most expensive operation in the pipeline — orders of
 * magnitude above every other step — which is why `crypto: "defer"` exists:
 * callers holding indexed rejection criteria (dedup, liveness) run those
 * first and call this last, so replayed and stale blobs never reach it.
 *
 * It is also the step that makes everything else trustworthy: the legs,
 * nullifiers, and roots read out of a transaction are merely *claimed* until
 * this passes. Never index an offer without it.
 */
export function verifyOfferCrypto(
  tx: UnprovenTransaction,
  opts: Pick<ValidateOpts, "refState" | "tblock">,
): { ok: true } | { ok: false; code: OfferRejectCode; reason: string } {
  try {
    tx.wellFormed(opts.refState, buildStrictness(), opts.tblock);
    return { ok: true };
  } catch (e) {
    const m = errMsg(e);
    return {
      ok: false,
      code: /signature/i.test(m) ? "SIGNATURE_INVALID" : "PROOF_INVALID",
      reason: `wellFormed failed: ${m}`,
    };
  }
}

/**
 * Validate a ZSwap offer blob. Deterministic given (blob, refState, tblock) —
 * safe to call inside the state machine. Steps run cheap → expensive and stop
 * at the first failure:
 *
 *   1 encoding (HRP → length bound → bech32m) · 2 size · 3 deserialize ·
 *   4 structural/semantic · 5 root extraction · 6 liveness (optional sync) ·
 *   7 dedup (optional) · 8 crypto (wellFormed)
 *
 * Crypto runs LAST so that every cheaper discriminator gets to reject first.
 * With `crypto: "defer"` it is skipped entirely here and the caller runs
 * `verifyOfferCrypto` after its own async dedup/liveness — see ValidateOpts.
 *
 * On success — and whenever deserialization succeeds — the derived
 * `tx/nullifiers/unshieldedSpends/gives/wants/identifiers` are returned so a
 * caller can run its own async liveness without reparsing.
 */
export function validateZswapOffer(
  blob: string,
  opts: ValidateOpts,
): OfferValidation {
  // ── 1. Encoding ──
  if (typeof blob !== "string" || !blob.startsWith(`${OFFER_HRP}1`)) {
    return {
      ok: false,
      code: "BAD_ENCODING",
      reason: "not a swapoffer bech32m string",
    };
  }
  // Length bound on the RAW STRING, before decoding: an oversized blob is
  // rejected without doing the work it was trying to make us do.
  const maxChars = maxEncodedChars(opts.maxBytes);
  if (blob.length > maxChars) {
    return {
      ok: false,
      code: "TOO_LARGE",
      reason:
        `encoded offer is ${blob.length} chars > max ${maxChars} ` +
        `(cannot decode to <= ${opts.maxBytes} bytes)`,
    };
  }
  let rawTx: Uint8Array;
  try {
    rawTx = OfferFiles.decode(blob);
  } catch (e) {
    return {
      ok: false,
      code: "BAD_ENCODING",
      reason: `bech32m decode failed: ${errMsg(e)}`,
    };
  }

  // Everything from here — size, deserialize, structure, crypto — is a pure
  // function of the RAW BYTES. The DA layer publishes those bytes directly
  // (MIP-0006), so the STM ingests via validateZswapOfferBytes; only the
  // string-carrying callers (submit route, batcher pre-fee gate) come through
  // the bech32m entry above.
  return validateZswapOfferBytes(rawTx, opts);
}

/**
 * Validate an offer from its RAW canonical `Transaction` bytes — the on-chain
 * MIP-0006 form. Identical ladder to `validateZswapOffer` minus the bech32m
 * encoding step (there is no string to decode). Steps: size · deserialize ·
 * structural · root extraction · liveness · dedup · crypto (last).
 */
export function validateZswapOfferBytes(
  rawTx: Uint8Array,
  opts: ValidateOpts,
): OfferValidation {
  // ── 2. Size ──
  if (rawTx.length > opts.maxBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      reason: `offer is ${rawTx.length} bytes > max ${opts.maxBytes}`,
    };
  }

  // ── 3. Deserialize (Lace-shaped <signature, proof, binding>) ──
  let tx: UnprovenTransaction;
  try {
    tx = Transaction.deserialize(
      "signature" as const,
      "proof" as const,
      "binding" as const,
      rawTx,
    ) as UnprovenTransaction;
  } catch (e) {
    return {
      ok: false,
      code: "BAD_DESERIALIZE",
      reason: `deserialize failed: ${errMsg(e)}`,
    };
  }

  // ── 4. Structural / semantic ──
  const nullifiers = collectNullifiers(tx);
  const unshieldedSpends = collectUnshieldedSpends(tx);
  if (nullifiers.length === 0 && unshieldedSpends.length === 0) {
    return {
      ok: false,
      code: "NO_SPENDABLE_INPUT",
      reason: "no shielded input/transient or unshielded spend",
      tx,
    };
  }

  let gives, wants;
  try {
    ({ gives, wants } = deriveLegs(tx));
  } catch (e) {
    if (e instanceof UnknownTokenTagError) {
      return {
        ok: false,
        code: "UNKNOWN_TOKEN",
        reason: e.message,
        tx,
        nullifiers,
        unshieldedSpends,
      };
    }
    // Segment ids came from the tx itself; a throw here means a malformed tx.
    return {
      ok: false,
      code: "BAD_DESERIALIZE",
      reason: `imbalance derivation failed: ${errMsg(e)}`,
      tx,
      nullifiers,
      unshieldedSpends,
    };
  }
  // MIP-0006 two-sided rule (give-only / want-only offers are not swaps).
  if (!P2pAtomicSwaps.isTwoSided(gives, wants)) {
    return {
      ok: false,
      code: "NOT_A_SWAP",
      reason:
        `expected ≥1 give and ≥1 want; got ${gives.length} give(s), ${wants.length} want(s)`,
      tx,
      nullifiers,
      unshieldedSpends,
      gives,
      wants,
    };
  }

  const identifiers = safeIdentifiers(tx);
  let derived: Partial<OfferValidation> = {
    tx,
    nullifiers,
    unshieldedSpends,
    gives,
    wants,
    identifiers,
  };

  // ── 5. Extract each shielded input's merkle root (fail-closed) ──
  // The binding has no root getter, so we read it from the serialized input
  // (pinned zswap-input[v2] layout). A parse anomaly is rejected, not ignored:
  // a wrong root would otherwise match no known root anyway.
  //
  // This is a pure byte-parse of the already-deserialized tx — independent of
  // proof verification — so it runs BEFORE crypto, letting the root-known
  // liveness check (an indexed probe) reject aged-out offers for free.
  let inputRoots: string[];
  try {
    inputRoots = extractOfferInputRoots(tx);
  } catch (e) {
    return {
      ok: false,
      code: e instanceof RootExtractError ? "ROOT_UNREADABLE" : "ROOT_UNREADABLE",
      reason: `root extraction failed: ${errMsg(e)}`,
      ...derived,
    };
  }
  derived = { ...derived, inputRoots };

  // ── 6. Liveness (optional synchronous checks) ──
  if (opts.isNullifierSpent) {
    for (const n of nullifiers) {
      if (opts.isNullifierSpent(n)) {
        return {
          ok: false,
          code: "NULLIFIER_SPENT",
          reason: `nullifier already spent: ${n}`,
          ...derived,
        };
      }
    }
  }
  if (opts.isUnshieldedSpent) {
    for (const ref of unshieldedSpends) {
      if (opts.isUnshieldedSpent(ref)) {
        return {
          ok: false,
          code: "UTXO_SPENT",
          reason:
            `unshielded UTXO already spent: ${ref.owner}/${ref.intentHash}/${ref.outputNo}`,
          ...derived,
        };
      }
    }
  }
  if (opts.isUnshieldedCreated) {
    for (const ref of unshieldedSpends) {
      if (!opts.isUnshieldedCreated(ref)) {
        return {
          ok: false,
          code: "UTXO_UNKNOWN",
          reason:
            `unshielded UTXO never created on chain: ${ref.owner}/${ref.intentHash}/${ref.outputNo}`,
          ...derived,
        };
      }
    }
  }
  if (opts.isKnownRoot) {
    for (const root of inputRoots) {
      if (!opts.isKnownRoot(root)) {
        return {
          ok: false,
          code: "ROOT_UNKNOWN",
          reason: `input merkle root not a known recent chain root: ${root}`,
          ...derived,
        };
      }
    }
  }

  // ── 7. Dedup (optional) ──
  // Caller-supplied and identity-based (nullifiers / tx identifiers). Note the
  // ruling recorded at the submit gate in packages/node/api.ts: dedup is
  // byte-identical by design. Two wrappers around the LITERAL same intent hash
  // differently and are treated as two offers, because publication costs a
  // Celestia fee per blob — re-wrapping is an attack the attacker pays for, and
  // duplicates compete for the same inputs so only one can ever settle.
  if (opts.seen && opts.seen(nullifiers, identifiers)) {
    return { ok: false, code: "DUPLICATE", reason: "offer already seen", ...derived };
  }

  // ── 8. Cryptographic — LAST, and only if the caller wants it inline ──
  // Rejects forged proofs / made-up coins. Every cheaper check above has
  // already had its chance, so a blob that was going to be discarded anyway
  // never reaches this. `crypto: "defer"` hands the step to the caller, which
  // MUST run verifyOfferCrypto() before acting on the offer.
  if (opts.crypto !== "defer") {
    const verdict = verifyOfferCrypto(tx, opts);
    if (!verdict.ok) {
      return { ok: false, code: verdict.code, reason: verdict.reason, ...derived };
    }
  }

  return { ok: true, ...derived };
}
