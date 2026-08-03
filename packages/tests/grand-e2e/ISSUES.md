# Open issues from the grand-e2e suite — test & verification plan

Every item below was surfaced by `packages/tests/grand-e2e`. Each has a
**self-contained procedure** you can run without the full 2 h suite, plus an
explicit pass/fail criterion, so "is this fixed?" is answerable in minutes.

Status vocabulary:

| Status | Meaning |
|---|---|
| **FIX OPEN** | Fix written, PR open, verification procedure below |
| **NEEDS TRIAGE** | Reproduced, root cause not yet proven — procedure decides product-bug vs test-bug |
| **ROOT CAUSE KNOWN** | Analysed to a definite cause; the fix decision is a judgement call, not an investigation |
| **BLOCKED** | Waiting on another item |

---

## Prerequisites

```bash
NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 BATCHER_MAX_SLOTS_PER_WALLET=5 bun run dev
```

Wait for `midnight-mint-test-tokens` to reach `done` before running anything:

```bash
curl -s http://127.0.0.1:4747/processes | jq -r '.processes[]|select(.name=="midnight-mint-test-tokens")|.status'
```

> **Teardown warning.** Use bracketed patterns when killing the stack, or
> `pkill -f` matches your own shell's command line and kills the script doing
> the killing:
> `for p in "main[.]dev[.]ts" "batcher[.]dev[.]ts" "npm-midnigh[t]" "celestia-devne[t]" "start-pglit[e]" "orchestrator/src/cl[i]"; do pkill -9 -f "$p"; done`

---

## 1. `0x00` in a blob body crashes the node — **FIX OPEN (PR #22)**

**Severity: critical.** Unauthenticated remote crash of every indexer for one
blob fee, on a permissionless namespace. Also fires on *ordinary* rejections of
genuine transactions (the live crash was a `NOT_A_SWAP`), because every real
Midnight transaction contains `0x00`.

**Mechanism.** The rejected-blob scrub matched the row by the blob body as
text. Both halves are illegal: reading the stored value raises
`unsupported Unicode escape sequence`, and binding the raw body as a parameter
raises `invalid byte sequence for encoding "UTF8": 0x00`. Either aborts the
block transaction; STF errors are telemetry-only, so it surfaced as an
unexplained sync exit (`25P02` on the next statement) that took the
orchestrator down.

### Test A — standalone, no stack, ~2 seconds

```bash
bun run packages/tests/grand-e2e/nul-crash-repro.ts
```

**Pass:** the INSERT is legal; the `->>` extraction fails *with no parameter at
all*; a clean parameter still fails against the poisoned row; and both
candidate fixes (`payload::text`, `payload_hash = md5(...)`) delete correctly.
This documents the constraint — it does not test our fix.

### Test B — live, end-to-end (the real gate)

```bash
bun run packages/tests/grand-e2e/verify-nul-fix.ts
```

Publishes a blob containing 16 NUL bytes and asserts three things:

| Check | Fail means |
|---|---|
| node survived the rejection | the crash is still present |
| rejection counted in `offer_rejections` | the blob never reached ingestion |
| accounting row actually gone | **the scrub silently matches nothing** |

**Pass:** all three ✅ and exit code 0.

> The third check is the one that matters and the one that caught a bad fix.
> An earlier `md5(JSON.stringify(parsedInput))` variant passed all 159 unit
> tests and then matched **nothing** live, because that does not reproduce the
> framework's stored document. It would have removed the crash while quietly
> disabling the scrub — i.e. restoring the unbounded attacker-controlled
> storage the DELETE exists to prevent. **Never accept this fix on unit tests
> alone.**

### Test C — unit regression

```bash
bun test packages/database/reject-cleanup.test.ts
```

**Pass:** 9/9, including *"a blob body containing 0x00 deletes instead of
killing the node"*.

### Test D — the fatal-on-normal-rejection claim

With the fix reverted, publish any *real* offer that the ladder rejects (e.g.
republish an already-indexed offer to force `DUPLICATE`) and watch the sync
process exit. This is what proves the bug is not adversarial-only. Optional —
Test B is sufficient for regression purposes.

