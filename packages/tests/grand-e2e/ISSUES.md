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

## 1. Batcher holds 5 transactions of dust — settlement load impossible — **BLOCKS THE SUITE**

**Verdict: PROVISIONING + PRODUCT. Severity: high.** Not a slow batcher — one
that settles **five** transactions, then livelocks.

### The arithmetic, from the batcher's own boot log

| | |
|---|---|
| dust balance at boot | `1.25e24` specks = **1,250,000,000 DUST** |
| cost per balancing tx | **250,000,000 DUST** |
| **capacity** | **5.0 transactions** before regeneration |

Which is exactly why it reports `worker slots: 5 (5 UTXOs, cost=1/tx, cap=5)`.
The suite needs ~250 settlement/cancel transactions at `GRAND_OFFERS=250`, and
~600 at the handoff's full scale.

### What happens after the fifth

Every cycle waits 60 s for regeneration, tries anyway ("will likely fail and
re-queue"), fails, re-queues — forever. 71-87 cycles observed per run, queue
pinned at 250-282, and **nothing surfaced**: `/status` and `/queue-stats` keep
reporting `isInitialized: true` with a static pending count. Three runs died
this way (77, 84 and ~90 min), each *after* setup had succeeded.

### This reframes PR #23

`BATCHER_MAX_SLOTS_PER_WALLET=5` does not buy sustained 5x throughput. Against
a five-transaction budget it spends the **entire** dust supply in one batch.
Slots and dust must be provisioned together — raising slots alone converts a
slow pipeline into an immediately starved one.

### Fixes

1. **Provision the batcher** (unblocks the suite): register far more NIGHT for
   dust generation, sized to `expected tx/hour x 250,000,000 DUST`. The dev
   chainspec currently affords five transactions — a smoke test, nothing more.
2. **Do not livelock** (product): back off and surface dust exhaustion rather
   than retrying a balance the code itself predicts will fail. A queue that
   never drains behind a healthy-looking `/status` is the worst failure shape
   for an operator.
3. **Suite alternative**: settle directly, takers paying their own fees, as
   `api-examples/11-settle-offer.ts` already does via
   `wallet.submitTransaction`. Needs each taker funded with NIGHT and
   registered for dust, but removes the shared bottleneck and exercises a
   documented settlement path.

### Current status

Setup completes cleanly — 640 coins direct from genesis, batcher untouched,
~40 min — and the run reaches p1 → p2 → p4 → p3 with **43 passes**. Every
failure past that point is this one cause: settlements time out, so archival,
classification, SSE and chart assertions all fail downstream.

---

## 2. `celestiaHeight` was not a Celestia height — **RESOLVED by renaming**

The API served `celestiaHeight` on every offer (and on `offer_indexed` SSE
events) that was actually the indexer's own effectstream/L2 block height. The
STM writes `data.blockHeight`, typed `EffectstreamBlockNumber`; proven against
the suite's ledger, where an offer published via `blob.Submit` at Celestia
height **1734** was stored and served as **1776**, with the gap growing since
the two are different clocks.

### Why it is not fixed "properly"

The Celestia inclusion height never reaches the STM. The DA primitive builds
its state-machine input from the blob payload alone:

```ts
const { payload } = primitiveTransactionData.output;
generateRawStmInput(this.grammar, this.stateMachinePrefix, { payload })
```

The height is known at the fetcher (`blob.GetAll` is per-height) and dropped at
that boundary. Carrying it through would mean adding a parameter to every
primitive — a refactor rejected as disproportionate for a display field.

`sync_protocol_pagination` does hold the real height and hash (verified: stored
hash matched `header.GetByHeight` exactly), but it keeps **one row per
protocol**, not a history, so past offers cannot be resolved — and reading the
current page at ingestion would be non-deterministic, breaking replay
equality, which is the one property this system cannot trade away.

### Decision: rename, don't refactor

No consumer computes against Celestia semantics — the value is stored, copied
through the archive CTEs, and displayed. The rejected-blob scrub keys on
`effectstream_block_height`, which is already correct precisely because both
sides are L2. So only the *name* and the *docs* were wrong.

- REST and SSE now expose **`blockHeight`**, documented as the indexer's L2 height.
- `API.md` no longer teaches feeding it to `blob.GetAll`; it points at `offerId`
  (the sha256 of the exact published bytes) for locating a blob on the namespace.
- The DB column keeps its legacy `celestia_height` name behind a comment — it is
  internal, and a migration was not worth it.

**Not a MIP change:** `celestiaHeight` was never in `OffchainOfferPayload`
(`version`, `offerId?`, `offerBech32?`, `computed{…}`) — it was our own additive
field, so no spec revision or team sign-off was required.

### If the by-height workflow is ever needed

The fix is upstream and small: have the DA primitive include the inclusion
height in the payload it forwards, alongside `namespace` and `commitment`.

---

## 3. Cross-layer offers fail with a misleading code — **suite no longer builds them**

**Cross-layer (shielded ↔ unshielded) swaps are not a supported offer shape.**
The suite originally built them because HANDOFF §7 asks for "~25% mixed"; that
was a misreading on my part, and those offers have been removed
(`Layer` is now `"ss" | "uu"`).

Keeping the note because the *failure mode* is worth knowing, and there is a
real gap behind it.

### What happened

`wallet-sdk-facade@4.1.0`'s `initSwap` decides layer participation from inputs
**or** outputs:

```js
hasUnshieldedPart = (unshieldedInputs && Object.keys(unshieldedInputs).length > 0)
                    || unshieldedOutputs.length > 0;
```

but constructs that half only when the **inputs** are defined:

```js
unshieldedTx = hasUnshieldedPart && unshieldedInputs !== undefined ? … : undefined;
```

A shielded-give / unshielded-want request therefore passes the guard and has
its outputs **silently discarded**, producing a one-sided transaction. The
result is a confusing `NOT_A_SWAP` ("1 give, 0 wants") that points at the
indexer rather than at the request.

### The gap worth deciding on

Nothing in the validator enforces "give and want share a layer". `NOT_A_SWAP`
fires only because the SDK dropped a leg — an accident, not a rule. A
correctly-built cross-layer offer from another wallet implementation would
reach `isTwoSided()` with a legitimate give and want on different layers and,
as far as the code shows, be **indexed**.

If cross-layer offers must never be tradeable, that belongs in the ladder as
its own explicit check and code — not left to an SDK quirk. Worth confirming
against MIP-0006 before adding.

### Suite state

- `ledger.ts` — `Layer` is `"ss" | "uu"`; cross-layer is unrepresentable.
- `phases/p3-lifecycle.ts` — the former cross-layer case is now a
  shielded↔shielded swap on the second token pair.
- `phases/p5-load.ts` — `LAYERS` carries only same-layer entries.
- `actors/wallets.ts` — `buildOffer` still validates what it built, so any
  future silently-dropped leg fails at construction rather than at ingestion.

---

## 4. State-transition errors are invisible — **FIXED in our code**

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

## 5. No green end-to-end run; `baseline.json` still empty

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
| 1 | Batcher livelocks on dust exhaustion | **product bug** | High | back off + surface; scale dust with slots |
| — | ~~`celestiaHeight` mislabeled~~ | **RESOLVED** — renamed to `blockHeight`, docs corrected | — | upstream primitive fix deferred by decision |
| 2 | Cross-layer offers unenforced in the ladder | gap — decide | Low/Medium | suite no longer builds them; add an explicit rule if they must be refused |
| 3 | ~~STF errors invisible~~ | **FIXED** — `addTransition()` logs and rethrows | — | verify on next STF failure |
| 4 | No green run / empty `baseline.json` | in progress | — | run 12 hit 50 pass / 1 fail in 35 min; both causes now fixed |

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
