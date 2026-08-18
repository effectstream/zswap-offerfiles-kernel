// Marker dedup — the SECOND dedup rule (ruled 2026-08-18).
//
// Dedup is two rules, not one:
//
//   (i)  BYTE-IDENTICAL, via the `offer_hash` primary key. Free, unchanged,
//        and still FIRST: it costs one indexed probe on a hash we already
//        compute, and a replay is the cheapest attack there is.
//   (ii) MARKER OVERLAP, this file. After crypto verification, an offer whose
//        DECLARED markers overlap those of an ACTIVE offer is rejected.
//
// Why (i) alone is not enough, measured rather than argued: commitments and
// unshielded identities are ROOT-INDEPENDENT (`coin-structure/src/coin.rs:626`
// hashes domain separator + coin info + recipient, with no Merkle root). So
// re-proving one intent against a different root inside the root window yields
// a byte-different blob with a fresh `offer_hash` and IDENTICAL markers. The
// 2026-08-12 "byte-identical only" ruling could not have known that; the
// wrapper pair the phase (c) probe built on a live chain is the same evasion in
// a friendlier form, and it is what produced the measured 7-trades-for-5-
// settlements over-count.
//
// ── Where this runs, and why exactly there ──────────────────────────────────
//
// AFTER crypto verification, at both doors. That is not a preference, it is the
// security property: this check writes a CLAIM on a set of markers, so an
// unverified blob able to register a victim's markers could block the victim's
// real offer. Byte-identical dedup stays first for the opposite reason — it is
// the cheap discriminator and must never be paid for with a `wellFormed`.
//
// ── Why ACTIVE only ─────────────────────────────────────────────────────────
//
// Archival is destructive: the live row is DELETEd and the marker rows cascade
// with it, so presence in the LIVE marker tables IS the live book — no
// predicate of its own, and the probe stays O(live book) rather than
// O(history). Spent originals need no marker check at all: a re-proven
// duplicate of a cancelled or fulfilled offer already dies one rung earlier at
// `NULLIFIER_SPENT` / `UTXO_NOT_LIVE`, because its inputs are spent.
//
// ── Why OVERLAP and not set equality ────────────────────────────────────────
//
// Two wrappers of one intent declare the same outputs, so any overlap already
// implies the same signer — which is what makes the weaker test safe. Equality
// would be evaded by appending a single extra output, and that is precisely the
// manoeuvre the rule exists to stop.
//
// ── Deterministic winner ────────────────────────────────────────────────────
//
// Duplicates landing in one block resolve FIRST-WINS. The rollup's input
// ordering is fixed and the STM's probe runs inside the block transaction, so
// blob 2 sees blob 1's rows on every replica, and every replica processes the
// blobs in the same order. Nothing deployment-local enters the decision: the
// probe orders its candidates by `offer_hash` (content-addressed), never by the
// SERIAL id or an arrival timestamp. That matters HERE and not only in theory —
// the determinism phase (p7a) replays the chain into a second instance and
// compares state, so a winner chosen by a local id would diverge there rather
// than fail here.

import type { UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";
import { collectOutputCommitments, collectUnshieldedOutputs } from "@zswap-da/validator";

/**
 * Reject code for rule (ii). A DEDICATED code, not a reuse of `DUPLICATE_OFFER`.
 *
 * The two rules describe different events — a replay versus an evasion attempt
 * — and `offer_rejections` counts per code, so folding them together would hide
 * the new rejection inside the old counter exactly when its rate is the
 * interesting signal. Door behaviour is identical to `DUPLICATE_OFFER`: 409 at
 * the API, `rejectOffer` at the STM.
 */
export const DUPLICATE_MARKERS = "DUPLICATE_MARKERS";

export type DeclaredMarker =
  | { kind: "commitment"; commitment: string }
  | { kind: "unshielded-output"; owner: string; intentHash: string; outputNo: number };

/**
 * Every marker an offer DECLARES, on whichever layer it uses.
 *
 * Both layers, generally — not commitments alone. The wrapper pairs actually
 * measured on chain were unshielded and carry no commitments at all, so a
 * commitment-only rule would miss the case that motivated the ruling.
 *
 * Order is the derivation order of the transaction's own outputs, which is a
 * pure function of the bytes: two replicas probing the same blob probe the same
 * markers in the same sequence and therefore report the same first conflict.
 */
export function declaredMarkers(tx: UnprovenTransaction): DeclaredMarker[] {
  const markers: DeclaredMarker[] = [];
  for (const commitment of collectOutputCommitments(tx)) {
    markers.push({ kind: "commitment", commitment });
  }
  for (const out of collectUnshieldedOutputs(tx)) {
    markers.push({
      kind: "unshielded-output",
      owner: out.owner,
      intentHash: out.intentHash,
      outputNo: out.outputNo,
    });
  }
  return markers;
}

/** Human-readable identity of a marker, for the reject reason and the logs. */
export function markerLabel(m: DeclaredMarker): string {
  return m.kind === "commitment"
    ? `commitment ${m.commitment}`
    : `unshielded output ${m.owner}/${m.intentHash}/${m.outputNo}`;
}

/**
 * The reject reason, shared by both doors so a client cannot tell them apart.
 *
 * Names the incumbent's `offer_hash` — the content address, identical on every
 * replica — so the maker can look up the offer that already owns the marker
 * instead of guessing.
 */
export function duplicateMarkerReason(m: DeclaredMarker, incumbentHash: string | null): string {
  return (
    `declared ${markerLabel(m)} is already claimed by the active offer ` +
    `${incumbentHash ?? "(hash unavailable)"}; re-wrapping or re-proving one intent ` +
    `does not create a second offer`
  );
}