---

## 2. Mixed offer rejected `NOT_A_SWAP` — **NEEDS TRIAGE**

A shielded-give / unshielded-want offer was rejected with
`expected ≥1 give and ≥1 want; got 1 give(s), 0 want(s)`.

Two possibilities, and they have very different consequences:

- **Product bug:** leg derivation does not see unshielded want outputs, so a
  whole class of legitimate mixed offers is unindexable.
- **Test bug:** `buildOffer` in `actors/wallets.ts` constructs the unshielded
  want leg incorrectly.

**This was masked until now** — it crashed the node (issue 1) before it could
be inspected.

### Test

```bash
# 1. Build one mixed offer and inspect what the validator derives, before
#    involving the node at all:
bun run packages/tests/grand-e2e/triage-mixed-offer.ts
```

The script builds a shielded-give/unshielded-want offer with the same code
path the suite uses, then runs `validateZswapOffer` locally and prints
`gives` / `wants` / `code`.

**Verdict:**

| Observation | Conclusion |
|---|---|
| `wants` is empty **and** the tx genuinely has an unshielded output | **product bug** in `deriveLegs` — unshielded want legs not derived |
| `wants` is empty **and** the tx has no unshielded output | **test bug** — `initSwap`/`signRecipe` path built the wrong tx |
| `wants` populated, offer valid | not reproducible standalone; re-run p3 and capture the failing blob |

Cross-check the same offer through the API for the authoritative verdict:

```bash
curl -s -X POST http://127.0.0.1:9999/v1/offers \
  -H 'content-type: application/json' -d "{\"offer\":\"$(cat /tmp/mixed-offer.bech32)\"}" | jq .
```

---

## 3. `TOO_LARGE` is unreachable over HTTP — **ROOT CAUSE KNOWN**

Oversized submits answer **`413 BAD_REQUEST`**, never the `TOO_LARGE` the
validator defines.

**Mechanism (verified by inspection).** `OFFER_MAX_BYTES` is 1 MiB *decoded*,
but bech32m inflates the wire form ~1.6×. So any blob large enough to trigger
`TOO_LARGE` is ≥1.6 MB of JSON body, which exceeds Fastify's **1 MiB default
`bodyLimit`** and is rejected by the HTTP layer before the handler runs.
`TOO_LARGE` is therefore reachable **only** on the Celestia ingestion path
(raw bytes, no HTTP), never through `POST /v1/offers`.

### Test

```bash
# Oversized submit → observe which layer answers
bun -e '
const big = "swapoffer1" + "q".repeat(1_800_000);
const r = await fetch("http://127.0.0.1:9999/v1/offers", {
  method: "POST", headers: {"content-type":"application/json"},
  body: JSON.stringify({ offer: big }),
});
console.log(r.status, JSON.stringify(await r.json()).slice(0, 200));'
```

**Current:** `413 {"error":"BAD_REQUEST",...}`.

**Decide one of:**
- raise Fastify's `bodyLimit` above `OFFER_MAX_BYTES × 1.6` so the validator
  owns the verdict and emits `TOO_LARGE` (keeps the documented contract), **or**
- accept 413 as the HTTP-layer answer and document it, updating the suite
  assertion in `phases/p4-adversarial.ts` to expect `413` for oversized bodies.

Either is defensible; today's state is that the documented code cannot fire.

---

## 4. Rate limit did not answer `429` — **NEEDS TRIAGE**

`api.ts` registers `@fastify/rate-limit` with `max: 60, timeWindow: "1 minute"`
for every route except the two health endpoints, but a 70-request burst did not
produce a `429`.

### Test

```bash
bun -e '
let codes = {};
for (let i = 0; i < 80; i++) {
  const r = await fetch("http://127.0.0.1:9999/v1/offers?limit=1");
  codes[r.status] = (codes[r.status] ?? 0) + 1;
}
console.log(codes);'
```

