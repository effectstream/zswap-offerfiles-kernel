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

  // ── PR-E — cross-layer offers unenforced (§2.4) ────────────────────────────
  // Nothing in the ladder requires a give and a want to share a value layer;
  // NOT_A_SWAP fires today only because wallet-sdk-facade silently drops a leg.
  "p4-adversarial ▸ submit rejects a genuine cross-layer offer as CROSS_LAYER": {
    id: "RED-8", pr: "PR-E", why: "no same-layer rule in the ladder (§2.4)",
  },

  // ── PR-F — multi-leg offers mis-priced (§2.5) ──────────────────────────────
  // The market queries join per (offer, color) filtered to (base, quote), so a
  // 3-leg offer becomes two 'trades' at two wrong prices with one leg's volume
  // counted twice.
  "p3-lifecycle ▸ a 3-leg offer is refused as MULTI_LEG_UNSUPPORTED": {
    id: "RED-9", pr: "PR-F", why: "multi-leg offers are indexed and mis-priced (§2.5)",
  },
};

/** Registered ids that never appeared in a run — a stale registry hides work. */
export function unseenRedIds(seenKeys: Iterable<string>): KnownRed[] {
  const seen = new Set(seenKeys);
  return Object.entries(KNOWN_RED)
    .filter(([key]) => !seen.has(key))
    .map(([, red]) => red);
}
