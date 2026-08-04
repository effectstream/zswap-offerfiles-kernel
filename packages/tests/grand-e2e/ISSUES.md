# Open issues from the grand-e2e suite

Every issue below has been **reproduced against a live stack**, with the actual
output recorded. Fixed issues are removed from this file (see git history and
the linked PRs).

Each entry gives the reproduction command, the observed result, the verdict
(product bug / test bug / docs bug), and the fix.

**Environment for all reproductions:**

```bash
NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 BATCHER_MAX_SLOTS_PER_WALLET=5 bun run dev
```

> **Teardown trap:** `pkill -f main.dev.ts` also matches the command line of the
> script doing the killing. Use bracketed patterns:
> `for p in "main[.]dev[.]ts" "batcher[.]dev[.]ts" "npm-midnigh[t]" "celestia-devne[t]" "start-pglit[e]" "orchestrator/src/cl[i]"; do pkill -9 -f "$p"; done`

---

## 1. Mixed offers: the unshielded want output is silently never created

**Verdict: TEST BUG in the suite's offer construction — but with a product
question attached. Severity: medium.**

A shielded-give / unshielded-want offer is rejected `NOT_A_SWAP`
("1 give, 0 wants"). It is **not** a leg-derivation bug: the transaction
genuinely has no unshielded output.

### Reproduce

```bash
bun run packages/tests/grand-e2e/triage-mixed-offer.ts
```

### Observed

```
── validator verdict ──
ok:    false
code:  NOT_A_SWAP
gives: [{"token":"0000…0000","amount":"1000","kind":"SHIELDED"}]
wants: []

tx imbalances (ground truth):
  seg0 shielded 000000000000 = 1000

── verdict ──
TEST BUG: the tx never carried an unshielded output.
```

The raw transaction imbalances — read straight off the ledger object, bypassing
`deriveLegs()` entirely — show **only** a shielded entry. `deriveLegs` is
reporting the transaction accurately.

### What was ruled out

| Hypothesis | Result |
|---|---|
| `deriveLegs()` misses unshielded wants | **Ruled out** — no unshielded imbalance exists to miss |
| The `finalizeTransaction()` vs `signRecipe()` branch drops it | **Ruled out** — forcing the `signRecipe` path gives a byte-identical outcome (16439 vs 16440 chars, same verdict) |
| Same-color netting (shielded NIGHT vs unshielded NIGHT) | **Ruled out** — the suite's p3 offer used distinct colors (TB→UB) and failed identically |
| The call shape is type-illegal | **Ruled out** — `CombinedSwapOutputs = ShieldedTokenTransfer \| UnshieldedTokenTransfer`, so an unshielded output is a legal argument |

### Open product question

`initSwap` accepts a type-legal unshielded desired output alongside a shielded
input and **silently returns a transaction without it — no error, no warning**.
Either mixed-layer swaps are unsupported (then rejecting the argument loudly
beats dropping it), or this is an SDK defect. Worth raising upstream; MIP-0006
mixed offers depend on the answer.

### Mitigation applied (suite side)

1. `phases/p5-load.ts` — `mixed-sg` / `mixed-ug` removed from `LAYERS`.
   Restore them once the SDK either supports the combination or rejects it.
2. `actors/wallets.ts` — `buildOffer` now runs `validateZswapOffer` on what it
   actually built and throws with the derived legs if it is not a valid offer.
   The old `try/catch` fallback could never have caught this: the failing path
   throws nothing, it just returns a transaction missing a leg. With the guard
   the failure names itself at construction instead of surfacing much later as
   an opaque `NOT_A_SWAP` at ingestion, misattributed to the indexer.

---

## 2. State-transition errors are invisible

**Verdict: PRODUCT ERGONOMICS. Severity: medium.**

The runtime routes STF errors to telemetry only (`process-blocks.ts` STEP 5).
A clean SQL failure therefore surfaced as an unexplained process exit — this is
**why the NUL crash (PR #22) took hours instead of minutes** to localise, and
it will do the same to the next STF bug.

### Reproduce

```bash
grep -rn "log.remote" node_modules/@effectstream/runtime/src/process-blocks.ts
```

Patch that catch to `console.error`, trigger any STF failure, and confirm the
error text now appears. The patch is wiped by `bun install`, so the durable fix
belongs upstream.

### Fix

Surface STF errors at `console.error` at least in development.

---

## 3. No green end-to-end run; `baseline.json` still empty

**Status: in progress.** Runs 1–8 died in setup for operational reasons; run 9
reached 53 passes before the NUL crash; runs 10–11 were superseded by fixes.
With PR #22 and PR #23 in place the next run is the first with no known blocker.

### Test

```bash
GRAND_OFFERS=250 bun run test:grand     # calibration scale
GRAND_OFFERS=500 bun run test:grand     # full scale (handoff target)
```

**Pass:** exit 0, all-green `SCORECARD.md`, `out/metrics.json` written. Then
commit those numbers into `baseline.json` so later runs enforce at ×1.2.

---

## Results log

### Still open

| # | Issue | Verdict | Severity | Next step |
|---|---|---|---|---|
| 1 | Mixed-offer unshielded want silently dropped | test bug + upstream question | Medium | mitigated in-suite; raise with the wallet SDK |
| 2 | STF errors invisible (telemetry only) | product ergonomics | Medium | upstream — `console.error` in dev |
| 3 | No green run / empty `baseline.json` | in progress | — | next full run |

### Fixed

| Issue | Fix | Verified live |
|---|---|---|
| `0x00` in a blob body crashes the node | PR #22 — match the body's JSON encoding, never the body | node survives, rejection counted, accounting row scrubbed |
| Batcher single-worker settlement ceiling | PR #23 — `BATCHER_MAX_SLOTS_PER_WALLET` | `worker slots: 5 (5 UTXOs, cost=1/tx, cap=5)`, was 1 |
| Rate limit answered `500 INTERNAL`, not `429` | `statusCode: 429` in `errorResponseBuilder` | 90 requests → `{200:60, 429:30}`, body `{"error":"RATE_LIMITED"}` |
| `TOO_LARGE` unreachable over HTTP | per-route `bodyLimit: OFFER_MAX_BYTES * 2` | 1.8 MB → `400 TOO_LARGE`; 3.0 MB → `413`; 500 B → `400 BAD_ENCODING` |
| `API.md` documented `INVALID_FORMAT` / `INVALID_PROOF` | table rewritten to the codes `OfferRejectCode` actually emits | codes cross-checked against the type |
| `API.md` promised token auto-registration | doc corrected to state colors are NOT auto-registered, and why | matches `state-machine.ts` |
| Suite asserted removed `404 UNKNOWN_TOKEN` | assertion rewritten to the `$1` fallback contract | includes the not-persisted property (0 `token_prices` rows) |
| Suite asserted auto-registration | assertion inverted to assert absence | — |
