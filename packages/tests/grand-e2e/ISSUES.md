# Open issues from the grand-e2e suite

Current as of 2026-08-14. Fixed issues are summarized at the end; detailed
red→green history remains in git and in `PRODUCTION-READINESS.md`.

## 1. Five-slot batcher bootstrap and performance recalibration

**Verdict:** provisioning plus measurement; closeout blocker.

The last two 60-offer runs measured submit p95 at 10.79 s and 10.74 s against a
baseline calibrated at 25 offers and seven slots. Both later runs used a dev
batcher capped at one slot. p5 reported the consequence directly: settlement,
cancel and split transactions serialized at roughly 25 s per transaction.

The ruling is one master/batcher wallet with:

- at least five spendable NIGHT UTXOs at bootstrap;
- a bootstrap self-split when genesis provides fewer;
- `maxSlotsPerWallet=5` in the dev stack.

NIGHT balance is not concurrency: the SDK reserves a whole input coin per
in-flight transaction. The fix is not proven until p5 no longer reports the
single-file roughly-25-second pattern. Only then may `baseline.json` be
recalibrated at `GRAND_OFFERS=60`, and `submitP95Ms` must gain a p50 companion.
A deliberately slowed submit path must still fail the new gate.

## 2. SSE latency baseline keys

`sseDeliveryLagP50Ms` and `sseDeliveryLagP95Ms` are intentionally absent while
the CONSUMED-only metric is calibrated. Two samples exist; the clean one is
p50 2224 ms / p95 2708 ms (n=21). The next five-slot run may supply sample 3
only if `maxLagBlocks` is in the healthy 53–96 band.

Use the maximum per-run p50 and maximum per-run p95 across valid clean samples.
Do not add extra headroom: metrics enforcement already applies ×1.2. After
setting the keys, prove an out-of-band sample fails.

## 3. T-E2 partial-overlap competition

Fund exact UTXOs `{A,B,C}`. Offer 1 spends `{A,B}` and offer 2 spends `{B,C}`.
Settle offer 1. Assert offer 2 leaves the live book, reads `cancelled`, cannot
settle, and creates no trade print. The observable contract is archival and
classification; the loser cannot remain live because the shared-input spend
archives it in the same transition.

## 4. T-E5 two takers, one coin

Use a concurrent submission helper that bypasses the module-level
`balancerChain`, verify at least two batcher worker slots, and prove both
requests were in flight before the first receipt. Exactly one settlement must
land; the other must fail with the batcher/chain double-spend result. The offer
archives `CONSUMED` once and produces one print. `UTXO_NOT_LIVE` is an offer
ingestion code and is not the expected loser result here.

## 5. Exact-identity classification read switch (separate workstream)

PR #45 changed the unshielded marker storage model to exact
`(owner, intent_hash, output_no)` identities and carries those fields through
archival. The current `unshieldedCancelledPredicate` still groups the final
create lookup by `(owner, token_type, value)`. Switching that read path and
executing unusual fallible/multi-intent shapes belongs to unshielded phases
(c)/(d), not this closeout.

## Run rules

```sh
NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 bun run dev
```

```sh
GRAND_OFFERS=60 ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 \
  bun run packages/tests/grand-e2e/run.ts
```

- Same expiry environment on both processes.
- Wait for `MINTED`; do not reuse a chain.
- A bare runner defaults to 500 offers.
- `maxLagBlocks > 150` voids the run.
- Grep for `not built (` before accepting green.
- Tear down this stack when done.

## Latest valid run

2026-08-13: 223 checks, 1 failure, `maxLagBlocks 80`; both determinism checks
passed. The only failure was the scale/slot performance baseline mismatch.

## Fixed or ruled

| Issue | Current state |
|---|---|
| Batcher dust livelock | Fixed upstream in batcher-sdk 0.103.1; closeout still owes honest five-coin provisioning |
| `celestiaHeight` mislabeled | REST/SSE field renamed `blockHeight`; DB legacy name remains internal |
| Cross-layer offers | Ruled REJECT; `CROSS_LAYER` enforced at the shared validator |
| Invisible STF errors | Local transition wrapper logs and rethrows |
| Unshielded ordinary fill-vs-cancel | Fixed and live-proven; exact-identity read switch is item 5 above |
| `pair_stats.last_price` orientation | Fixed and cross-checked against chart stats |
| 24-hour wall/chain clock mix | Fixed on L2 chain time |
| Root window and advertised expiry | Fixed with current-root escape and bounded cleanup |
| Basket market pollution | Ruled ACCEPT-but-exclude; all five market surfaces covered |
| Cursor failover ordering | Fixed on `(celestia_height, offer_hash)`; replay deterministic |
