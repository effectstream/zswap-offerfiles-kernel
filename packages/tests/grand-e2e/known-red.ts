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

  // RED-8 (PR-G, §2.6) was removed here when the fix landed. Its removal IS the
  // proof, same as the §2.1 block above: the derivation now carries the
  // current-root escape isKnownRootLive already had, and — the half that was
  // missing from the original plan — the SCHEDULED CLEANUP uses that same
  // value. Advertising an expiry and sweeping at a different time is what let
  // an offer sit in the live book long past the deadline the API itself
  // reported. One value now, stored and scheduled.
  //
  // The registry is EMPTY. Keep it that way by deleting entries in the commit
  // that fixes them; the XPASS guard will fail the run if you forget.

  // §2.4 (cross-layer) is FIXED and was never registered — deliberately, and
  // the reasoning is worth keeping because it bounds what this registry is for.
  //
  // An entry means "a check exists, asserts the truth, and the product is
  // currently wrong". For §2.4 no check existed: the fixture had to be BUILT
  // (buildCrossLayerOffer, via Transaction.merge — the route
  // probe-cross-layer.ts proved reachable after the earlier "no wallet can
  // build one" claim turned out to be about wallets, not about the ledger).
  // Registering a check that does not exist yet produces a permanently-stale
  // entry that reads as work in flight, which is the failure mode this file is
  // supposed to prevent. So the fixture and the fix landed together, and the
  // red was demonstrated where it could actually be demonstrated: at unit
  // level, by neutering the predicate and watching cross-layer.test.ts fail on
  // exactly the cross-layer cases while the negative cases stayed green.
  //
  // §2.5 (basket offers) is NOT registered, same rule, still open: confirmed
  // reachable and ruled (ACCEPT but exclude from market data), with its
  // deterministic red at packages/database/multileg-pairs.test.ts and no e2e
  // fixture yet.
};

/** Registered ids that never appeared in a run — a stale registry hides work. */
export function unseenRedIds(seenKeys: Iterable<string>): KnownRed[] {
  const seen = new Set(seenKeys);
  return Object.entries(KNOWN_RED)
    .filter(([key]) => !seen.has(key))
    .map(([, red]) => red);
}
