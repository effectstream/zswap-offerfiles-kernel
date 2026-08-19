# Grand E2E — current operations handoff

State as of 2026-08-15. The production-readiness closeout is complete; this is
the standing run playbook and scope boundary.

## Current gate

- Closeout branch: `fix/production-readiness-closeout`, PR #46.
- Static gate: 274 pass, 0 fail, 707 assertions across 39 files; the pgtyped
  regeneration guard and grand-runner bundle also pass.
- Final fresh-chain run (source `63c9fc5`): **238 checks, 0 failures, 87.9
  minutes, `maxLagBlocks 101`, `lastLagBlocks 2`**.
- Both p7a determinism claims passed: replayed state identical (excluding only
  documented volatiles) and offer-hash sets identical. State A and B share
  SHA-256 `24ef7cc7...d0477b0`.
- No loud fixture skip, foreign heavy process or indexer pool error occurred.
- Hash-pinned evidence is at
  `/tmp/zswap-closeout-evidence/run6-final-green/`.
- Unshielded unusual-shape execution/read phases (c)/(d) remain a separate
  workstream; this closeout does not claim their deferred read predicate fixed.

## System orientation

ZSwap-DA indexes proven Midnight swap transactions published as raw bytes in
the Celestia `mn-swap-v1` namespace. `offerId` is lowercase SHA-256 of those
raw bytes. The node consumes Midnight nullifiers, commitments, unshielded
creates/spends and Merkle roots, then serves the live/archive API.

Offer status is `live | consumed | cancelled | expired | not_found`:

- A fill consumes all inputs atomically in one Midnight transaction and creates
  the offer's output markers.
- Shielded markers are exact commitments.
- PR #45 persists unshielded markers by exact ledger identity
  `(owner, intent_hash, output_no)`; token type and value are audit fields.
- The Phase-(d)-deferred SQL classifier still groups its final payout lookup by
  `(owner, token_type, value)`. Replacing that read predicate and executing
  unusual fallible/multi-intent shapes is separate work.
- Partial/split spends or missing markers classify `cancelled`; TTL archives
  classify `expired`.

## Canonical fresh run

Use the wrapper so the stack and runner receive the same expiry environment,
the database/chain are fresh, and the 60-offer default is explicit:

```sh
GRAND_OFFERS=60 GRAND_STORM_API=200 GRAND_STORM_CELESTIA=30 \
ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 \
bash ./packages/tests/grand-e2e/fresh-run.sh
```

The dev batcher must prove these two startup lines before the suite begins:

```text
NIGHT bootstrap: 5 registered UTXOs, 5 spendable dust streams
worker slots: 5 (5 UTXOs, cost=1/tx, cap=5)
```

If genesis supplies fewer coins, bootstrap self-splits. NIGHT balance alone is
not concurrency: each in-flight transaction needs a distinct spendable UTXO.
Do not run `run.ts` bare; its historical default is a 500-offer, multi-hour
storm.

## Verdict rules

1. Read the lag numbers first — since 2026-08-18 there are **two**, and they
   answer different questions. Confusing them is the trap this rule exists to
   prevent.

   - **`maxLagBlocksIncludingChaos`** is the old number, unchanged in meaning.
     The historical clean band 53–96 and the "above roughly 150 makes a run
     VOID, not failed" rule both belong to THIS one. Read it for run validity /
     box contention.
   - **`maxLagBlocks`** is now STM throughput: the max over samples OUTSIDE the
     suite's own chaos windows (p6 marks them). It is what `maxStmLagBlocks`
     (95 × 1.2 = 114) gates. Do not compare it against the 53–96 band — that
     band was measured on the chaos-inclusive number. Calibration on the first
     run under the new semantics (2026-08-18, `9f1f479`): **`maxLagBlocks` 4**
     against `maxLagBlocksIncludingChaos` 84, median 1, p95 2, 8 of 146 samples
     excluded.

   Why they were split: a killed process makes lag climb at the chain's own
   1 block/s, so the peak inside a deliberate window measures restart duration,
   not throughput — measured twice at exactly 120 blocks, t+54.5 min, inside
   `chaosSync`. The restart is gated instead by `recoveryLagBlocks` (10 × 1.2):
   one sample interval after each chaos window the STM must be back at the chain
   edge. Run 7 observed 1, 1 and 2 blocks after the indexer, batcher and sync
   windows. `metrics.json` carries the windows and the full series, so an
   excluded peak is auditable rather than merely absent.
2. Grep the log for `not built (`. Cross-layer and basket fixtures skip
   loudly if construction fails; a green score alone is insufficient.
3. Never reuse a chain. Specialists and expected fates rely on exact coin
   counts.
4. A closeout-quality run records scorecard totals, metrics, both determinism
   checks and the five-slot startup proof.
5. Tear down only this stack's processes and verify ports 9999, 4747, 3334 and
   5432 are clear.

## What the suite proves

- Both API and permissionless Celestia ingestion doors reject by code.
- Stored bytes, content hashes, legs, spend references and marker counts agree
  with independent derivation; the final deep audit revalidated 66/66 blobs.
- Served rows re-validate, remain settleable/live and respect expiry.
- Fill/cancel accounting, chart volume, price orientation, chain-time windows,
  basket exclusion and `/v1/pairs` ordering agree.
- N-way, cross-door, late-loser and same-block competition works.
- T-E2 proves exact `{A,B}` / `{B,C}` partial overlap archives and
  classifies the loser without adding a trade.
- T-E5 proves two settlement requests overlap in flight, exactly one lands,
  the loser is a transaction-specific batcher/chain double spend, competitors
  archive once, and exactly one trade prints.
- Every fate is exercised on shielded and unshielded layers.
- A second node replay produces identical state and offer-hash sets.
- The committed performance gate passes the final run, while unit fixtures
  prove a 2× slowed submit median and a 151-block lag path still fail.

## Operational traps

- The checkout path contains a space. Keep
  `grand-b-config-drift.test.ts` on `fileURLToPath(new URL(...))`; passing a
  URL pathname directly reintroduces the `%20` loader failure.
- `pkill -f` matches its own command; bracket process-name patterns.
- A batcher connection error is not a settlement verdict. Re-read chain state.
- Ordinary `submitToBalancer` intentionally uses the suite-wide
  `balancerChain` for deterministic ordering. T-E5 prepares both taker
  transactions first, bypasses that queue through the raw concurrent helper,
  releases both from one barrier, and requires both in flight before receipt 1.
- p5 bypasses only the suite-wide HTTP queue across independent takers; it
  retains each wallet's own serialization lock.
- Top-level `--` comments in pgtyped SQL can log `Skipped` and exit 0. Use
  `/* */` and keep `bun run check:pgtypes` green.
- `bun:test` treats a throw inside `test.failing` as the expected failure.
  Use explicit before/after evidence.
- There is no root TypeScript project. Bundle the runner with:

  ```sh
  bun build packages/tests/grand-e2e/run.ts --target=bun
  ```

## Closeout result

The required 60-offer/five-slot run is fully green, its performance gate is
non-decorative, its fixture-skip grep is empty, and both determinism checks
pass. PR #46 may be reviewed and merged by the maintainer; agents must not
merge it.
