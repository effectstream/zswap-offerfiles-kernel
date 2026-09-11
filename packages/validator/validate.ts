import { Transaction } from "@midnightntwrk/ledger-v9";
import type { UnprovenTransaction } from "@midnightntwrk/ledger-v9";
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
import {
  offerLivenessFailure,
  orderedOfferLivenessDescriptors,
} from "./liveness.ts";
import type {
  OfferLeg,
  OfferRejectCode,
  OfferValidation,
  ValidateOpts,
} from "./types.ts";

/**
 * Do these legs span BOTH value layers? (§2.4 — ruled REJECT.)
 *
 * Typed on `OfferLeg`, which is what `deriveLegs` returns and what the ladder
 * actually holds. That matters: MIP-0006's own leg calls the layer `type`,
 * `deriveLegs` renames it to `kind`, and a predicate written against the wrong
 * one reads `undefined` for every leg, collapses to a one-element set, and
 * silently never fires. The type is the guard — these must not be `string`.
 *
 * Exported so the rule can be tested as what it is — a pure predicate over
 * derived legs — without constructing a cross-layer transaction. Building one
 * needs two real offers and `Transaction.merge` (probe-cross-layer.ts), which
 * is an integration concern; the RULE deserves cheap, exhaustive coverage.
 *
 * Empty input is NOT cross-layer: an empty or one-layer shape is the two-sided
 * rule's business, and the two-sided rule runs first (see the ordering note at
 * the call site). Reporting CROSS_LAYER there would be a misleading code on a
 * different defect.
 */
export function isCrossLayer(gives: OfferLeg[], wants: OfferLeg[]): boolean {
  const layers = new Set<OfferLeg["kind"]>();
  for (const l of [...gives, ...wants]) layers.add(l.kind);
  return layers.size > 1;
}

