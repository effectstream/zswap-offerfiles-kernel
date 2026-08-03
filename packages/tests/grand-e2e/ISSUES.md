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

## 1. Rate limiting answers `500 INTERNAL` instead of `429 RATE_LIMITED`

**Verdict: PRODUCT BUG. Severity: high** — worse than the "limit never fires"
we first suspected. The limiter *works*; the response is just wrong, and
`500 INTERNAL` tells a client "server is broken, alarm" instead of
"back off and retry", so no correct client can throttle itself.

### Reproduce (0.2 s)

```bash
bun -e '
const codes = {};
for (let i = 0; i < 90; i++) {
  const r = await fetch("http://127.0.0.1:9999/v1/offers?limit=1");
  codes[r.status] = (codes[r.status] ?? 0) + 1;
}
console.log(codes);
const r = await fetch("http://127.0.0.1:9999/v1/offers?limit=1");
console.log(r.status, await r.text());
console.log("remaining:", r.headers.get("x-ratelimit-remaining"));'
```

### Observed

```
90 sequential requests in 0.2s: {"200":56,"500":34}
next request: 500 {"error":"INTERNAL","reason":"Unknown error"}
headers: {"limit":"60","remaining":"0","reset":"24"}
```

The `x-ratelimit-*` headers are correct — counting and blocking both work.
Only the status and body are wrong.

### Root cause (pinned)

`@fastify/rate-limit@10.3.0` line 333 throws **whatever the
`errorResponseBuilder` returns**:

```js
throw params.errorResponseBuilder(req, respCtx)
```

Our builder in `packages/node/api.ts` returns a plain object with **no
`statusCode`**:

```js
errorResponseBuilder: () => ({ error: "RATE_LIMITED", reason: "Too many requests…" })
```

So the thrown value reaches our `setErrorHandler`, whose 4xx branch tests
`Number(error?.statusCode)` — `undefined` — and falls through to the
`500 INTERNAL` branch. (The plugin's *default* builder sets
`err.statusCode` at line 33; ours bypasses that.)

### Fix

Add the status to the object the builder returns:

```js
errorResponseBuilder: () => ({ statusCode: 429, error: "RATE_LIMITED", reason: "…" })
```

Then re-run the reproduction: expect `{"200":60,"429":30}`.

---

## 2. `TOO_LARGE` is unreachable over HTTP

**Verdict: PRODUCT/CONTRACT GAP. Severity: medium.** The documented rejection
code cannot be produced through the API.

### Reproduce

```bash
bun -e '
const big = "swapoffer1" + "q".repeat(1_800_000);
const r = await fetch("http://127.0.0.1:9999/v1/offers", {
  method: "POST", headers: {"content-type":"application/json"},
  body: JSON.stringify({ offer: big }) });
console.log("oversized:", r.status, await r.text());'
```

### Observed

```
oversized (1.8MB): 413 {"error":"BAD_REQUEST","reason":"Request body is too large"}
small control:     400 {"error":"BAD_ENCODING","reason":"bech32m decode failed…"}
```

The control proves the validator *is* reached for normal-sized bodies — only
oversized ones are intercepted earlier.

### Root cause

`OFFER_MAX_BYTES` is 1 MiB **decoded**, but bech32m inflates the wire form
~1.6×. Any blob large enough to trigger `TOO_LARGE` is therefore ≥1.6 MB of
JSON body, which exceeds Fastify's **1 MiB default `bodyLimit`** and is
rejected by the HTTP layer before the handler runs. `TOO_LARGE` remains
reachable on the Celestia ingestion path (raw bytes, no HTTP).

### Fix — pick one

- Raise Fastify's `bodyLimit` above `OFFER_MAX_BYTES × 1.6` so the validator
  owns the verdict and the documented code can fire; **or**
- accept 413 as the HTTP-layer answer, document it in `API.md`, and update
  `phases/p4-adversarial.ts` to expect `413` for oversized bodies.

---

## 3. `API.md` documents two error codes that cannot exist

**Verdict: DOCS BUG. Severity: medium** — a client written against the doc
branches on strings that never arrive.

### Reproduce

```bash
grep -n "INVALID_FORMAT\|INVALID_PROOF" packages/validator/types.ts   # no matches
```

### Observed

