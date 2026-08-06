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
  // §2.1 is FIXED (PR-B, migration 014). Its eight entries were deleted here,
  // which is the mechanism working as designed: the fix made those checks pass,
  // the XPASS guard failed the run until this block was removed, and that
  // removal is the proof in the diff.

  // ── PR-G — expiresAt derived without the MAX(height) escape (§2.6) ─────────
  // The ledger's past_roots re-inserts the CURRENT root every block; our
  // midnight-zswap-root primitive fires only when the root ADVANCES. The
  // ingestion gate compensates (isKnownRootLive's MAX(height) escape); the
  // expiresAt derivation does not — it reads raw last_seen_ms. On a chain with
  // no shielded activity a freshly indexed offer is served an expiry that has
  // ALREADY PASSED. Measured: ingested 18:34:20, expiresAt 18:23:36.
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
