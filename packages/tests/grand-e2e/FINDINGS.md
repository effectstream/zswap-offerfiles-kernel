# Production-readiness findings and resume point

Current as of 2026-08-14. This file records the conclusions that should survive
the work, not a stale merge queue. See `PRODUCTION-READINESS.md` for detailed
red→green reasoning and `ISSUES.md` for the current open set.

## Current state

- `main` is `5aec4d7` after PR #45.
- Unit baseline is 262 pass, 0 fail.
- Latest valid full run: 223 checks, 1 failure, `maxLagBlocks 80`; both p7a
  determinism checks passed.
- The one failure is a performance baseline calibrated at 25 offers/seven
  slots but exercised at 60 offers/one slot. It is not permission to raise the
  threshold; concurrency must be fixed and measured first.
- Remaining closeout: five-slot bootstrap/recalibration, SSE keys, T-E2/T-E5,
  and the final fully-green run.

## Findings that changed the design

### Concurrency is coin-count limited

The batcher can have a large NIGHT balance and still serialize. Each in-flight
transaction reserves a distinct spendable coin. The closeout configuration is
one wallet with at least five spendable NIGHT UTXOs and
`maxSlotsPerWallet=5`; bootstrap self-splits when needed. The proof is p5 no
longer reporting roughly 25 s per single-file transaction.

### Unshielded output identities are knowable at publication

The old premise said payout intent hash/output index belonged to the settling
intent and therefore markers had to shape-match `(owner, token_type, value)`.
Live settlement evidence disproved it: per-party intents survive
`Transaction.merge`, and each payout's creating identity is derivable from the
offer's own intent.

PR #45 now persists exact `(owner, intent_hash, output_no)` marker identities,
including segment-aware intent hashes; token type/value remain audit fields.
The Phase-(d)-deferred SQL classifier still uses its temporary shape grouping,
so the cross-offer same-shape bypass is not claimed fixed by closeout.

### Lag failures can be external and must be classified first

One compromised run reached `maxLagBlocks 1403` while another workload starved
the Celestia devnet; the chain tip itself stopped advancing. Downstream publish,
index, chart and SSE failures were consequences, not separate product defects.
Healthy historical lag is 53–96. Above roughly 150 voids a run.

### A transport error is not a settlement verdict

A batcher connection failure was measured twice while the transaction outcome
remained discoverable on chain. Re-check chain state before deciding whether a
settlement failed or retrying it.

### `test.failing` can produce a false red/green story

Bun treats a thrown exception inside `test.failing` as the expected failure.
The basket test once passed for a missing-table throw and could never signal its
fix. Closeout uses explicit before/after evidence and removes all remaining
`test.failing` calls.

## What is merged and proven

| Area | State |
|---|---|
| Schema collapse, deterministic cursor, chain-derived timestamps | merged; replay-identical |
| Unshielded ordinary fill-vs-cancel | merged; live cancel/fill and chart totals green |
| Price orientation and 24-hour chain window | merged; unit and live cross-checks green |
| Expiry advertisement and cleanup | merged; p8 live/expiry checks green |
| Cross-layer offers | rejected by explicit `CROSS_LAYER`; both doors covered |
| Baskets | accepted but absent from all five market surfaces; live fixture covered |
| Post-commit SSE publication | merged; uncommitted/retry gates unit-covered |
| Segment-aware unshielded identities | merged in PR #45; unit baseline green, final full run pending |

## Run playbook

Use the same window configuration on stack and suite:

```sh
NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 bun run dev
```

```sh
GRAND_OFFERS=60 ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 \
  bun run packages/tests/grand-e2e/run.ts
```

Wait for `MINTED`. Never reuse a chain. Check `maxLagBlocks` before debugging
other failures, and grep the log for `not built (` before accepting a green
score. Record scorecard totals plus both determinism checks, then tear down the
stack.

## Environment traps worth retaining

- The workspace path contains a space; convert file URLs with `fileURLToPath`.
- System PostgreSQL can reclaim port 5432 after reboot.
- `pkill -f` can kill its own shell; bracket the pattern.
- Top-level `--` comments can make pgtyped skip generation with exit 0.
- Backticks in SQL comments terminate `queries.app.ts` template literals.
- `gh pr edit` fails on this repository's deprecated Projects query; patch PR
  bodies through `gh api`.
- There is no root `tsconfig`; build `packages/tests/grand-e2e/run.ts` with Bun.

## Resume here

1. Make five spendable NIGHT UTXOs observable at bootstrap and set five slots.
2. Prove p5 serialization is gone.
3. Recalibrate at 60 offers, add submit p50, and prove a slowed path still
   fails.
4. Use the same healthy run for SSE sample 3 and baseline keys.
5. Implement T-E2/T-E5 red→green.
6. Run the final suite and record zero failures, healthy lag, no fixture skips,
   and both determinism checks.