/** Which layer each side sits on — for the reject reason a caller reads. */
export function layerSummary(gives: OfferLeg[], wants: OfferLeg[]): string {
  const side = (ls: OfferLeg[]) =>
    ls.length === 0 ? "none" : [...new Set(ls.map((l) => l.kind))].sort().join("+");
  return `gives ${side(gives)}, wants ${side(wants)}`;
}

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
  opts: Pick<ValidateOpts, "refState" | "tblock" | "contractMakerRetry">,
): { ok: true; contractMaker?: boolean } | { ok: false; code: OfferRejectCode; reason: string } {
  try {
    tx.wellFormed(opts.refState, buildStrictness(), opts.tblock);
    return { ok: true };
  } catch (e) {
    const m = errMsg(e);
    // Contract-maker lane (see ValidateOpts.contractMakerRetry): strict ran
    // first, and ONLY the exact missing-contract failure class widens — a
    // blank reference state cannot hold the maker contract's verifier keys.
    // Native proofs and signatures are still verified on the retry; the
    // contract-call proof is verified by the node at settlement.
    if (opts.contractMakerRetry && /non-existant contract|non-existent contract/i.test(m)) {
      try {
        tx.wellFormed(opts.refState, buildStrictness({ verifyContractProofs: false }), opts.tblock);
        return { ok: true, contractMaker: true };
      } catch (e2) {
        const m2 = errMsg(e2);
        return {
          ok: false,
          code: /signature/i.test(m2) ? "SIGNATURE_INVALID" : "PROOF_INVALID",
          reason: `wellFormed failed (contract-maker retry): ${m2}`,
        };
      }
    }
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
    // `as unknown as`, matching `reconstructOffer` in solver-core/api-client.ts:
    // the markers deserialize the PROVEN shape (ledger `Transaction<SignatureEnabled,
    // Proof, Binding>`), while `UnprovenTransaction` is this repo's alias for the
    // offer shape it then inspects. Without the `unknown` hop the assignment's
    // contextual type infers the pre-proof markers and rejects "proof" — the
    // types disagree, the bytes do not.
    tx = Transaction.deserialize(
      "signature" as const,
      "proof" as const,
      "binding" as const,
      rawTx,
    ) as unknown as UnprovenTransaction;
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

  // §2.4 — CROSS-LAYER OFFERS ARE REJECTED.
  //
  // An offer whose legs span BOTH value layers has no settlement path: nothing
  // in this system moves value between shielded and unshielded, so a taker
  // could never fill it. Before this check the ladder ACCEPTED such offers —
  // probe-cross-layer.ts merges a real shielded offer with a real unshielded
  // one via `Transaction.merge` and the result passed everything, `wellFormed`
  // included. That is reachable by anyone holding both halves, and the DA
  // namespace is permissionless, so "no wallet builds one" is not a defence.
  //
  // Placed with the other leg-shape checks and BEFORE the proof work: the
  // verdict is a pure function of the offer bytes, so both doors and every
  // replay agree, and a rejected offer costs no proof verification.
  //
  // AFTER the two-sided rule, not before. For the dangerous shape — a genuine
  // two-sided cross-layer offer — the order is immaterial, since it passes
  // isTwoSided either way. It only matters for a degenerate give-only tx that
  // happens to carry both layers, and there "this is not a swap at all" is the
  // more basic complaint; CROSS_LAYER implies there are two sides to be
  // cross-layer about. p4 asserts the two-sided case is NOT answered
  // NOT_A_SWAP, which is what pins this ordering against a silent reshuffle.
  //
  // `deriveTokenLegs` nets per (colour, LAYER), so the same colour on two
  // layers is two legs — MIP-0006's own framing, and exactly what makes this
  // check a simple set-size test rather than a colour comparison.
  if (isCrossLayer(gives, wants)) {
    return {
      ok: false,
      code: "CROSS_LAYER",
      reason:
        `offer legs span both value layers (${layerSummary(gives, wants)}); ` +
        `no settlement path exists between shielded and unshielded`,
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
  const livenessDescriptors = orderedOfferLivenessDescriptors({
    nullifiers,
    unshieldedSpends,
    inputRoots,
  });
  if (opts.isNullifierSpent) {
    for (const descriptor of livenessDescriptors) {
      if (descriptor.kind !== "nullifier") continue;
      if (opts.isNullifierSpent(descriptor.nullifier)) {
        const failure = offerLivenessFailure(descriptor);
        return {
          ok: false,
          code: failure.code,
          reason: failure.reason,
          ...derived,
        };
      }
    }
  }
  if (opts.isUnshieldedSpent) {
    for (const descriptor of livenessDescriptors) {
      if (descriptor.kind !== "unshielded") continue;
      if (opts.isUnshieldedSpent(descriptor.ref)) {
        const failure = offerLivenessFailure(descriptor, "spent");
        return {
          ok: false,
          code: failure.code,
          reason: failure.reason,
          ...derived,
        };
      }
    }
  }
  if (opts.isUnshieldedCreated) {
    for (const descriptor of livenessDescriptors) {
      if (descriptor.kind !== "unshielded") continue;
      if (!opts.isUnshieldedCreated(descriptor.ref)) {
        const failure = offerLivenessFailure(descriptor, "unknown");
        return {
          ok: false,
          code: failure.code,
          reason: failure.reason,
          ...derived,
        };
      }
    }
  }
  if (opts.isKnownRoot) {
    for (const descriptor of livenessDescriptors) {
      if (descriptor.kind !== "root") continue;
      if (!opts.isKnownRoot(descriptor.root)) {
        const failure = offerLivenessFailure(descriptor);
        return {
          ok: false,
          code: failure.code,
          reason: failure.reason,
          ...derived,
        };
      }
    }
  }

  // ── 7. Dedup (optional) ──
  // Caller-supplied and identity-based (nullifiers / tx identifiers).
  //
  // This is rule (i) territory only — the cheap, pre-crypto discriminator. The
  // production doors implement it as a byte-identical `offer_hash` probe (see
  // packages/node/api.ts) and it stays exactly where it is.
  //
  // Rule (ii), MARKER dedup, is deliberately NOT here. Ruled 2026-08-18: two
  // wrappers of one intent are byte-different and declare identical markers, so
  // they must be related — but the check has to run AFTER crypto, because it
  // registers a claim on markers and an unverified blob must never be able to
  // block a victim's real offer with them. A ladder step that runs before
  // `wellFormed` cannot express that, so it lives at the doors instead:
  // packages/node/marker-dedup.ts, one predicate, both call sites.
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
