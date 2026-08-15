# Open issues from the grand-e2e suite

Current as of 2026-08-15. Closeout blockers 1–4 are closed. The remaining
classifier work below is intentionally a separate unshielded workstream.

## 1. Exact-identity classification read switch (separate workstream)

PR #45 changed unshielded marker storage and archival to exact
`(owner, intent_hash, output_no)` identities. Token type and value remain
audit fields. The current `unshieldedCancelledPredicate` still groups its
final create lookup by `(owner, token_type, value)`.

Phase (d) must switch that read path to the already-persisted exact identity and
execute the unusual fallible/multi-intent shapes prepared in phases (a)/(b).
This was explicitly outside production-readiness closeout PR #46; do not mark
it fixed from the ordinary wallet-built fate matrix.

## Named limitations, unchanged by closeout

- **Reorg recovery:** archival is destructive. A consuming block reorg requires
  a full resync until a confirmation-depth/reversible-state design is chosen.
- **Celestia inclusion height:** the primitive boundary drops the original DA
  height. `blockHeight` is the indexer's L2 height, not a blob lookup height.
- **Dev health-tip display:** the suite derives real lag from
  `blockL2.timestamp`; the dev endpoint's configured NTP tip can report a
  misleading permanent syncing state.

## Closeout items closed on 2026-08-15

### Five-slot bootstrap and performance recalibration — CLOSED

Fresh bootstrap proved five registered/spendable NIGHT UTXOs and five worker
slots. If genesis yields fewer coins, the dev bootstrap self-splits. p5 then
proved actual overlap rather than trusting configuration: task peak 15,
batcher HTTP peak 6 and maximum batch 4 on the final run.

`baseline.json` is calibrated at `GRAND_OFFERS=60` / five slots from clean
run 5: submit p50/p95 3619/12167 ms and publish-to-index p95 27183 ms. The final
run measured 3025/12129 and 27205 ms and passed. A 2× slowed submit median still
fails the unit gate.

### SSE latency baseline keys — CLOSED

Clean sample 2 measured p50/p95 2224/2708 ms (n=21). Clean five-slot sample 3
measured 2254/10008 ms (n=38) with `maxLagBlocks 59`. Per the standing rule,
the committed keys use the maximum per-run values: 2254/10008, with no extra
headroom beyond enforcement's ×1.2. The final run measured 1925/10440 and
passed; the p95 remains reported below 50 samples while the median is enforced.

### T-E2 partial-overlap competition — CLOSED

The live fixture constructs exact inputs `{A,B}` / `{B,C}`, sharing only B.
Settling offer 1 removes the partial-overlap loser, which reads `cancelled`,
cannot settle and creates no trade print. All assertions passed in runs 5 and
6.

### T-E5 two takers, one coin — CLOSED

The fixture prepares two settlements, bypasses the ordinary client queue and
releases both through one barrier. It proves both requests were in flight
before the first receipt; exactly one lands; the loser carries
transaction-specific batcher/chain double-spend evidence rather than
`UTXO_NOT_LIVE`; competitors archive once with correct read statuses; and
exactly one trade prints. All assertions passed in runs 5 and 6.

## Final closeout run

Run 6 at `63c9fc5` used a brand-new chain and matching
`ROOT_WINDOW_SECONDS=600` / `OFFER_TTL_SECONDS=600`:

- 238 checks, 0 failures, 87.9 minutes;
- `maxLagBlocks 101`, `lastLagBlocks 2` (valid, below the 114 gate and 150
  VOID ceiling; not reused as a calibration sample);
- both determinism checks passed;
- no loud fixture skip, foreign heavy process or indexer pool error;
- hash-pinned evidence:
  `/tmp/zswap-closeout-evidence/run6-final-green/`.

## Canonical run rules

```sh
GRAND_OFFERS=60 GRAND_STORM_API=200 GRAND_STORM_CELESTIA=30 \
ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 \
bash ./packages/tests/grand-e2e/fresh-run.sh
```

Never reuse a chain. Treat `maxLagBlocks > 150` as VOID, grep for
`not built (`, and tear down only this stack when finished.

## Fixed or ruled

| Issue | Current state |
|---|---|
| Batcher dust livelock | Fixed upstream in batcher-sdk 0.103.1; dev bootstrap now proves five fee-capable streams |
| `celestiaHeight` mislabeled | REST/SSE field renamed `blockHeight`; DB legacy name remains internal |
| Cross-layer offers | Ruled REJECT; `CROSS_LAYER` enforced at both doors |
| Invisible STF errors | Transition wrapper logs and rethrows |
| Unshielded ordinary fill-vs-cancel | Fixed and live-proven; exact-identity read switch remains item 1 |
| `pair_stats.last_price` orientation | Fixed and cross-checked against chart stats |
| 24-hour wall/chain clock mix | Fixed on L2 chain time |
| Root window and advertised expiry | Fixed with current-root escape and bounded cleanup |
| Basket market pollution | Ruled ACCEPT-but-exclude; all five market surfaces covered |
| Cursor failover ordering | Fixed on `(celestia_height, offer_hash)`; replay deterministic |
