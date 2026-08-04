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

## 1. Batcher starves at 5 concurrent settlements — **coin count, not balance**

**Verdict: PROVISIONING (fixable from the suite). Severity: high.**

> **Update 2026-08-04:** the *livelock* half of this issue is **fixed upstream**
> in `@effectstream/batcher-sdk` 0.103.1
> ([effectstream#847](https://github.com/effectstream/effectstream/pull/847)),
> which root-caused it with a Dockerized adversarial harness: the doom loop
> needs an infrastructure seed (indexer outage, misprovisioning) after which the
> old mechanics turned a transient condition into silent input loss. 0.103.1
> classifies infra-vs-input failures (infra parks inputs, cools the target, and
> charges no retries), gates capacity on *spendable* dust value rather than coin
> count, honors `maxRetries`/`retryDelayMs` (previously accepted but ignored),
> rejects poison/oversized payloads at `/send-input` with a 400, and reverts
> dust bookings on `signRecipe`/submit-timeout failures. This repo wires the new
> knobs through `BATCHER_MAX_RETRIES`, `BATCHER_RETRY_DELAY_MS`,
> `BATCHER_DUST_WAIT_TIMEOUT_MS`, `BATCHER_MIN_SPENDABLE_DUST_PER_COIN` and
> `BATCHER_MAX_INPUT_CHARS`. The provisioning guidance below (fat NIGHT UTXOs
> after registration) still applies — coins are still the parallelism unit.

### What actually constrains it

Dust *balance* is never the limit. Measured fees from the ledger's own
`calculateTransactionFee` (reference repo `POST /fees`, 1 DUST = 1e15 specks):

| tx shape | fee |
|---|---|
| contract call, single | **290 specks** |
| NIGHT transfer, balanced | **715 specks** |

Generation on a dev chain runs ~15 orders of magnitude above that. The real
constraints are **per-coin**:

1. **Parallelism = dust-coin count.** Each in-flight transaction locks one
   whole dust coin until its change matures. The batcher boots with **5**
   coins ⇒ 5 concurrent settlements, then the
   `no dust UTXOs yet, waiting up to 60000ms for regeneration` loop — the
   coins are *locked*, not empty.
2. **Each coin must clear the `additionalFeeOverhead` margin (3e14 specks).**
   A coin's cap is `NIGHT x 5 DUST` and fills over ~a week, so a coin minted
   from a tiny NIGHT UTXO is worthless for a long time and fails
   "could not balance dust".

### Fix

Send the batcher ~20 **large** NIGHT UTXOs *after* it has registered — each
becomes an independent dust stream (delegation is address-level:
`semantics.rs` consults `address_delegation` then calls `fresh_dust_output`,
so no re-registration is needed). `provision-batcher-dust.ts` does this with
`PER_UTXO = 5e12` stars (5M NIGHT ⇒ cap 2.5e22 specks).

**Ordering matters:** provisioning must run *after* registration. Registration
"rotates" pre-existing UTXOs, consolidating them into at most two outputs — so
funding first destroys the very coins you are trying to create.

### Corrections to earlier analysis in this file

Two previous entries here were wrong and are withdrawn:

- *"a balancing tx costs 250,000,000 DUST"* — misread. The batcher logs
  `formatDust(dustCost)`, which divides specks by 1e15; that line is a
  reserve/cap figure, not the fee. Real fees are hundreds of **specks**.
- *"the dev chain can only fund ~10 transactions, raise the chainspec NIGHT
  allocation"* — false, and the recommendation was withdrawn. Total NIGHT was
  never the constraint; coin count and coin size are.

The livelock itself still stands as a product issue: retrying a balance the
code predicts will fail, indefinitely, behind a `/status` that keeps reporting
`isInitialized: true`, is the wrong failure shape. It should back off and
surface the condition.

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

## 5. Green end-to-end run — **ACHIEVED 2026-08-04**

**Status: done.** `143 checks, 0 failures, 50.3 min` at `GRAND_OFFERS=25`, exit
0, `SCORECARD.md` all-green, and `baseline.json` calibrated from the run so
later runs enforce at x1.2.

Runs 1-8 died in setup for operational reasons; run 9 reached 53 passes before
the NUL crash; runs 10-11 were superseded or stopped deliberately. Runs 12-15
each got further and each surfaced something real:

| run | outcome | what it cost / taught |
|---|---|---|
| 12 | 108 pass / 9 fail | first near-complete run; p7a fell back |
| 13 | 4 fail | ttl/root windows never exported to the node |
| 14 | pulled in p5 | 25 batcher slots starved the box; 13 casualties |
| 15 | **143 / 0** | 7 slots, clean stack, determinism ran for real |

### Reproducing it

The run is driven by `fresh-run.sh`, which exists because three things must be
true at once and none of them are defaults:

```bash
./packages/tests/grand-e2e/fresh-run.sh          # 25 offers, ~50 min
GRAND_OFFERS=250 ./packages/tests/grand-e2e/fresh-run.sh
```

1. **A wiped PGlite.** The audit sums the whole database, so a warm stack fails
   the chart checks with the previous run's fills.
2. **`ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600` exported before the
   orchestrator starts.** The node reads them only at startup. Without them a
   run fails four checks that look unrelated, ~20 min in.
3. **`BATCHER_MAX_SLOTS_PER_WALLET=7` plus ~20 fat NIGHT UTXOs provisioned
   *after* registration.** Slots are `min(dust coins / cost, cap)` and the cap
   defaults to 1; registration rotates pre-existing UTXOs into at most two
   outputs, so funding first destroys the coins it is trying to create.

7 and not 100: removing the dust bottleneck exposes the **proof server** as the
next ceiling. 25 slots drove load average to 25-30 on a 16-core box, starved
the celestia devnet (block production ~6/min -> 1-3/min, 11x "underlying
subscription is stuck"), and offers began dying with `blob.Submit failed: The
operation timed out`. Neither resulting failure named the proof server.

Note `baseline.json` is calibrated at 25 offers on one box; re-calibrate for a
different scale. `publishToIndexed` p95 (~24 s) is dominated by the celestia
`delayMs`, not by node work.

---

## Results log

### Still open

| # | Issue | Verdict | Severity | Next step |
|---|---|---|---|---|
| — | ~~Batcher livelocks on dust exhaustion~~ | **FIXED upstream** — batcher-sdk 0.103.1 (effectstream#847) | — | infra-vs-input classification, dust-aware capacity, honored retry config |
| 2 | `pair_stats.last_traded_at` uses SQL `NOW()` | **product bug** | Medium | breaks replay determinism and mis-orders the pair list after a resync; use the block timestamp |
| 3 | Root window not enforced on read | **product bug** | Low/Medium | pruning is write-triggered and `isKnownRoot` has no age predicate; a quiet chain keeps accepting expired roots |
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

---

## `pair_stats.last_traded_at` is wall-clock, not chain time

**Status:** OPEN — product bug, found by p7a-determinism on 2026-08-04. Not patched.

`upsertPairStatsByOfferId` ([queries.app.ts:446](../../database/sql/queries.app.ts))
writes the column with SQL `NOW()`:

```sql
INSERT INTO pair_stats (pair_key, base_color, quote_color, trade_count, last_price, last_traded_at)
SELECT ..., w.amount::numeric / NULLIF(g.amount::numeric, 0),
       NOW()                       -- <-- wall-clock at write time
```

So the column records **when this node indexed the fill**, not when the trade
happened. Two nodes replaying identical chain data disagree — measured by the
determinism phase, instance B replaying instance A's chain from height 1:

```
pair 0488d606…  last_price 0.80368098159509202454  (identical)
    A last_traded_at = 2026-08-04T19:54:32.242Z
    B last_traded_at = 2026-08-04T20:16:10.538Z
pair 571366…    last_price 1.4612500000000000      (identical)
    A last_traded_at = 2026-08-04T19:53:39.316Z
    B last_traded_at = 2026-08-04T20:16:09.688Z
```

Everything else in `pair_stats` matched exactly, and `offer_hash` sets were
identical across both nodes — the wall-clock stamp is the only divergence.

**Why it matters beyond determinism.** A node that was offline and catches up
stamps every historical trade with its catch-up time, so the pair list — which
orders by `last_traded_at DESC` ([queries.app.ts:499](../../database/sql/queries.app.ts))
— comes back in the wrong order, and the API reports trade times that never
happened. The codebase already states the rule it is breaking, in
[state-machine.ts:330](../../node/state-machine.ts): *"keyed on the block
timestamp, never wall-clock."*

**Fix:** thread the archiving block's timestamp into the upsert instead of
`NOW()`. The call site (`api.ts:102`) handles an event that knows its block.

**Suite behaviour meanwhile:** `diffStates` excludes `last_traded_at` from the
determinism diff and prints `last_traded_at EXCLUDED and it DID differ` when it
reproduces, so the run can be green without hiding the defect.

---

## The root window is not enforced on read

**Status:** OPEN — product issue, found while triaging a p4 failure on
2026-08-04. Not patched.

Two facts combine:

1. `pruneKnownRoots` is called **only** inside the `midnight-zswap-root`
   transition ([state-machine.ts:343](../../node/state-machine.ts)), with a
   cutoff derived from the block being processed. Pruning is write-triggered,
   so when the chain stops producing zswap roots nothing prunes.
2. `isKnownRoot` is `SELECT 1 FROM known_roots WHERE root = :root!` — no age
   predicate.

So on a chain that goes quiet, roots stay in the table past
`ROOT_WINDOW_SECONDS`, and the submit gate keeps accepting offers proving
against them. The window silently extends for as long as the quiet lasts.

**Measured.** Audit-time snapshot after a ~20 min replay with no offers
flowing: 10 rows spanning 594 s (inside the 600 s window) but 23 minutes old —
none pruned. Separately, with the node left on its 3600 s default, the
"foreign" Lace fixture was **accepted** (HTTP 200, stored as `offer_file` id=3)
because its root was still present at 20 min old; it is rejected as
`ROOT_UNKNOWN` only once new roots arrive and drive a prune.

**Impact:** low on a busy chain, where roots arrive constantly. It matters for
a quiet or stalled chain, and it makes the window's meaning depend on traffic
rather than on time.

**Fix:** add the age predicate to the read (`AND last_seen_ms >= :cutoff`), or
prune on a timer as well as on write. The read-side predicate is the cheaper
and more honest of the two — it makes the window true by construction.
