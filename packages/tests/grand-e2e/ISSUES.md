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

## 1. Mixed offers: SDK silently drops the cross-layer half — **WORKED AROUND**

**Verdict: SDK BUG (root-caused in source). Severity: medium.** A
shielded-give / unshielded-want offer was rejected `NOT_A_SWAP`
("1 give, 0 wants") because the transaction genuinely lacked the unshielded
output.

### Root cause — `wallet-sdk-facade@4.1.0`, `initSwap`

The two conditions disagree. Participation is decided from inputs **or**
outputs:

```js
const hasUnshieldedPart =
  (unshieldedInputs && Object.keys(unshieldedInputs).length > 0) || unshieldedOutputs.length > 0;
```

but construction additionally demands the **inputs** be defined:

```js
const unshieldedTx = hasUnshieldedPart && unshieldedInputs !== undefined
  ? await this.unshielded.initSwap(unshieldedInputs, unshieldedOutputs, ttl)
  : undefined;
```

So a cross-layer swap — shielded inputs, unshielded outputs — sets
`hasUnshieldedPart = true`, hits `unshieldedInputs === undefined`, and the
outputs are **discarded with no error**. The shielded side carries the same
asymmetry, so unshielded-give / shielded-want fails identically.

This is why the earlier evidence looked like a derivation bug and wasn't: the
transaction's raw imbalances show only the give side, so `deriveLegs` was
reporting it accurately. There was never an output to derive.

### Workaround (applied)

Pass an **empty object** for the opposite layer's inputs, which satisfies
`!== undefined` while selecting no coins:

```ts
{ shielded: { [giveColor]: amount }, unshielded: {} }
```

`actors/wallets.ts` does this for both directions. Remove it once the SDK's
two conditions agree.

### Reproduce / verify

```bash
bun run packages/tests/grand-e2e/triage-mixed-offer.ts
```

**Before:** `wants: []`, imbalances show only `seg0 shielded`.
**After the workaround:** an unshielded imbalance appears and `wants` is
populated. Mixed layers are restored to the p5 mix once this passes.

### Report upstream

The fix belongs in the SDK: make construction agree with the guard, or reject
the combination loudly. Silently returning a transaction that omits a
requested output is the worst option — callers cannot tell without
re-inspecting the result, which is why `buildOffer` now validates what it
built.

---

## 2. State-transition errors are invisible — **FIXED in our code**

The runtime reports STF errors to telemetry only (`log.remote`, line 262 of
`process-blocks.ts`), so a failing transition produced no console output: the
block transaction aborted and the next statement died with Postgres `25P02`,
surfacing as an unexplained process exit. That is exactly how the `0x00` scrub
crash presented — hours of bisecting a silent death whose cause was a one-line
SQL error the engine had already caught and hidden.

### Fix (no `node_modules` patch)

`state-machine.ts` now registers every transition through `addTransition()`,
which logs and **rethrows**, so rollback semantics are unchanged and only
visibility is added. Kept in our code so it survives `bun install`.

### Verify

Trigger any STF failure and confirm the console shows:

```
[STF] transition "<name>" FAILED (block N) — this aborts the block transaction: <error>
```

---

## 3. No green end-to-end run; `baseline.json` still empty

**Status: in progress.** Runs 1–8 died in setup for operational reasons (proof
server storms, coin-reservation deadlocks, a node-side cap on fan-out tx size);
run 9 reached 53 passes before the NUL crash; run 10 was superseded; run 11 was
stopped deliberately to reproduce the issues in this file without contending
for the genesis wallet and the rate-limit budget.

Run 12 is the first attempt with **every known blocker fixed** — PR #22 (NUL
crash), PR #23 (batcher ceiling) and PR #24 (rate limit, `TOO_LARGE`, docs,
corrected assertions, mixed layers excluded, build-time offer guard) — run from
a branch with all three merged. Note that a run needs all of them *together*:
a branch off `main` alone still carries the NUL crash and the 1-slot batcher.

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
| 1 | Mixed-offer cross-layer half dropped | **SDK bug** (root-caused in source) | Medium | worked around in-suite; report upstream |
| 2 | ~~STF errors invisible~~ | **FIXED** — `addTransition()` logs and rethrows | — | verify on next STF failure |
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
