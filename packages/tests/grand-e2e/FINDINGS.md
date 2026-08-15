# Production-readiness findings and closeout record

Current as of 2026-08-15. This file records conclusions that should survive the
work. See `PRODUCTION-READINESS.md` for detailed red→green reasoning,
`ISSUES.md` for the remaining separate work, and `HANDOFF.md` for operations.

## Current state

- Closeout branch `fix/production-readiness-closeout` is open as PR #46.
- Static gate: 274 pass, 0 fail, 707 assertions across 39 files.
- The pgtyped delete/regenerate/diff guard is green and the grand runner
  bundles.
- Final fresh-chain run at `63c9fc5`: **238 checks, 0 failures, 87.9 minutes,
  `maxLagBlocks 101`, `lastLagBlocks 2`**.
- Both p7a determinism checks passed; state A/B share SHA-256
  `24ef7cc73f84f9a3277e167a1ab6c6b4b0db62a868b93a5b4ed8151d6d0477b0`.
- The loud-skip grep is empty. No foreign heavy process or indexer pool error
  contaminated the run.
- Final evidence is hash-pinned at
  `/tmp/zswap-closeout-evidence/run6-final-green/`.

## Findings that changed the design

### Batcher concurrency is coin-count limited

A wallet can hold a large NIGHT balance and still serialize because each
in-flight transaction reserves a distinct spendable coin. The dev stack now
blocks readiness until one wallet proves five registered NIGHT UTXOs, five
fee-capable dust streams and `maxSlotsPerWallet=5`; it self-splits when
genesis supplies fewer.

Configuration is not the proof. The final p5 run measured task peak 15,
batcher HTTP peak 6 and max batch 4. Its 23.3 s/effective request was close to
the old ~25 s wall rate, but six simultaneous HTTP requests and a
four-transaction batch prove the client-side single-file path is gone.

### Unshielded output identities are knowable at publication

The old premise said payout intent hash/output index belonged to the settling
intent, forcing marker shape matching by `(owner, token_type, value)`. Live
evidence disproved it: per-party intents survive `Transaction.merge`, and the
offer itself reveals each output's creating identity.

PR #45 persists exact `(owner, intent_hash, output_no)` marker identities,
including segment-aware intent hashes; token type/value remain audit fields.
The separate Phase-(d) SQL classifier still uses its temporary shape grouping.
Closeout does not claim that read switch or unusual-shape execution complete.

### Performance baselines need provenance, not accumulated slack

The old submit baseline was calibrated at 25 offers and a different slot
profile, then used against 60 offers. Run 5 supplied clean five-slot
measurements: submit p50/p95 3619/12167 ms and publish-to-index p95 27183 ms.
`baseline.json` records the source run and relies only on the existing ×1.2
enforcement margin.

The submit p50 companion prevents a low-count tail from carrying the gate
alone. An exact run-5 snapshot passes, a 2× slowed submit median fails, and a
151-block path fails the lag gate.

### SSE tail and TTL scheduling are different populations

SSE measures CONSUMED archives. TTL scheduling lag is reported separately and
covered by STM lag. Clean samples 2 and 3 measured 2224/2708 and 2254/10008 ms;
the committed p50/p95 keys use the required maximum per-run values
2254/10008, without extra headroom. Below 50 samples the SSE p95 is reported,
while the median remains enforced.

### Lag failures must be classified before product debugging

A historical contended run reached `maxLagBlocks 1403` while another workload
starved the devnet. Closeout classified two later runs VOID at 233.9 and 162.9
blocks instead of treating downstream timeouts as product failures.

The final run peaked at 101: above the 53–96 calibration-sample band but below
the committed 114 gate and 150 VOID ceiling. It is valid final evidence, not a
calibration sample.

### A transport error is not a settlement verdict

A batcher connection failure can occur after the chain has decided the
transaction. T-E5 therefore correlates its losing transaction's fingerprint
with the batcher chain-rejection trace and checks final chain/API state rather
than treating a callback timeout as the verdict.

### `test.failing` can produce a false red→green story

Bun treats a thrown exception inside `test.failing` as the expected failure.
The basket test once passed because a table was missing. Closeout uses explicit
before/after evidence; the scoped repository search contains no
`test.failing(...)` calls.

## What is proven

| Area | Final evidence |
|---|---|
| Stored truth | 66/66 blobs revalidated; bytes, hashes, legs, spends and markers agree |
| Served truth | p8 12/12; full validation, liveness, expiry and payload presence |
| Fill/cancel | Ordinary shielded/unshielded fates and chart totals agree |
| Exact unshielded identities | Persistence is merged and deep-audited; Phase-(d) read switch remains separate |
| Cross-layer offers | Explicit `CROSS_LAYER` at both ingestion doors |
| Baskets | Accepted and excluded from all five market surfaces |
| Duplicate competition | N-way, cross-door, late-loser and same-block checks green |
| T-E2 | Exact `{A,B}` / `{B,C}` partial overlap green |
| T-E5 | True in-flight race, one chain winner, exact archive/status/print accounting green |
| Five-slot throughput | Five spendable UTXOs/slots, HTTP peak 6, max batch 4 |
| Performance | Final metrics gate green; slowed-path and VOID-path unit gates red |
| Determinism | Independent replay state and offer-hash sets identical |

## Final run metrics

| Metric | Result |
|---|---:|
| Submit p50 / p95 / max | 3025 / 12129 / 13123 ms |
| Publish-to-index p50 / p95 / max | 18041 / 27205 / 30887 ms |
| SSE p50 / p95 / max | 1925 / 10440 / 10441 ms |
| Book read p50 / p95 / max | 8 / 15 / 15 ms |
| STM max / last | 101 / 2 blocks |
| Batcher queue max | 6 |

## Run playbook

```sh
GRAND_OFFERS=60 GRAND_STORM_API=200 GRAND_STORM_CELESTIA=30 \
ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 \
bash ./packages/tests/grand-e2e/fresh-run.sh
```

Never reuse a chain. Check foreign load before launch, read `maxLagBlocks`
before diagnosing downstream assertions, grep for `not built (`, record both
determinism checks, and tear down the stack.

## Environment traps worth retaining

- Convert file URLs with `fileURLToPath`; the workspace path contains a space.
- System PostgreSQL can reclaim port 5432 after reboot.
- Bracket `pkill -f` patterns so the command does not match itself.
- Top-level `--` SQL comments can make pgtyped skip generation with exit 0.
- Backticks in SQL comments terminate generated template literals.
- `gh pr edit` fails on this repository's deprecated Projects query; use
  `gh api` to patch PR bodies.
- There is no root `tsconfig`; bundle the grand runner with Bun.

## Next boundary

Production-readiness closeout is complete. The next product work is the
separate unshielded Phase-(c)/(d) workstream, especially switching
`unshieldedCancelledPredicate` from shape matching to the exact identities
already persisted by PR #45. PR #46 remains unmerged until maintainer review.