**Pass:** at least one `429`. **Fail:** all `200` — then check whether the
plugin is scoped to the router's encapsulation context (a Fastify plugin
registered inside a sub-router applies only within it) and whether the runtime
registers its own instance that shadows it.

> Suite note: run 9 ran this *after* a long quiet period, so the window may
> legitimately have been empty. This procedure removes that ambiguity by
> bursting from cold.

---

## 5. `known-tokens` does not auto-register offer colors — **ROOT CAUSE KNOWN: docs are wrong, not the code**

The suite asserted that indexing an offer registers its token colors.
It does not — **deliberately**. `state-machine.ts` carries an explicit note:

> *token colors are deliberately NOT auto-registered here … a color appearing
> in an offer says nothing about its name and unshielded legs are typed wrong
> by construction. Unverified names in a table clients read to label trades is
> exactly the kind of fabricated data a financial UI must not carry.*

That reasoning is sound. But **`API.md:372` still claims the opposite**:

> *"New token colors are auto-registered when a valid offer containing them is
> indexed."*

So this is a **documentation bug plus a test bug**, not a product bug.

### Test

```bash
# after any offer has been indexed:
curl -s http://127.0.0.1:9999/v1/known-tokens | jq -r '.[].token_color'
```

**Expected (correct) behaviour:** only `NIGHT` (all-zero color) plus anything
registered deliberately via `POST /v1/known-tokens`. Offer colors absent.

### Actions
1. Fix `API.md:372` to state that colors are **not** auto-registered and why.
2. Fix the suite assertion in `phases/p2-api.ts` to assert absence.

---

## 6. `/v1/quote` shape assertion failed — **BLOCKED on #5 (likely the same cause)**