| Source | Codes |
|---|---|
| `API.md` submit table | `INVALID_FORMAT`, `INVALID_PROOF`, `NULLIFIER_SPENT`, `UTXO_NOT_LIVE`, `ROOT_UNKNOWN`, `DUPLICATE_OFFER` |
| `OfferRejectCode` (actual) | `BAD_ENCODING`, `BAD_DESERIALIZE`, `TOO_LARGE`, `WRONG_TX_VARIANT`, `NO_SPENDABLE_INPUT`, `NOT_A_SWAP`, `UNKNOWN_TOKEN`, `PROOF_INVALID`, `SIGNATURE_INVALID`, `NULLIFIER_SPENT`, `UTXO_SPENT`, `UTXO_UNKNOWN`, `ROOT_UNKNOWN`, `ROOT_UNREADABLE`, `DUPLICATE` |

`INVALID_FORMAT` and `INVALID_PROOF` exist nowhere in the codebase. The real
names are `BAD_ENCODING` and `PROOF_INVALID`/`SIGNATURE_INVALID`.

### Fix

Correct the `POST /v1/offers` table in `API.md` to the emitted codes, and add
the `TOO_LARGE` / 413 outcome from issue 2.

---

## 4. `API.md` promises token auto-registration that was deliberately removed

**Verdict: DOCS BUG + TEST BUG. Severity: medium.**

`API.md:372` states:

> *"New token colors are auto-registered when a valid offer containing them is indexed."*

`packages/node/state-machine.ts` deliberately does the opposite, and the
reasoning is sound:

> *token colors are deliberately NOT auto-registered here … a color appearing
> in an offer says nothing about its name and unshielded legs are typed wrong
> by construction. Unverified names in a table clients read to label trades is
> exactly the kind of fabricated data a financial UI must not carry.*

### Reproduce

```bash
curl -s http://127.0.0.1:9999/v1/known-tokens | jq -r '.[].token_color'
```

**Observed on a fresh stack:** only the all-zero `NIGHT` row.
**Confirm the negative** once offers are indexed (any full suite run reaches
this in p2): the offers' colors must still be absent.

### Fix

1. `API.md:372` — state that colors are **not** auto-registered, and why.
2. `phases/p2-api.ts` — assert absence instead of presence.

---

## 5. Suite asserts the removed `404 UNKNOWN_TOKEN` quote contract

**Verdict: TEST BUG. Severity: low.** The merged `$1` fallback behaves
correctly; only the suite's assertion is stale.

### Reproduce

```bash
A=$(printf 'aa%.0s' {1..32}); B=$(printf 'bb%.0s' {1..32})
curl -s "http://127.0.0.1:9999/v1/quote?from_token=$A&to_token=$B&from_amount=1000000"
psql -h 127.0.0.1 -U postgres -d postgres -t -A \
  -c "SELECT count(*) FROM token_prices WHERE token_color LIKE 'aa%' OR token_color LIKE 'bb%'"
```

### Observed

```json
{"market_rate":1,"suggested_to_amount":"975000","to_amount":"975000","implied_rate":0.975,"discount":0.025…}
```
```
token_prices rows written: 0
```

Both intended properties hold: two unknowns quote 1:1 at `$1`, and the
fallback is **not** persisted — no squatted `$1` row, exactly as the change
intended.

### Fix

Rewrite the `p2-api.ts` assertion to this contract (200, `market_rate` present,
`implied_rate` ≈ 1 − discount, **zero** `token_prices` rows).

---

## 6. Mixed offers: the unshielded want output is silently never created

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

### Fix (suite side)

Until that is settled, either drop mixed layers from the offer mix or assert
the current limitation explicitly. Do **not** leave a silent-drop path in
`buildOffer` — its `try/catch` fallback cannot help, since the failing path
throws nothing.

---

## 7. State-transition errors are invisible

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

## 8. No green end-to-end run; `baseline.json` still empty

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

| # | Issue | Verdict | Severity | Fix owner |
|---|---|---|---|---|
| 1 | Rate limit → `500` not `429` | product bug (reproduced, root-caused) | High | one-line: `statusCode: 429` in builder |
| 2 | `TOO_LARGE` unreachable (413) | contract gap (reproduced) | Medium | raise `bodyLimit` or document 413 |
| 3 | Phantom error codes in `API.md` | docs bug (reproduced) | Medium | correct the table |
| 4 | Auto-registration promised in docs | docs + test bug (code-confirmed) | Medium | fix doc + assertion |
| 5 | Stale quote assertion | test bug (reproduced) | Low | rewrite assertion |
| 6 | Mixed-offer unshielded want dropped | test bug + upstream question | Medium | suite fix; raise with SDK |
| 7 | STF errors invisible | product ergonomics | Medium | upstream |
| 8 | No green run / empty baseline | in progress | — | next run |

**Fixed and removed from this file:** the `0x00` node crash (PR #22) and the
single-worker batcher ceiling (PR #23).
