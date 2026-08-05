// Expected-failure registry — the red half of red/green.
//
// A test that fails on merge is worthless if it just turns the suite red and
// gets ignored. So every check that asserts the TRUTH about a known product
// defect is registered here, keyed on the exact `phase ▸ name` string that
// check() builds. The effect:
//
//   • a registered check that FAILS  → recorded as a non-gating red, so the
//     base-test PR merges clean and the suite stays a usable gate for
//     everything else while the fixes are in flight;
//   • a registered check that PASSES → an XPASS, which FAILS the run. That is
//     the only mechanism forcing a fix PR to close its own entry, and the
//     deletion of the entry is the proof — in the diff — that the fix earned
//     its green.
//
// The workflow each fix PR follows:
//   1. run the suite, capture the `[RED ]` line for its id;
//   2. fix the product code;
//   3. re-run — expect `[XPASS]`;
//   4. delete the entry here; re-run — expect `[PASS]`.
//
// Steps 1 and 3 are what "see it fail first" means. Step 3 is what proves the
// TEST, not just the fix: a check that goes green the moment the defect is
// removed, and was red before, has demonstrated it measures the defect.
//
// Masking risk is real and bounded: keys are exact full names, so a DIFFERENT
// failure in the same phase still fails the run normally. Nothing here may be
// added for a flake — an entry means "this asserts the truth and the product
// is currently wrong", never "this is unreliable".
//
// Rationale for each defect lives in PRODUCTION-READINESS.md §2.

export interface KnownRed {
  /** Stable id, quoted in the scorecard and in the fix PR's description. */
  id: string;
  /** The PR that must delete this entry. */
  pr: string;
  /** Why it currently fails — the defect, not the symptom. */
  why: string;
}

export const KNOWN_RED: Record<string, KnownRed> = {
  // ── PR-B — unshielded fill-vs-cancel (§2.1) ────────────────────────────────
  // midnight-unshielded-spend discards the txHash the primitive already
  // supplies, so unshielded spends cannot be tx-grouped and EVERY consumption
  // of an unshielded-only offer classifies `consumed`. A maker who walks away
  // is recorded as a completed sale, inflating volume, last_price and
  // trade_count for the price of one self-transfer.
  //
  // NOTE these six move together. Flipping the two status assertions also
  // flips expectedStatus() in p7b and the fill ledger, which changes what the
  // chart checks expect — register them as one set or p7b fails for an
  // unrelated-looking reason.
  // Three shapes, because branches 1 and 2 of cancelledPredicate do not merely
  // misclassify on the unshielded layer — they cannot fire at all, since
  // nothing records which transaction spent an unshielded UTXO. A fix that
  // only handled the single-coin walk-away would leave both branches dead.
  "p3-lifecycle ▸ unshielded cancel single-one-tx: archived + status cancelled": {
    id: "RED-1a", pr: "PR-B", why: "no unshielded fill markers (§2.1)",
  },
  "p3-lifecycle ▸ unshielded cancel split-two-tx: archived + status cancelled": {
    id: "RED-1b", pr: "PR-B", why: "unshielded spends are not tx-grouped — branch 2 dead (§2.1)",
  },
  "p3-lifecycle ▸ unshielded cancel partial: archived + status cancelled": {
    id: "RED-1c", pr: "PR-B", why: "unshielded spends are not recorded — branch 1 dead (§2.1)",
  },
  "p3b-competing ▸ unshielded: loser reads cancelled (fill markers separate them)": {
    id: "RED-2", pr: "PR-B", why: "unshielded spends are not tx-grouped (§2.1)",
  },
  "p3b-competing ▸ unshielded: trade history counts 1 (cancel adds no volume)": {
    id: "RED-3", pr: "PR-B", why: "cancelled unshielded loser counted as a fill (§2.1)",
  },
  "p7b-audit ▸ classification: API status agrees with the ledger's fates (100%)": {
    id: "RED-4", pr: "PR-B", why: "unshielded cancels report consumed (§2.1)",
  },
  "p7b-audit ▸ Σ chart volume == Σ settled offers": {
    id: "RED-5", pr: "PR-B", why: "unshielded cancels contribute phantom volume (§2.1)",
  },
  "p7b-audit ▸ pair_stats.trade_count == genuine fills per pair": {
    id: "RED-6", pr: "PR-B", why: "unshielded cancels increment trade_count (§2.1)",
  },

  // NOTE — §2.2 (pair_stats.last_price inversion) is NOT registered here.
  // The defect only manifests when the pair's most recent fill gave the
  // lexically-greater color, and which direction a run's last fill went is
  // data-dependent, so an e2e entry would be a coin-flip: a KNOWN_RED that
  // sometimes passes is an XPASS that fails the build for no reason. Its red
  // lives where the condition IS controllable —
  // packages/database/fill-vs-cancel.test.ts, `test.failing(...)`, which seeds
  // one fill in each direction on a pair whose color ordering it chose. The
  // e2e cross-route check in p7b stays unregistered and asserts the weaker,
  // deterministic property: the two routes must not disagree in any way OTHER
  // than that known inversion.

  // ── PR-G — expiresAt derived without the MAX(height) escape (§2.6) ─────────
  // The ledger's past_roots re-inserts the CURRENT root every block; our
  // midnight-zswap-root primitive fires only when the root ADVANCES. The
  // ingestion gate compensates for that asymmetry (isKnownRootLive's MAX(height)
  // escape); the expiresAt derivation does not — it reads raw last_seen_ms.
  //
  // On a chain with no shielded activity the newest root's last_seen goes stale,
  // so a freshly indexed offer is served an expiry that has ALREADY PASSED.
  // Measured: ingested 18:34:20, expiresAt 18:23:36 — eleven minutes before it
  // existed — while the same offer passed the settleability check.
  "p8-served ▸ served expiresAt is in the future for offers reported live": {
    id: "RED-8", pr: "PR-G", why: "expiresAt uses raw last_seen_ms, no MAX(height) escape (§2.6)",
  },

  // NOT REGISTERED YET, and both for the same reason — the FIXTURE does not
  // exist, so registering the check would produce a permanently-stale entry
  // that reads as work-in-flight when nothing is in flight:
  //
  // §2.4 cross-layer (PR-E). Needs a GENUINE cross-layer transaction, which
  //   wallet-sdk-facade cannot build — it silently drops the mismatched leg
  //   (ISSUES.md §3), which is what p4's one-sided NOT_A_SWAP fixture exploits.
  //   Constructing one means merging a shielded give-only tx with an unshielded
  //   want-only tx via the ledger's Transaction.merge, and whether the ledger
  //   permits that combination is itself unknown. Until then the rule is
  //   unenforced AND untested — recorded in PRODUCTION-READINESS.md §2.4.
  //
  // §2.5 multi-leg (PR-F). A same-layer 3-leg offer needs THREE colors on one
  //   layer; the suite mints two per layer (TA/TB, UA/UB), and a cross-layer
  //   third leg is unbuildable for the reason above. Adding a third shielded
  //   color to setupActors is the prerequisite, and the ruling on what the
  //   behaviour should even be is still open.
};

/** Registered ids that never appeared in a run — a stale registry hides work. */
export function unseenRedIds(seenKeys: Iterable<string>): KnownRed[] {
  const seen = new Set(seenKeys);
  return Object.entries(KNOWN_RED)
    .filter(([key]) => !seen.has(key))
    .map(([, red]) => red);
}