Almost certainly a cascade: because colors are never auto-registered (#5), the
suite's `TA`/`TB` are unknown to `known_tokens`, and on pre-merge code the
endpoint answered `404 UNKNOWN_TOKEN`.

**Main has since changed this contract** — unknown colors now quote at a
neutral `$1` (1:1 for two unknowns), loudly logged, deliberately *not*
persisted to `token_prices`.

### Test

```bash
# two unknown colors → expect a 1:1 $1 fallback, NOT a 404
curl -s "http://127.0.0.1:9999/v1/quote?from_token=$(printf 'aa%.0s' {1..32})&to_token=$(printf 'bb%.0s' {1..32})&from_amount=1000000" | jq .
# and confirm the fallback was NOT persisted:
psql -h 127.0.0.1 -U postgres -d postgres -c \
  "SELECT count(*) FROM token_prices WHERE token_color LIKE 'aa%' OR token_color LIKE 'bb%'"
```

**Pass:** `200`, `market_rate` present, `implied_rate` ≈ 1.0, and **zero**
`token_prices` rows written (a squatted `$1` row is what the change explicitly
set out to avoid). Suite assertion in `p2-api.ts` must be rewritten to this
contract — it currently asserts the removed `404 UNKNOWN_TOKEN`.

---

## 7. Batcher settlement ceiling — **FIX OPEN (PR #23)**

Every settlement, cancel and dust-balanced transfer serialized through one
worker (~25 s/tx, ~2.4 tx/min).

### Test

```bash
# with the fix, launch with a cap and read the startup line:
BATCHER_MAX_SLOTS_PER_WALLET=5 bun run dev
grep -a "worker slots" <stack log>
```

**Pass:** `Wallet 1/1: worker slots: 5 (5 UTXOs, cost=1/tx, cap=5)`
**Fail (pre-fix):** `worker slots: 1 (5 UTXOs, cost=1/tx, cap=1)`

Slots are `min(floor(dustUtxos / costPerTx), cap)`, so beyond the wallet's
existing UTXO count you must split its NIGHT into more dust-registered UTXOs
(`registerNightForDust` registers every unregistered NIGHT UTXO — split first,
then register). Expect the **proof server** to become the next ceiling; the
suite already caps proving concurrency at 3 for that reason.

---

## 8. State-transition errors are invisible — **ROOT CAUSE KNOWN**

The runtime routes STF errors to telemetry only (`process-blocks.ts` STEP 5),
so a clean SQL failure surfaced as an unexplained process exit. This is
**why issue 1 took hours instead of minutes** to localise.

### Test

```bash
# Patch the catch to console.error and confirm the error text appears:
grep -rn "log.remote" node_modules/@effectstream/runtime/src/process-blocks.ts
```

Then trigger any STF failure and confirm it is now visible. Note the patch is
wiped by `bun install`, so the durable fix belongs upstream.

**Recommendation:** surface STF errors at least at `console.error` in
development. Cheap, and it converts this whole class of bug from
"stack died, no idea why" into a one-line diagnosis.

---

## 9. API.md documents error codes that are never emitted — **ROOT CAUSE KNOWN**

`API.md`'s `POST /v1/offers` error table lists **`INVALID_FORMAT`** and
**`INVALID_PROOF`**. Neither exists in `OfferRejectCode`. The real codes are
`BAD_ENCODING`, `BAD_DESERIALIZE`, `TOO_LARGE`, `WRONG_TX_VARIANT`,
`NO_SPENDABLE_INPUT`, `NOT_A_SWAP`, `PROOF_INVALID`, `SIGNATURE_INVALID`,
`NULLIFIER_SPENT`, `UTXO_SPENT`/`UTXO_UNKNOWN`/`UTXO_NOT_LIVE`, `ROOT_UNKNOWN`,
`ROOT_UNREADABLE`, `DUPLICATE`/`DUPLICATE_OFFER`.

### Test

```bash
# every documented code should be producible; these two are not:
grep -n "INVALID_FORMAT\|INVALID_PROOF" packages/validator/types.ts   # → no matches
```

**Action:** correct the table in `API.md` to the codes the validator actually
emits. A client written against the current doc would branch on strings that
can never arrive.

---

## 10. Suite assertions stale vs merged main — **NEEDS FIX (test-side)**

Both in `phases/p2-api.ts`:
- asserts `quote with unknown token → 404 UNKNOWN_TOKEN` (contract changed, #6)
- asserts `known-tokens` auto-registration (never true, #5)

Will fail against merged main until rewritten.

---

## 11. No green end-to-end run; `baseline.json` empty — **BLOCKED on #1, #2**

The Definition of Done is two consecutive green runs plus a calibrated
baseline. No run has completed end-to-end yet: runs 1–8 died in setup for
operational reasons, run 9 reached 53 passes before the NUL crash, run 10 was
superseded, run 11 is in flight with both fixes.

### Test

```bash
GRAND_OFFERS=250 bun run test:grand      # calibration scale
GRAND_OFFERS=500 bun run test:grand      # full scale, per the handoff
```

**Pass:** exit 0, `SCORECARD.md` all-green, `out/metrics.json` written. Then
commit those values into `baseline.json` so subsequent runs enforce at ×1.2.

---

## Results log

| # | Issue | Severity | Status | Verdict | Date |
|---|---|---|---|---|---|
| 1 | `0x00` crashes the node | Critical | FIX OPEN (#22) | product bug — confirmed live | |
| 2 | Mixed offer `NOT_A_SWAP` | High? | NEEDS TRIAGE | | |
| 3 | `TOO_LARGE` unreachable (413) | Medium | ROOT CAUSE KNOWN | contract gap — decide | |
| 4 | Rate limit no `429` | Medium | NEEDS TRIAGE | | |
| 5 | `known-tokens` auto-register | Medium | ROOT CAUSE KNOWN | docs + test bug | |
| 6 | `/v1/quote` shape | Medium | BLOCKED on #5 | likely test bug | |
| 7 | Batcher ceiling | Medium | FIX OPEN (#23) | verified 5× live | |
| 8 | STF errors invisible | Medium | ROOT CAUSE KNOWN | upstream ergonomics | |
| 9 | API.md phantom error codes | Low | ROOT CAUSE KNOWN | docs bug | |
| 10 | Stale suite assertions | Low | NEEDS FIX | test bug | |
| 11 | No green run / empty baseline | — | BLOCKED | | |
