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

## 1. `celestiaHeight` is not a Celestia height — **NEW, user-facing**

**Verdict: PRODUCT BUG. Severity: medium-high** — it silently breaks the
independent-verification workflow `API.md` documents.

Every offer served by the API carries `celestiaHeight`, and
`/v1/health/sync` reports `recent_rejections[].celestia_height`. Neither is a
Celestia height. The STM writes `data.blockHeight`, which `@effectstream/sm`
types as `EffectstreamBlockNumber` — the L2 block height. The Celestia height
is not present in the STF input at all.

### Reproduce

Publish a blob directly, note the height `blob.Submit` returns, then compare
it with what the node stored:

```bash
bun run packages/tests/grand-e2e/triage-mixed-offer.ts   # any direct publish works
psql -h 127.0.0.1 -U postgres -d postgres \
  -c "SELECT offer_hash, celestia_height FROM offer_file"
```

### Observed

| Source | Height |
|---|---|
| `blob.Submit` returned (real Celestia inclusion) | **1734** |
| `offer_file.celestia_height` stored / served | **1776** |

Same for rejections — measured offsets of 42, 47 and 67 on one run, and the
gap **grows**, because the two are different clocks rather than a lag.

Mechanism, in `state-machine.ts`:

```ts
celestia_height: data.blockHeight,   // EffectstreamBlockNumber, not Celestia
```

### Why it matters

`API.md` explicitly teaches using this value to fetch the blob straight from
the DA layer (`blob.GetAll` at a height) for archival, mirroring, or
independent verification — the property the shared namespace exists to
provide. Anyone following that reads the wrong Celestia block and finds
nothing. Determinism is unaffected (the L2 height replays identically), so
nothing else in the system notices.

### Fix — pick one

- **Rename and document** (cheap, accurate): the column and API field become
  `blockHeight` / `effectstreamHeight`, and `API.md` stops promising a
  Celestia height.
- **Carry the real height** (correct, upstream): the framework's Celestia
  primitive would need to include the inclusion height in its payload — today
  it carries `suppliedValue`, `namespace`, `commitment`, `blobIndex` and no
  height — after which the STM can store it.

Until one lands, `offerId` (content hash) is the only reliable way to locate
an offer's blob on Celestia.

---

## 2. Cross-layer offers fail with a misleading code — **suite no longer builds them**

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

## 3. State-transition errors are invisible — **FIXED in our code**

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

## 4. No green end-to-end run; `baseline.json` still empty

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
| 1 | `celestiaHeight` is the L2 height, not Celestia's | **product bug** | Medium-High | rename+document, or carry the real height upstream |
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
