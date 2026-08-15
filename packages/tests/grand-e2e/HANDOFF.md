# Grand E2E — current operations handoff

State as of 2026-08-14. The suite is implemented; this is the run handoff, not
the old implementation brief.

## Current gate

- `main` is `5aec4d7` (PR #45 merged).
- Unit baseline: 262 pass, 0 fail. A smaller count means a test did not load.
- Last valid full run: 223 checks, 1 failure, `maxLagBlocks 80`; both p7a
  determinism checks passed. The only failure was a performance baseline
  calibrated at a different offer/slot scale.
- Remaining closeout work: five-slot bootstrap and performance recalibration,
  one clean SSE sample and baseline keys, T-E2/T-E5, then a fully-green run.
- Unshielded unusual-shape execution/read phases (c)/(d) are a separate
  workstream and are not part of this closeout.

## System orientation

ZSwap-DA indexes proven Midnight swap transactions published as raw bytes in
the Celestia `mn-swap-v1` namespace. `offerId` is lowercase SHA-256 of those raw
bytes. The node also consumes Midnight nullifiers, commitments, unshielded
creates/spends and Merkle roots, then serves the live/archive API.

Offer status is `live | consumed | cancelled | expired | not_found`:

- A fill consumes all inputs atomically in one Midnight transaction and creates
  the offer's output markers.
- Shielded markers are exact commitments.
- Since PR #45, unshielded marker rows are exact ledger identities
  `(owner, intent_hash, output_no)`; token type and value are audit fields.
  The Phase-(d)-deferred SQL classifier still performs its final payout lookup
  by `(owner, token_type, value)`, so the cross-offer same-shape bypass remains
  scoped to that separate workstream.
- Partial/split spends or missing markers classify `cancelled`; TTL archives
  classify `expired`.

## Reference run

Use the same expiry environment on both processes:

```sh
NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 bun run dev
```

Wait for the `MINTED` line, then in another shell:

```sh
GRAND_OFFERS=60 ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 \
  bun run packages/tests/grand-e2e/run.ts
```

The dev batcher configuration for this gate is one wallet with at least five
spendable NIGHT UTXOs and `maxSlotsPerWallet=5`. If genesis supplies fewer,
bootstrap must self-split before the run. Each slot needs its own coin; a high
balance in one UTXO still serializes submissions.

Do not run `run.ts` bare: its default is 500 offers and takes hours. A 60-offer
run is roughly 80 minutes after the stack's roughly five-minute bootstrap.

## Verdict rules

1. Read `maxLagBlocks` first. The healthy historical band is 53–96; above
   roughly 150 makes the run VOID, not failed.
2. Grep the log for `not built (`. The cross-layer and basket fixtures skip
   loudly when construction fails; a green score alone does not prove them.
3. Never reuse a chain. Specialists and expected fates rely on exact coin
   counts. Restart the stack and use a fresh database after any failed run.
4. A valid closeout run records scorecard pass/fail/expected-red totals,
   `maxLagBlocks`, and both determinism checks.
5. Tear down only this stack's processes/containers when finished.

## What the suite proves

- Both API and permissionless Celestia ingestion doors reject by code.
- Stored bytes, content hashes, legs, spend references and marker counts agree
  with independent derivation.
- Served rows re-validate, remain live and respect expiry.
- Fill/cancel accounting, chart volume, price orientation, chain-time windows,
  basket exclusion and `/v1/pairs` ordering agree.
- N-way, cross-door, late-loser and same-block duplicate competition works.
- Shielded and unshielded fates are audited separately.
- A second node replay produces identical state and offer-hash sets.

T-E2 (partial-overlap competition) and T-E5 (two truly concurrent takers) are
the two remaining adversarial cases.

## Operational traps

- This checkout path contains a space. `grand-b-config-drift.test.ts` must use
  `fileURLToPath(new URL(...))`; otherwise four tests fail to load via `%20`.
- `pkill -f` matches its own command. Bracket patterns, for example
  `orchestrato[r] start`.
- A batcher connection error is not a settlement verdict. Re-read chain state.
- Both requests in T-E5 must be in flight before the first receipt; the normal
  `balancerChain` helper serializes all submissions and cannot prove the race.
- Top-level `--` comments in pgtyped SQL can log `Skipped` and exit 0. Use
  `/* */` and keep the regeneration guard green.
- `bun:test` treats a throw inside `test.failing` as the expected failure. Use
  explicit before/after evidence.
- There is no root TypeScript project. The compile gate is:

  ```sh
  bun build --target=bun packages/tests/grand-e2e/run.ts
  ```

## Done means

The closeout is complete only when the 60-offer/five-slot run exits green with
no loud fixture skips, the scorecard totals and healthy lag are recorded, both
determinism checks pass, and a deliberately slowed submit path has separately
proved the recalibrated performance gate still fails.
