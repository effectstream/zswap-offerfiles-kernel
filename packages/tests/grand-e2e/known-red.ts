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
// Masking risk, stated honestly. Keys are exact full names, so a different
// CHECK in the same phase still fails normally — but that was never the real
// exposure. The real one is a different CAUSE inside the SAME check, which the
// key cannot distinguish. Two bounds on it:
//
//   • a THROWN exception is never demoted (see check() in lib/util.ts). The
//     product being wrong is signalled by the assertion returning false, so a
//     crash inside a registered check is unrelated breakage and fails the run.
//   • an entry must name the defect in `why`, so a reviewer can tell whether a
//     red's observed detail — which the scorecard prints — matches it.
//
// A residual gap remains: a check that returns false for a NEW reason, while
// its registered defect also still exists, reads as the expected red. Nothing
// here may be added for a flake — an entry means "this asserts the truth and
// the product is currently wrong", never "this is unreliable".
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

  // §2.4 (cross-layer) and §2.5 (basket offers) are NOT registered — but no
  // longer for the reason this block used to give.
  //
  // It said the fixtures could not be built because wallet-sdk-facade drops the
  // mismatched leg. probe-cross-layer.ts refuted that: a wallet is not the only
  // way to make a transaction — balancing IS a merge, and the ledger exposes
  // Transaction.merge() directly. Both gaps are now CONFIRMED REACHABLE and
  // both have rulings (§2.4 REJECT, §2.5 ACCEPT-but-exclude-from-market-data).
  //
  // What is still missing is the e2e FIXTURE, not the knowledge. Registering a
  // check that does not exist yet would produce a permanently-stale entry that
  // reads as work in flight. Their deterministic reds already live at unit
  // level: packages/database/multileg-pairs.test.ts for §2.5, and
  // probe-cross-layer.ts reproduces §2.4 in seconds with no stack.
};

/** Registered ids that never appeared in a run — a stale registry hides work. */
export function unseenRedIds(seenKeys: Iterable<string>): KnownRed[] {
  const seen = new Set(seenKeys);
  return Object.entries(KNOWN_RED)
    .filter(([key]) => !seen.has(key))
    .map(([, red]) => red);
}
