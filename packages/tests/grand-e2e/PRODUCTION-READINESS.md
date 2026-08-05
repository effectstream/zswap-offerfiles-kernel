# Production-readiness plan — what the grand e2e suite still does not prove

Goal: before this indexer serves real money, six properties must be *tested*, not
argued:

| | Property | Status today |
|---|---|---|
| a | Bad data cannot get into the history | **partial** — the ladder is unit-tested, but 6 of its 14 reject codes never fire against a real gate, and history has no integrity audit at all |
| b | Bad transactions don't reach users | **weak** — nothing re-validates what the API actually serves, and `expiresAt` is already in the past at ingestion on a quiet chain (§2.6) |
| c | All data is correctly logged as real sales | **broken on the unshielded path** — and the suite currently asserts the break as correct behaviour |
| d | History and pricing is correct | **broken** — `/v1/pairs.last_price` is inverted for half of all trades; the 24 h window still mixes clocks |
| e | Duplicate zswaps allowed, accepting one disables the others | **partial** — only the N=2, single-input, same-door case |
| f | Works for shielded *and* unshielded | **no** — cancels, chaos, TTL sweep and the liveness gate are shielded-only |

Six product defects are named in §2. Every one of them gets a **failing test
first** (PR-A), then a fix in its own PR, then the same test green.

---

## 0. What was read

- **MIP-0005** (`@effectstream/mip-zswap-offer/mip5`) — `OfferFiles`: bech32m
  `swapoffer1…` over raw `Transaction` bytes; canonical form is the **raw
  bytes**; `offerId` = lowercase hex sha256 **of the bytes, never the string**.
- **MIP-0006** (`…/mip6`) — `P2pAtomicSwaps`: legs are **derived, never trusted
  from the maker** (`deriveTokenLegs`); the **two-sided rule** (≥1 give and ≥1
  want); layers stay separate (same color on two layers is two legs); the DA
  blob **is** the raw MIP-0005 bytes, no envelope; `earliestIntentTtl`;
  `OffchainOfferPayload` presence rules (lists MAY omit `offerBech32`,
  single-offer responses MUST include it); `cancelled` is explicitly a
  best-effort refinement of `consumed`.
- Implementation: [validate.ts](../../validator/validate.ts),
  [derive.ts](../../validator/derive.ts),
  [state-machine.ts](../../node/state-machine.ts),
  [api.ts](../../node/api.ts),
  [queries.app.ts](../../database/sql/queries.app.ts),
  [000-init.sql](../../database/migrations/000-init.sql).
- Suite: all 8 phases, 143 checks; `ledger.ts`, `adversary.ts`, `dump.ts`.
- Installed primitive grammars under
  `@effectstream/sm/primitives/src/midnight-*/` — to establish what the STM
  *could* see today without a framework change.

---

## 1. How this lands: one base PR, then one PR per fix

### 1.0 Implementation status

**PR-A is implemented** on `test/production-readiness-base`. What landed, and
what did not:

| Test | Status |
|---|---|
| T-A1 Celestia door asserted by code | ✅ `p4` + `celestiaFixtures()`, incl. crypto-tamper and aged-root families |
| T-A2 `NOT_A_SWAP` at both doors | ✅ `buildOneSidedOffer()`; skips with a loud note if the SDK stops dropping the leg |
| T-A2 `NO_SPENDABLE_INPUT` / `UNKNOWN_TOKEN` / `ROOT_UNREADABLE` | ⛔ not built — see §1.0.1 |
| T-A3 cross-layer | ⚠️ **gap CONFIRMED reachable** by `probe-cross-layer.ts`; e2e fixture still to build (§2.4) |
| T-A4 history referential integrity | ✅ `p7b`, 5 SQL assertions |
| T-A5 every stored blob re-validates (proofs included) | ✅ `p7b` deep pass, `GRAND_DEEP_AUDIT` |
| T-A6 stored legs / spends / markers == derived | ✅ `p7b`, same pass |
| T-B1…B4 what the API serves | ✅ new `p8-served` phase — **found §2.6** |
| T-C1 unshielded cancels read `cancelled` | ✅ **red** RED-1a/b/c, RED-2 |
| T-C2 Σ volume == Σ settled | ✅ **red** RED-5, RED-6 |
| T-C3 expiries are never trades | ✅ `p7b` |
| T-C4 maker self-fill | ✅ `p3` |
| T-D1 chain-clock 24 h window | ✅ **red** `trade-data.test.ts` (`test.failing`) |
| T-D2 price orientation + inversion | ✅ `p2`, anchored to a known fill |
| T-D3 `/v1/pairs` vs `/v1/chart/stats` | ✅ `p7b` (unregistered — see §1.2) + **red** in `fill-vs-cancel.test.ts` |
| T-D4 `trade_count` + chain ordering | ✅ `p7b` |
| T-D5 multi-leg | ✅ **red** `multileg-pairs.test.ts` — one settlement, four prices (§2.5) |
| T-E1 N-way competition | ✅ `p3b`, 3 competitors per layer |
| T-E2 partial overlap between live offers | ⛔ deferred — needs denomination-controlled funding |
| T-E3 cross-door competition | ✅ `p3b`, one competitor via `blob.Submit` |
| T-E4 loser arrives after the winner settled | ✅ `p3b`, both doors, by code |
| T-E5 two takers, one coin | ⛔ deferred |
| T-E6 same-block byte-identical duplicates | ✅ `p4` |
| T-F1 cancel shapes, unshielded | ✅ **red** RED-1a/b/c — 3 of the 4 shapes |
| T-F2 `UTXO_NOT_LIVE` | ✅ via T-E4's unshielded arm |
| T-F3 unshielded `expiresAt` + unreachable fallback | ✅ `p3` |
| T-F4 chaos batch mixed-layer | ✅ `p5` |
| T-F5 layer symmetry | ✅ `p7b` + scorecard split |

#### 1.0.1 The two "unbuildable" fixtures — RESOLVED, and both gaps confirmed

Both were blocked on the same wrong assumption: that a wallet is the only way
to make a transaction. It is not — **balancing is itself a merge**, and the
ledger exposes `Transaction.merge()` directly. `probe-cross-layer.ts` settles
both questions in seconds, with no stack, using real offers from a completed
run. See §2.4 and §2.5 for the measurements.

- **Cross-layer (T-A3).** The merge succeeds, the result is two-sided across
  both layers, and our validator **accepts it through the full ladder including
  `wellFormed`**. The gap is real and reachable; the e2e fixture is now a
  matter of building it, not of discovering whether it can exist.
- **Multi-leg (T-D5).** The same merged transaction has 2 gives × 2 wants and
  would register as **four** trades at four different prices. The fixture is
  also unblocked independently: `mintShielded(deployed, sepByte, …)`
  parameterizes the color by domain separator on the already-deployed contract,
  so a third shielded color is one `TOKEN_SEPS` entry plus a funding grant — no
  new contract needed.
- **`NO_SPENDABLE_INPUT` / `UNKNOWN_TOKEN` (T-A2).** Still unbuilt. The SDK will not build an
  input-free swap, and every token tag it can emit is
  `shielded`/`unshielded`/`dust`. Both stay covered at validator-unit level
  against transaction doubles. If they prove unreachable through any real
  wallet, that is a finding in itself — a fail-closed branch no real input can
  reach is either dead code or a defence against a future wire format.

The remaining deferrals, T-E2 and T-E5, are ordinary ones: both need new wallet plumbing
(denomination-controlled funding; concurrent taker settlement) rather than an
unanswered question.

### 1.1 PR sequence

| PR | Contents | Product code touched |
|---|---|---|
| **A** | **Base test suite.** Every test in §3, the `KNOWN_RED` registry, the new helpers, the new `p8-served` phase. Ends with a full run whose scorecard lists each defect as a recorded red. | **none** |
| **B** | Unshielded fill-vs-cancel (§2.1) | validator, STM, schema, `cancelledPredicate` |
| **C** | `pair_stats.last_price` inversion (§2.2) | `upsertPairStatsByOfferId` |
| **D** | 24 h stats window clock (§2.3) | `getPairStats24h`, `trade-data.ts` |
| **E** | Cross-layer rule (§2.4) | validator ladder, new reject code |
| **F** | Multi-leg offers (§2.5) | validator ladder **or** the market queries — needs a ruling |
| **G** | `expiresAt` already-expired on a quiet chain (§2.6) | `state-machine.ts` expiry derivation |
| **H** | Sweep: reds that turn out to be unreachable-code findings; delete `KNOWN_RED` | docs |

PR-A is deliberately product-inert. Its job is to make every defect **visible
and reproducible** before anyone touches the code that causes it, so each later
PR has a specific red to point at and a specific green to earn.

### 1.2 Red-green discipline — the `KNOWN_RED` registry

A test that fails on merge is worthless if it just turns the suite red and gets
ignored. So PR-A adds an explicit expected-failure registry, keyed on the exact
`phase ▸ name` string `check()` already builds:

```ts
// packages/tests/grand-e2e/known-red.ts
export interface KnownRed { id: string; pr: string; why: string }

/** Checks that MUST fail until their fix PR lands. Emptied by PR-G. */
export const KNOWN_RED: Record<string, KnownRed> = {
  "p3-lifecycle ▸ unshielded walk-away reads cancelled": {
    id: "RED-1", pr: "PR-B", why: "unshielded spends are not tx-grouped (§2.1)",
  },
  "p7b-audit ▸ /v1/pairs last_price agrees with /v1/chart/stats": {
    id: "RED-2", pr: "PR-C", why: "last_price is want/give, not quote/base (§2.2)",
  },
  // …one entry per known defect
};
```

`check()` in [lib/util.ts](lib/util.ts) grows one branch:

```ts
const red = KNOWN_RED[full];
if (red) {
  if (ok) {
    // XPASS: the fix landed but the registry was not updated. This FAILS the
    // run — it is the only thing that forces a fix PR to close its own entry.
    results.push({ phase: currentPhase, name, ok: false, ms,
      detail: `XPASS ${red.id}: now passes — delete the KNOWN_RED entry (${red.pr})` });
    console.log(`[XPASS] ${full}  ← ${red.id} fixed; remove from KNOWN_RED`);
    return true;
  }
  results.push({ phase: currentPhase, name, ok: true, ms,
    detail: `KNOWN RED ${red.id} (${red.pr}) — ${red.why}${extra ? "; " + extra : ""}` });
  console.log(`[RED ] ${full}  ← ${red.id} expected-fail, ${red.pr}`);
  return false;                       // callers' control flow is unchanged
}
```

Three properties this buys:

1. **PR-A merges green.** Reds are recorded, not fatal, so the suite stays a
   usable gate for everything else while the fixes are in flight.
2. **A fix PR cannot forget its paperwork.** The moment the defect is fixed the
   check XPASSes and the run goes red until the entry is deleted. That deletion
   *is* the proof the fix worked, in the diff.
3. **The registry is the punch list.** `SCORECARD.md` gets a `## Known red`
   section — id, PR, reason, and the actual observed failure detail — so the
   remaining work is legible from a run artifact.

The masking risk is real and bounded: keys are exact full names, so a *different*
failure in the same phase still fails the run. Each fix PR's checklist:

1. run the suite, screenshot the `[RED ]` line for its id;
2. fix the product code;
3. re-run — expect `[XPASS]`;
4. delete the `KNOWN_RED` entry; re-run — expect `[PASS]`.

Steps 1 and 3 are what the request means by *see it fail first*, and step 3 is
what proves the test, not just the fix.

---

## 2. Product defects — each gets a red in PR-A

### 2.1 Unshielded fill-vs-cancel — a market-data integrity hole → **PR-B**

**Today.** `cancelledPredicate`
([queries.app.ts:84](../../database/sql/queries.app.ts)) classifies using
nullifier tx-grouping plus shielded output commitments as fill markers.
Unshielded spends have neither: `midnight-unshielded-spend`
([state-machine.ts:233](../../node/state-machine.ts)) reads only
`(owner, intentHash, outputIndex)` and `offer_file_unshielded_spends`
([000-init.sql:71](../../database/migrations/000-init.sql)) has no `tx_hash`
column. So **every** consumption of an unshielded-only offer classifies
`consumed`.

**Impact.** A maker publishes an unshielded offer, then spends their own UTXO on
themselves. The offer is recorded as a completed sale: it enters
`/v1/chart/history`, adds to `volume_base`/`volume_quote`, moves `last_price`,
and increments `pair_stats.trade_count`. Cost of fabricating arbitrary volume on
any unshielded pair, at a price and size of the maker's choosing: one
self-transfer. The suite currently asserts this twice as intended behaviour —
[p3-lifecycle.ts:167](phases/p3-lifecycle.ts) and
[p3b-competing.ts:196](phases/p3b-competing.ts) — and `ledger.fillLedger()`
([ledger.ts:132](ledger.ts)) *models* the inflation so the audit stays green.

**Fixable now, no framework change.** Verified against the installed grammars
(`primitives/src/midnight-unshielded-{spend,create}/…-grammar.ts`): **both**
payloads already carry `txHash`, plus `value` and `tokenType`. The state machine
discards them. So the shielded rule ports over exactly.

**Fix shape (PR-B):**

1. `packages/database/migrations/000-init.sql` (edited in place — new system, no
   migration): new permanent table mirroring `nullifiers`:
   ```sql
   CREATE TABLE unshielded_spends (
       owner       TEXT    NOT NULL,
       intent_hash TEXT    NOT NULL,
       output_no   INTEGER NOT NULL,
       tx_hash     TEXT,
       height      BIGINT  NOT NULL,
       PRIMARY KEY (owner, intent_hash, output_no)
   );
   ```
   plus `tx_hash TEXT` on `offer_file_unshielded_spends{,_history}`.
   Today the `created_unshielded` row is DELETEd on spend and nothing survives,
   which is why branches 1 and 2 can never fire for unshielded offers.
2. `state-machine.ts` `midnight-unshielded-spend`: insert into
   `unshielded_spends` with `bytesOrStringToHex(payload.txHash)` before the
   existing `deleteCreatedUnshielded`.
3. `derive.ts`: new `collectUnshieldedOutputs(tx)` mirroring
   `collectOutputCommitments` — the offer's own unshielded outputs
   `(recipient, tokenType, value)`, read from
   `intent.{guaranteed,fallible}UnshieldedOffer.outputs`. These are the
   unshielded **fill markers**: a settling tx creates exactly these UTXOs.
4. `celestia-zswap`: persist them alongside the commitment markers.
5. `cancelledPredicate`: add the three unshielded branches, `OR`-ed with the
   existing shielded ones —
   - partial: an `offer_file_unshielded_spends_history` row with no matching
     `unshielded_spends` row;
   - split: `COUNT(DISTINCT tx_hash) > 1` over the offer's spends;
   - missing markers: all spends in one tx, but that tx did not create every one
     of the offer's declared unshielded outputs (join `created_unshielded`
     history on the same `tx_hash` + `(owner, tokenType, value)`).

**Red in PR-A:** T-C1, T-C2, T-F1, and the `uu` arms of T-E1/T-E2.

### 2.2 `pair_stats.last_price` is inverted for half of all trades → **PR-C**

*(found while writing T-D3 — not previously reported)*

[queries.app.ts:462](../../database/sql/queries.app.ts):

```sql
SELECT LEAST(g.token_color, w.token_color)      AS base_color,
       GREATEST(g.token_color, w.token_color)   AS quote_color,
       w.amount::numeric / NULLIF(g.amount::numeric, 0)   AS last_price
```

`base_color`/`quote_color` are assigned by **lexical order of the hex color**,
but `last_price` is computed as **want ÷ give** with no reference to which of
them ended up as base. So:

| the offer | `last_price` means |
|---|---|
| gives the lexically-lesser color (= base), wants the greater (= quote) | quote per base ✔ |
| gives the greater (= quote), wants the lesser (= base) | **base per quote** ✘ |

Every other price path in the system is quote-per-base and normalises explicitly
— `getPairStats24h`
(`CASE WHEN g.token_color = :base THEN w/g ELSE g/w END`,
[queries.app.ts:314](../../database/sql/queries.app.ts)) and `toFill()`
([trade-data.ts:21](../../node/trade-data.ts)). Only this one does not.

**Consequences.** `/v1/pairs.last_price` flips meaning with the direction of the
most recent trade, so on any two-sided book the pair list's price column
oscillates between `p` and `1/p`. It disagrees with `/v1/chart/stats.last` for
the same pair by a factor of p². Nothing catches it: `fill-vs-cancel.test.ts`
exercises `last_traded_at` and the cancelled-offer filter, never the value; and
the suite never compares the two routes.

**Fix (PR-C):** normalise, matching `getPairStats24h`:

```sql
CASE WHEN g.token_color = LEAST(g.token_color, w.token_color)
     THEN w.amount::numeric / NULLIF(g.amount::numeric, 0)
     ELSE g.amount::numeric / NULLIF(w.amount::numeric, 0) END
```

**Red in PR-A:** T-D2 (direction-dependence, one direction fails) and T-D3
(route disagreement).

### 2.3 The 24 h stats window still mixes clocks → **PR-D**

`getPairStats24h` ([queries.app.ts:311](../../database/sql/queries.app.ts))
bounds its window with `NOW() - INTERVAL '24 hours'` while comparing against
`h.archived_at`, which — since the chain-time fix — is the **L2 block
timestamp**. Same defect class we just closed one layer down, and closing it is
what made this one reachable: any node whose chain clock is not wall clock (a
replica catching up, a replay, a devnet anchored in the past, an NTP anchor
pinned by `GRAND_NTP_START_TIME`) sees `fills_24h = 0` → volume 0, `high`/`low`
collapse onto `last`, `change24` = 0 — while `/v1/chart/history` still lists
every fill. The API contradicts itself.

**Fix (PR-D):** parameterise the cutoff and derive it from the same clock as the
data — `effectstream_blocks.ms_timestamp` at the tip, the value
[api.ts:639](../../node/api.ts) already fetches for the root gate.

**Red in PR-A:** T-D1 (unit).

### 2.4 Cross-layer offers are unenforced → **PR-E** — **CONFIRMED REACHABLE**

**No longer speculative.** `probe-cross-layer.ts` merges a real shielded offer
with a real unshielded one from a completed run via the ledger's own
`Transaction.merge()`, and the result:

```
  merged: gives UNSHIELDED:1454bec2=1317 SHIELDED:3b2bc2ea=1424
          wants UNSHIELDED:c7dfbc08=1983 SHIELDED:3dc32e7e=1826
  two-sided: true   layers: UNSHIELDED + SHIELDED
  our validator (FULL ladder, wellFormed included): ACCEPTED
```

The merge preserves proofs and signatures, so **crypto passes** — the ladder has
no structural objection at any step. Only liveness stops these particular bytes,
and only because their inputs were already spent by the run that produced them.
A maker holding two fresh halves publishes this and it is indexed.

The wallet was never the obstacle: balancing is itself a merge, so the mechanism
is ordinary and available to anyone.

Recorded in [ISSUES.md](ISSUES.md) §3 and still open: nothing in the ladder
requires a give and a want to share a value layer. `NOT_A_SWAP` fires today only
because `wallet-sdk-facade` silently drops a leg — an accident, not a rule. A
correctly-built cross-layer offer from another wallet reaches `isTwoSided()`
with a legitimate give and want and, as far as the code shows, **is indexed**.
The suite stopped building them (`Layer = "ss" | "uu"`), so this is now
untested in both directions.

**Ruling needed.** Assuming the project rule *"we do not allow mixed types
transactions"* holds: add `CROSS_LAYER` to `OfferRejectCode` and a check in
[validate.ts](../../validator/validate.ts) immediately after `isTwoSided` —
`gives.every(g => g.kind === k) && wants.every(w => w.kind === k)` for a single
`k`. If the rule is meant to be the opposite, that also has to be a test.

**Red in PR-A:** T-A3.

### 2.5 Multi-leg offers are mis-priced → **PR-F** — **CONFIRMED, and it compounds with §2.4**

**Measured on the same merged transaction.** Two gives × two wants = **four**
pair combinations, every one of which the market queries match and price
independently:

```
  pair(1454be,c7dfbc) price=1.5057  [UNSHIELDED->UNSHIELDED]
  pair(1454be,3dc32e) price=1.3865  [UNSHIELDED->SHIELDED]
  pair(3b2bc2,c7dfbc) price=1.3926  [SHIELDED->UNSHIELDED]
  pair(3b2bc2,3dc32e) price=1.2823  [SHIELDED->SHIELDED]
```

One transaction, four fabricated trades at four different prices, every leg's
volume counted twice. Two of those pairs are cross-LAYER pairs that describe no
market at all — the indexer would create `pair_stats` rows for pairings that
never traded.

**Measured, not argued** (`packages/database/multileg-pairs.test.ts`, which
seeds one 4-leg CONSUMED offer and runs the real queries):

| pair | fills | price | vol_base | vol_quote |
|---|---|---|---|---|
| A/C | 1 | **1.5057** | 1317 | 1983 |
| A/D | 1 | **1.3865** | 1317 | 1826 |
| B/C | 1 | **1.3926** | 1424 | 1983 |
| B/D | 1 | **1.2823** | 1424 | 1826 |

Four trade-history rows for one settlement; every colour's volume reported at
exactly 2x what moved when summed across pairs.

**Be precise about which half is the defect.** Classification is fine — the
offer is correctly CONSUMED and each pair correctly reports `fills=1`. Supply is
real — `open_count=1` on four pairs, and the tokens genuinely are on offer. The
fault is the step between: the offer -> pair mapping is one-to-many (gives x
wants), while every market indicator assumes one-to-one.

The volume double-count is arguable — per pair each figure is defensible, and it
doubles only if you sum across pairs, which is a convention question. **The price
is not arguable.** One transaction has one exchange rate; the API reports four,
each manufactured by ignoring the other legs. On the open side the same fan-out
advertises four executable-looking quotes, none of which a taker can execute: A/C
at 1.5057 also requires supplying D and receiving B.

The fixture is also no longer blocked. `mintShielded(deployed, sepByte, …)`
parameterizes the color by domain separator on the ALREADY-DEPLOYED contract, so
a third shielded color is one entry in `TOKEN_SEPS` plus a funding grant — no
new contract and no contract change.

MIP-0006 types `gives`/`wants` as arrays; ≥1 each is the only constraint. But
`getTradeHistory` and `getPairStats24h` join per `(offer, color)` filtered to
`(base, quote)`. An offer giving **A and B** while wanting **C** produces one
"trade" for pair (A,C) priced `C/A` and another for (B,C) priced `C/B` — both
wrong (each ignores half the consideration), and C's volume counted twice.
`upsertPairStatsByOfferId` has the same shape: its `g`/`w` subqueries are
unfiltered by color, so one 4-leg offer inserts four pair rows and four
`trade_count` increments. Nothing in the suite has ever built more than two legs.

**Ruling needed.** Either reject at ingestion (`MULTI_LEG_UNSUPPORTED`, cheapest
and matches the "one pair per offer" model the whole market layer assumes), or
price and attribute them properly (needs a defined convention for what the price
of a basket even is). Recommend rejecting.

**Red in PR-A:** T-D5.

### 2.6 `expiresAt` is already in the past when the offer is indexed → **PR-G**

*(found by p8 on the third full run — the first run where p8 had a populated
book to audit)*

**Measured.** A probe offer published by p8 and indexed at chain time
**18:34:20** was served `expiresAt = 18:23:36` — **eleven minutes before it was
ingested**. At the same moment `known_roots` held 5 rows whose newest
`last_seen_ms` was 18:13:36, and `18:13:36 + ROOT_WINDOW(600 s) = 18:23:36`
exactly. The same offer **passed** p8's settleability check.

**Cause — an asymmetry the codebase already documents, compensated for in one
place and not the other.** The ledger's `past_roots` re-inserts the *current*
root every block; our `midnight-zswap-root` primitive fires only when the root
**advances** ([state-machine.ts:333](../../node/state-machine.ts)). On a chain
with no shielded activity — the quiesce before the determinism replay, or any
quiet period in production — the newest root's `last_seen_ms` goes stale while
the chain still accepts proofs against it.

- The **ingestion gate** handles this: `isKnownRootLive` accepts a root that
  holds `MAX(height)` regardless of age (PR #28).
- The **expiry derivation** does not
  ([state-machine.ts:561-573](../../node/state-machine.ts)): it computes
  `expiresAt = earliest root's last_seen_ms + ROOT_WINDOW` from the raw column,
  with no such escape.

**Why this is more than "conservative".** The code anticipates being a floor —
*"this value is therefore a conservative FLOOR … the floor never over-promises
fillability"*. That reasoning justifies under-promising. It does not survive the
floor landing in the **past at the moment of ingestion**: a field that is always
already expired carries no information and actively misleads. A client doing the
obvious thing — filter `expiresAt > now` — discards offers that are genuinely
fillable, while `status` on the same payload says `live`. The API contradicts
itself on a single response.

**Fix (PR-G):** apply the same escape the read gate uses. If the offer's
earliest root is the current (`MAX(height)`) root, its effective last-seen is
this block, so `expiresAt = data.blockTimestamp + ROOT_WINDOW_SECONDS * 1000`.
Otherwise keep the existing derivation.

**Red in PR-A:** RED-8 (`p8-served ▸ served expiresAt is in the future for
offers reported live`).

---

## 3. The tests

Numbering is `T-<requirement><n>`. Each entry gives **what it asserts**, **how
it is implemented**, and **what it catches**.

### (a) Bad data cannot get into the history

---

#### T-A1 · The reject ladder fires at the *Celestia* door, by code

→ `actors/adversary.ts`, `phases/p4-adversarial.ts`, `lib/db2.ts`

**Why.** The Celestia namespace is permissionless — `/v1/offers` can be bypassed
entirely, which is why `celestia-zswap` calls itself "the real gate"
([state-machine.ts:362](../../node/state-machine.ts)). Today all four garbage
families ([adversary.ts:151](actors/adversary.ts)) fail at step 3 (deserialize);
the STM's own gates are exercised **only** through the API.

**How.**

1. `lib/db2.ts` — the assertion primitive that is missing today. `offer_rejections`
   is keyed `(celestia_height, code)`, and heights are L2 so they cannot be
   correlated; but per-code *totals* diff cleanly:
   ```ts
   export async function rejectionTotalsByCode(db: Client): Promise<Record<string, number>> {
     const r = await db.query(`SELECT code, SUM(count)::int AS n FROM offer_rejections GROUP BY code`);
     return Object.fromEntries(r.rows.map((x: any) => [x.code, Number(x.n)]));
   }
   ```
2. `adversary.ts` — extend `CelestiaGarbageKind` with families that reach past
   step 3, each derived from a real offer:
   - `crypto-tamper` → `OfferFiles.decode(cryptoTamperBlob(art.liveBlob))`
     → expect `PROOF_INVALID` | `SIGNATURE_INVALID`;
   - `root-unknown` → `OfferFiles.decode(foreignRootBlob())`
     → expect `ROOT_UNKNOWN`;
   - `replayed-real-blob` (exists) → expect `DUPLICATE_OFFER`.
3. p4 — per fixture:
   ```ts
   const before = await rejectionTotalsByCode(db);
   await publishCelestiaGarbage(kind, seed, src);
   await check(`celestia door rejects ${kind} as ${expected}`, () =>
     waitUntil(kind, async () => {
       const now = await rejectionTotalsByCode(db);
       return (now[expected] ?? 0) > (before[expected] ?? 0);
     }, 24, 5000));
   ```
   plus the existing "zero `offer_file` rows" assertion and a new one that the
   accounting body was scrubbed (`primitiveCount(db, CELESTIA_PRIMITIVE_NAME)`
   unchanged).

The liveness codes (`NULLIFIER_SPENT`, `UTXO_NOT_LIVE`) are **not** here: they
need a *different* offer over an already-spent coin, which only p3b can produce.
See T-E4.

**Catches.** A regression in the STM ladder's ordering or in any gate that the
API path happens to duplicate — i.e. the case where the API is correct and the
door that actually matters is not.

---

#### T-A2 · The four never-fired structural codes

→ `actors/adversary.ts`, p4

`NOT_A_SWAP`, `NO_SPENDABLE_INPUT`, `UNKNOWN_TOKEN`, `ROOT_UNREADABLE` are
declared, implemented, and have never been produced by a running node.
`NOT_A_SWAP` is the **MIP-0006 two-sided rule** — the most important semantic
rule in the spec.

**How.** Each fixture goes through the existing `preVerify()` contract
([adversary.ts:45](actors/adversary.ts)), so one that starts rejecting for the
wrong reason fails loudly at construction rather than passing a weaker
assertion.

- **`NOT_A_SWAP`** — constructible today, using the SDK defect as the tool:
  request a shielded input with an unshielded desired output and
  `wallet-sdk-facade` silently drops the output (ISSUES §3), yielding a genuine
  one-sided transaction. Add `buildOneSidedOffer(pw)` to `wallets.ts` that does
  exactly this and asserts `gives.length > 0 && wants.length === 0` before
  returning.
- **`ROOT_UNREADABLE`** — flip the pinned `0x73` marker byte of an input's
  33-byte root run in the serialized bytes (`extract-root.ts` documents the
  layout; `extract-root.test.ts` already locates it).
- **`NO_SPENDABLE_INPUT`, `UNKNOWN_TOKEN`** — probably **not** constructible via
  a real wallet: the SDK will not build an input-free swap, and every token tag
  it can emit is `shielded`/`unshielded`/`dust`.

**Expected outcome, stated up front:** some of these will prove unreachable
end-to-end. That is itself a result worth recording — a fail-closed branch no
real input can reach is either dead code or a defence against a *future* wire
format. PR-A records which, keeps unreachable ones at validator-unit level
(`validate.test.ts` already builds transaction doubles), and PR-G writes the
conclusion into `ISSUES.md`. **Do not fabricate an e2e fixture that exercises
the code path only by construction accident.**

---

#### T-A3 · Cross-layer rejection *(red until PR-E)*

→ `actors/adversary.ts`, p4 · depends on §2.4

**How.** The SDK cannot build one directly (it drops the leg). Build the two
halves separately on one maker wallet — a shielded give-only tx and an
unshielded want-only tx — and combine them with the ledger's own
`Transaction.merge()`. The merged tx has a shielded give and an unshielded want
and is a legitimate transaction, which is the entire point: the current ladder
has no reason to refuse it.

Assert `CROSS_LAYER` at both doors. Assert **specifically not** `NOT_A_SWAP` —
that answer would mean a leg got dropped again and the fixture proved nothing.
If `merge()` refuses the combination, record that as the finding (cross-layer
offers may be unconstructible at the ledger level, which would close §2.4 without
code) and keep the rule as a validator unit test.

---

#### T-A4 · History referential integrity

→ `phases/p7b-audit.ts` — six SQL assertions, no new infrastructure

```ts
const integrity: [string, string][] = [
  ["every archived offer kept both sides of its swap", `
     SELECT h.id FROM offer_file_history h
     WHERE NOT EXISTS (SELECT 1 FROM offer_file_tokens_history t
                       WHERE t.offer_file_id = h.id AND t.direction = 'GIVING')
        OR NOT EXISTS (SELECT 1 FROM offer_file_tokens_history t
                       WHERE t.offer_file_id = h.id AND t.direction = 'WANTING')`],
  ["no orphan history side-rows", `
     SELECT offer_file_id FROM (
       SELECT offer_file_id FROM offer_file_tokens_history
       UNION SELECT offer_file_id FROM offer_file_nullifiers_history
       UNION SELECT offer_file_id FROM offer_file_unshielded_spends_history
       UNION SELECT offer_file_id FROM offer_file_commitments_history) s
     WHERE NOT EXISTS (SELECT 1 FROM offer_file_history h WHERE h.id = s.offer_file_id)`],
  ["archive_reason is CONSUMED or TTL, never NULL", `
     SELECT id FROM offer_file_history
     WHERE archive_reason IS NULL OR archive_reason NOT IN ('CONSUMED','TTL')`],
  ["archived_at never precedes the offer it archives", `
     SELECT id FROM offer_file_history
     WHERE archived_at IS NULL
        OR archived_at < first_seen_at
        OR archived_at < metadata_created_at`],
];
for (const [name, sql] of integrity) {
  await check(`history integrity: ${name}`, async () => (await db.query(sql)).rows.length === 0);
}
```

Plus two that need the suite's own record:

5. **Side-row counts survived archival.** For each resolved ledger offer,
   compare the nullifier / unshielded-spend / token / commitment counts captured
   at ingestion (added to `OfferRecord` in PR-A) against the `_history` counts.
   The archive wCTE ([queries.app.ts:144](../../database/sql/queries.app.ts))
   copies four side tables in one statement and nothing proves all four landed.
6. **Fill markers survived.** Every shielded offer in history has ≥1
   `offer_file_commitments_history` row. Branch 3 of `cancelledPredicate` is
   **vacuous** when markers are missing, so a marker-copy regression silently
   downgrades exact classification back to the old heuristic without failing a
   single existing check.

**Catches.** #1 is the important one: `getTradeHistory` inner-joins both sides,
so an offer that loses a leg during archival **disappears from trade history
silently**. A real sale vanishing is worse than a wrong one appearing, and
nothing today would notice.

---

#### T-A5 · Every stored blob still validates

→ `phases/p7b-audit.ts` + new `lib/verify.ts`

p7b today recomputes only sha256 ([p7b-audit.ts:79](phases/p7b-audit.ts)) — a
row can be hash-correct and semantically garbage.

```ts
// lib/verify.ts — the shared "re-validate these bytes independently" helper,
// used by T-A5, T-A6, T-B1 and T-D2 so the audit never grades the API with the API.
import { getBlankRefState, validateZswapOfferBytes } from "@zswap-da/validator";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

export function fullyValidate(raw: Uint8Array) {
  return validateZswapOfferBytes(raw, {
    refState: getBlankRefState(net.id),
    tblock: new Date(),
    maxBytes: 1024 * 1024,
    crypto: "verify",           // the whole point: proofs and signatures too
  });
}
```

```ts
await check("every stored blob re-validates, proofs included", async () => {
  const rows = await db.query(
    `SELECT offer_hash, transaction_hex FROM offer_file
     UNION ALL SELECT offer_hash, transaction_hex FROM offer_file_history`);
  const bad: string[] = [];
  for (const r of rows.rows) {
    const v = fullyValidate(OfferFiles.decode(r.transaction_hex));
    if (!v.ok) bad.push(`${r.offer_hash.slice(0, 8)}:${v.code}`);
  }
  return bad.length === 0;
}, /* detail */ );
```

**Cost.** `wellFormed` is the pipeline's dominant cost; at 25 offers this is a
few seconds, at `GRAND_OFFERS=250` it is minutes. Gate the exhaustive form on
`GRAND_DEEP_AUDIT=1` and sample 25 rows otherwise — but sample
**deterministically** (`detVar`), never randomly.

---

#### T-A6 · Stored legs == derived legs

→ `phases/p7b-audit.ts`

MIP-0006's core rule is that legs are *derived*, never trusted. Nothing proves
the DB kept faith with the derivation.

```ts
await check("offer_file_tokens equals deriveTokenLegs of the stored bytes", async () => {
  // live + history, both sides, including `kind`
  for (const row of rows) {
    const v = fullyValidate(OfferFiles.decode(row.transaction_hex));
    const want = [...v.gives!.map(l => `G|${l.token}|${l.amount}|${l.kind}`),
                  ...v.wants!.map(l => `W|${l.token}|${l.amount}|${l.kind}`)].sort();
    const got  = (await legsFor(db, row.id, row.live)).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) return false;
  }
  return true;
});
```

**Catches.** A derivation change, a partial leg insert, or a `kind` regression —
each of which misprices every trade for that offer while every other check stays
green.

---

### (b) Bad transactions don't reach users

---

#### T-B1 · Re-verify what the API actually serves

→ new `phases/p8-served.ts`, inserted between p5 and p7b (needs a populated
book, must precede the determinism replay that quiets the chain)

```ts
export async function p8Served(db: Client): Promise<void> {
  beginPhase("p8-served");
  const served: { id: string; bech32: string; body: any }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await getOffersPage({ limit: "100", ...(cursor ? { after_hash: cursor } : {}) });
    for (const row of r.body?.offers ?? []) {
      const d = await getOfferByHash(row.offerId);
      served.push({ id: row.offerId, bech32: d.body?.offerBech32 ?? "", body: d.body });
    }
    cursor = r.body?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  // …four assertions over `served`
}
```

1. **Content address holds from the client's side.**
   `sha256(OfferFiles.decode(bech32)) === offerId` — MIP-0005's cross-node
   identity claim, verified by the consumer rather than by the DB that
   produced it.
2. **The full ladder passes, `wellFormed` included** — `fullyValidate(...)`.ok.
3. **Advertised legs equal derived legs** — `computed.gives`/`wants` vs
   `deriveTokenLegs` of those same bytes. (T-A6 checks the DB; this checks the
   wire.)
4. **The offer can still settle.** For each served offer: every
   `computed.inputNullifiers` entry absent from `nullifiers`; every unshielded
   input present in `created_unshielded`; and every `inputRoots` entry inside
   the window — recomputed independently in SQL rather than by calling the gate
   we are testing:
   ```sql
   SELECT 1 FROM known_roots
   WHERE root = $1 AND (last_seen_ms >= $2 OR height >= (SELECT MAX(height) FROM known_roots))
   ```
   with `$2` = tip `ms_timestamp` − `ROOT_WINDOW_SECONDS`·1000.

**(4) is the one that matters.** Nothing today stops the book listing an offer
that has become unfillable. The code names the failure class itself — "phantom,
unfillable offers", [network-windows.ts:12](../../node/network-windows.ts) —
without testing it.

---

#### T-B2 · Nothing is served past its own expiry

→ p8

```ts
await check("no live-book row is past its own expiresAt", async () =>
  served.every(s => Date.parse(s.body.computed.expiresAt) > Date.now() - 60_000));

await check("OFFER_TTL_SECONDS <= ROOT_WINDOW_SECONDS for a shielded book", async () =>
  OFFER_TTL_SECONDS <= ROOT_WINDOW_SECONDS);
```

The second is a config invariant, not a behaviour: the two are independent env
knobs ([network-windows.ts:58](../../node/network-windows.ts)), the default ties
them, and the grand run only ever sets them equal — so a deployment that widens
the TTL serves dead shielded offers for the difference, invisibly.

---

#### T-B3 · The list route never serves a non-live offer

→ p8

`for (const s of served) getOfferStatus(s.id).status === "live"`. p7b's live-set
check compares against the suite's own ledger
([p7b-audit.ts:282](phases/p7b-audit.ts)) and so cannot catch an offer the suite
never created — e.g. one that arrived from a foreign publisher, or survived a
failed archive.

---

#### T-B4 · MIP-0006 payload presence rules, against a live book

→ p8

At least one of `offerId`/`offerBech32` on every payload; list rows carry
`offerId` and omit the blob; **single-offer responses include `offerBech32`** —
including the **archived** detail path served out of `offer_file_history`, which
is not covered even at unit level ([api.test.ts:96,111](../../node/api.test.ts)).

---

### (c) All data correctly logged as real sales

---

#### T-C1 · Unshielded cancels read `cancelled` *(red until PR-B)*

→ `phases/p3-lifecycle.ts`, `phases/p3b-competing.ts` · depends on §2.1

Rewrite the two `KNOWN GAP` assertions to the truth:

```ts
await check("unshielded walk-away reads cancelled", async () =>
  (await getOfferStatus(built.hash)).body?.status === "cancelled");

await check(`${label}: loser reads cancelled (fill markers separate them)`, async () =>
  (await getOfferStatus(loser.offerHash!)).body?.status === "cancelled");
```

and register both in `KNOWN_RED` under PR-B. `p3b`'s `expectedTrades` becomes
`1` for both layers; `expectedStatus()`
([p7b-audit.ts:42](phases/p7b-audit.ts)) loses its `rec.layer === "uu"` branch;
`fillLedger()` ([ledger.ts:132](ledger.ts)) becomes
`countsAsFill = o.fate === "settled"`.

Note the ordering trap: those four edits make **six** existing checks red, not
two. All six go in the registry together under PR-B, or the p7b chart checks
fail for an unrelated-looking reason.

---

#### T-C2 · Aggregate volume equals settled offers *(red until PR-B)*

→ p7b

Today the oracle is bent to match the bug. Once §2.1 lands, assert the invariant
directly instead of pair-by-pair against a modelled ledger:

```ts
await check("Σ chart volume == Σ settled offers, across all pairs", async () => {
  const settled = ledger.offers.filter(o => o.state === "resolved" && o.fate === "settled");
  const expected = new Map<string, bigint>();          // color → amount
  for (const o of settled) {
    add(expected, ledger.colors[o.giveToken]!, BigInt(o.giveAmount));
    add(expected, ledger.colors[o.wantToken]!, BigInt(o.wantAmount));
  }
  // …sum volume_base/volume_quote from /v1/chart/stats over every pair and compare
});

await check("pair_stats.trade_count == genuine fills per pair", async () => { /* … */ });
```

---

#### T-C3 · Expired offers are never trades

→ p7b — one assertion, passes today, pins the boundary:

```sql
SELECT h.id FROM offer_file_history h
WHERE h.archive_reason = 'TTL'
  AND EXISTS (SELECT 1 FROM offer_file_tokens_history t WHERE t.offer_file_id = h.id)
  AND h.id IN (/* ids the chart query would return for any pair */)
```

Simpler and stronger in practice: assert `getTradeHistory`'s row count for each
pair equals the count of `archive_reason='CONSUMED' AND NOT cancelled` rows for
that pair — TTL rows are then excluded by construction, and any future widening
of the filter fails here. ~25 % of a run's offers expire, so this has real
material behind it.

---

#### T-C4 · Maker self-fill counts as a sale

→ p3

`cancelledPredicate` claims "a tx that recreates the exact commitments is a
maker self-fill: the offer's terms executed, so `consumed` is the right answer"
([queries.app.ts:77](../../database/sql/queries.app.ts)). Never executed.

**How.** Fund one maker with **both** sides of a pair, publish give-TA / want-TB,
then settle it with that same wallet via the existing taker flow —
`settleOffer(makerPw, rec, blob)`; `PoolWallet.run()` serialises, so no
reservation conflict. Assert `consumed` **and** exactly one trade on the pair.

**Why it earns its runtime.** This case sits exactly on the cancel/fill boundary
— identical spender, identical outputs — so if the predicate is wrong anywhere,
it is wrong here.

---

### (d) History and pricing correct

---

#### T-D1 · The 24 h window follows the chain clock *(red until PR-D)*

→ `packages/node/trade-data.test.ts` (unit) + p7b (guard)

**Unit (the red).** Deterministic, free, and it is the only formulation that
*can* fail on a dev stack — on this chain the NTP anchor is launch time, so chain
time ≈ wall clock and the defect is dormant:

```ts
test("24h window is chain-relative: fills stay in-window when the chain lags wall clock", async () => {
  const chainNow = Date.now() - 48 * 3600_000;              // node is 48 h behind
  await seedFill(db, { archivedAt: new Date(chainNow - 3600_000) });  // 1 h of chain time ago
  const s = await realStats(db, BASE, QUOTE);
  expect(s.volume_base).toBeGreaterThan(0);   // today: 0 — NOW() is 47 h past the fill
  expect(s.high).toBeGreaterThan(0);
});
```

**e2e guard (passes today, catches drift anywhere).** In p7b, per pair:
`/v1/chart/history` non-empty ⟹ `/v1/chart/stats.volume_base > 0`. The two
routes must never contradict each other about whether trades exist.

---

#### T-D2 · Price inversion *(red until PR-C)*

→ `phases/p2-api.ts`

The stored pair key is `LEAST||GREATEST` of the hex colors, so which side is
"base" depends on the lexical ordering of a hash — the likeliest place for a
silent `1/x` to reach a user's screen.

```ts
const [A, B] = [ledger.colors.TA!, ledger.colors.TB!];
const ab = await getChartStats(A, B);
const ba = await getChartStats(B, A);
await check("chart price inverts exactly when base and quote swap", async () =>
  approx(Number(ab.body.last) * Number(ba.body.last), 1, 1e-9));
await check("chart volumes swap with base and quote", async () =>
  Number(ab.body.volume_base) === Number(ba.body.volume_quote) &&
  Number(ab.body.volume_quote) === Number(ba.body.volume_base));
```

Then the same, anchored to a **known** fill rather than to self-consistency —
the p1 offer's give/want are in the ledger, so assert the literal number:

```ts
await check("a known fill prices at want/give in the base direction", async () =>
  approx(Number(await lastPriceFor(giveColor, wantColor)),
         Number(rec.wantAmount) / Number(rec.giveAmount), 1e-9));
```

That second one is what catches §2.2: self-consistency survives an inversion,
a literal expectation does not.

---

#### T-D3 · `/v1/pairs` and `/v1/chart/stats` agree *(red until PR-C)*

→ p7b

```ts
await check("/v1/pairs last_price agrees with /v1/chart/stats", async () => {
  for (const p of (await getPairs()).body ?? []) {
    if (p.last_price == null) continue;
    const s = await getChartStats(p.base_color, p.quote_color);
    if (!approx(Number(p.last_price), Number(s.body.last), 1e-9)) return false;
  }
  return true;
});
```

`last_price` is computed twice by two unrelated code paths — the event-bus
upsert and the SQL aggregate — and nothing compares them. This is the check that
surfaced §2.2.

---

#### T-D4 · `trade_count` is exact; ordering is chain-ordered

→ p7b

`upsertPairStatsByOfferId` runs from an `offer_consumed` listener, so a
duplicated or replayed event double-increments and moves `last_price` a second
time. Assert `trade_count` == genuine fills per pair (from the ledger), and that
`/v1/pairs` ordered by `last_traded_at` matches the ledger's settlement order —
now meaningful, since that column became chain time.

---

#### T-D5 · Multi-leg offer *(red until PR-F)*

→ p3 + p7b · depends on §2.5

**How to build one.** `initSwap` takes `desiredOutputs` as an array — pass two
entries with different colors, or two shielded outputs in one entry, to get a
3-leg transaction. `buildOffer`'s existing post-build `validateZswapOffer` guard
already reports the derived legs, so the fixture asserts `gives.length +
wants.length === 3` before publishing; if the SDK silently drops a leg (as it
does cross-layer), the fixture fails at construction rather than proving nothing.

Assert the ruling from §2.5: rejected with `MULTI_LEG_UNSUPPORTED`, or indexed
with volume attributed exactly once. Register under PR-F.

---

### (e) Duplicate zswaps: accepting one disables the others

---

#### T-E1 · N-way competition (N = 3…5)

→ `phases/p3b-competing.ts`

A price ladder over one coin is the *normal* maker pattern, not an edge case.
p3b builds exactly two ([p3b-competing.ts:55](phases/p3b-competing.ts)).

**How.** Generalise `buildCompetingPair` → `buildCompetingSet(pw, shielded,
idxBase, n)`: the existing build → `storeBlob` → `wallet.revert(finalized)`
cycle already releases the coin reservation without invalidating the serialized
bytes, so it loops. Vary `wantAmount` by `+7·i` so the hashes differ (a
byte-identical sibling would be rejected by content dedup — a different test).

Assert: all `n` indexed and sharing one input; settle exactly one; **all** `n`
archive; the winner reads `consumed`, all `n−1` losers read `cancelled`; the
pair shows exactly **one** trade. Run for both layers (the `uu` arm is red until
PR-B).

---

#### T-E2 · Partial overlap between two live offers

→ p3b

**Not** the same as p3's `partial` cancel shape — that one covers branch 1 for a
maker cancelling their own two-input offer ([wallets.ts:761](actors/wallets.ts)),
and it already passes for shielded. The untested case is branch 1 arising from
*competition*: offer X spends {c1,c2}, offer Y spends {c2,c3}; settling Y leaves
X partially spent and permanently unfillable.

**How — the hard part is controlling coin selection.** Fund a dedicated wallet
with three coins of distinct denominations chosen so each target give-amount
admits exactly one subset:

```
coins: 1000, 1500, 2000
give 2500 → only {1000, 1500}
give 3500 → only {1500, 2000}      ← shares exactly c2 = 1500
```

Build X (2500) → `revert` → build Y (3500) → `revert` → publish both → assert
`sharesInput` returns exactly one common key, and that each offer has two spend
rows. Settle Y. Assert X archives, reads `cancelled`, contributes no volume, and
leaves the book while c1 is still unspent.

---

#### T-E3 · Cross-door competition

→ p3b

Both competitors currently publish via `api` (`publishPath: "api"` is hard-coded
in `buildCompetingPair`'s `mk()`). Set the loser's `publishPath` to `"celestia"`
so `publishAndIndex` routes it through `submitBlobRaw`, and the STM's own
dedup/liveness ordering decides rather than the API's. One-line change, real
coverage.

---

#### T-E4 · The loser arrives *after* the winner settled

→ p3b (and it supplies T-A1's missing liveness fixtures)

**How.** In `buildCompetingSet`, hold back one built-but-unpublished competitor.
After the winner settles and archives, submit that blob — via `POST /v1/offers`
**and** via `submitBlobRaw`. Assert:

- API → `400 NULLIFIER_SPENT` (shielded) / `400 UTXO_NOT_LIVE` (unshielded);
- Celestia → an `offer_rejections` row bearing that same code
  (via `rejectionTotalsByCode`, T-A1's helper);
- no `offer_file` row, ever.

**Why it is not already covered.** p4's `consumedBlob` fixture replays the *same*
offer, so content dedup fires first and the fixture's own `expectedCodes` accepts
three different answers ([adversary.ts:128](actors/adversary.ts)) — the liveness
gate is never proven to be what did the rejecting. A *different* offer over the
same coin has no dedup match, so only liveness can stop it.

---

#### T-E5 · Two takers, two competing offers, one coin

→ p3b

**How.** Take the winner and one loser from `buildCompetingSet`, hand each to a
different taker, and fire both settlements without awaiting in between (the
existing `submitToBalancer` is already non-blocking;
[wallets.ts:207](actors/wallets.ts)). Exactly one lands on chain.

Assert: exactly one trade on the pair; both offers archived; the losing taker's
failure leaves no half-archived state (T-A4's integrity queries re-run after);
and volume counted once.

---

#### T-E6 · Byte-identical duplicates inside one L2 block

→ p4

**How.** `submitBlobRaw(bytes)` twice back-to-back with no delay, so both land
inside one Celestia `delayMs` window and therefore one L2 block.

Assert: exactly one `offer_file` row; exactly one `DUPLICATE_OFFER` rejection;
and — the real point — **the node is still alive** (`p0`'s process check
re-run) and the block's other offers were indexed.

**Why.** Both blobs are processed inside a single block transaction, so the
second one's dedup probe (`getOfferStatusByHash`) must observe the first one's
*uncommitted* INSERT. If it does not, the unique index catches it as an STF
error that aborts the whole block — taking every legitimate offer at that height
with it. That is the same blast-radius shape as the NUL crash, and it is
currently untested.

---

### (f) Shielded and unshielded

---

#### T-F1 · The four cancel shapes, unshielded *(red until PR-B)*

→ p3 · depends on §2.1

All four (`single-one-tx`, `split-two-tx`, `partial`, `consolidated-one-tx`) run
with `layer: "ss"` ([p3-lifecycle.ts:120](phases/p3-lifecycle.ts)).

**How.** The `shapes` loop is already parameterised; add a `layer` field and
iterate `["ss", "uu"]`. Needs `cancelGiveToken`/`cancelWantToken` to return
`UA`/`UB` for the `uu` arm, unshielded cancel-specialist wallets in
`setupActors`, and `makeRefill` to fan out unshielded (`genesisFanOut(..., false,
…)`). Budget: +4 offers, +2 wallets.

---

#### T-F2 · `UTXO_NOT_LIVE` fixtures

→ p4

Two cases, both doors, neither covered: a UTXO the chain **never created**, and
one already **spent**. The second comes free from T-E4. The first needs a
fabricated `(owner, intentHash, outputNo)` — build a real unshielded offer, then
rewrite the intent hash bytes so the triple refers to nothing. If that breaks
deserialization, record it and cover the gate at unit level (the validator
already has `isUnshieldedCreated` hooks —
[validate.test.ts:275](../../validator/validate.test.ts)).

---

#### T-F3 · Unshielded `expiresAt`, and the unreachable fallback

→ p3

p3 asserts only the shielded root-window floor
([p3-lifecycle.ts:193](phases/p3-lifecycle.ts)). The unshielded path is
genuinely different code — `earliestIntentTtl` reading `Intent.ttl`.

```ts
await check("unshielded expiresAt equals the intent TTL", async () => {
  const d = await getOfferByHash(built.hash);
  const expected = P2pAtomicSwaps.earliestIntentTtl(OfferFiles.fromBech32(built.blob));
  return d.body?.computed?.expiresAt === expected;
});
await check("the OFFER_TTL fallback branch is unreachable for a well-formed offer", async () =>
  P2pAtomicSwaps.earliestIntentTtl(OfferFiles.fromBech32(built.blob)) !== undefined);
```

The second assertion tests the claim at
[state-machine.ts:547](../../node/state-machine.ts) — *"the indexer-TTL branch
is defensive only; it should be unreachable"* — which has never been checked.

---

#### T-F4 · Chaos and TTL sweep, unshielded

→ p5, p6

`LAYERS` is 4:2 shielded:unshielded ([p5-load.ts:69](phases/p5-load.ts)), but the
chaos batch and the expiry batch hard-code `layer: "ss"` (lines 138, 531). So
restart-recovery and the TTL sweep are proven for shielded only. Replace both
with `LAYERS[detVar(index, LAYERS.length)]`, matching how the main storm already
picks.

---

#### T-F5 · Layer-symmetric audit

→ p7b

Report every audit result split by layer, and **fail if either layer contributed
zero offers to a class** (settled / cancelled / expired / live). Coverage that
silently collapses onto one layer is the exact failure mode this whole section
exists to catch — and it is how the current shielded-only cancel coverage went
unnoticed.

---

## 4. Infrastructure PR-A must add

1. **`known-red.ts`** + the `check()` branch (§1.2).
2. **`lib/verify.ts`** — `fullyValidate()`, the one place that re-derives truth
   from bytes, so the audit never grades the API using the API.
3. **`lib/db2.ts`** — `rejectionTotalsByCode()`, `legsFor()`, and the T-A4
   integrity query list.
4. **`actors/adversary.ts`** — `buildOneSidedOffer`, `rootUnreadableBlob`,
   `crossLayerBlob` (via `Transaction.merge`), and the new Celestia families.
   All routed through `preVerify()`.
5. **`actors/wallets.ts`** — `buildCompetingSet(n)`, `buildMultiLegOffer`,
   `fundWithDenominations(coins[])` for T-E2, unshielded cancel wallets for
   T-F1, and ingestion-time side-row counts recorded on `OfferRecord` for T-A4.5.
6. **`phases/p8-served.ts`** — new phase, wired into `run.ts` between p5 and p7b.
7. **`run.ts`** — `## Known red` section in `SCORECARD.md`; per-layer split in
   the fates table (T-F5).
8. **`config.ts`** — `GRAND_DEEP_AUDIT` for T-A5's exhaustive mode.

## 5. Budget

| | |
|---|---|
| New checks | ~45 (143 → ~190) |
| New wallets | 2 unshielded cancel specialists, 1 self-fill maker, 1 denomination wallet |
| New on-chain offers | ~14 (T-E1 ×2 layers, T-E2, T-E5, T-F1 ×4, T-C4, T-D5) |
| Added runtime | +8–12 min at `GRAND_OFFERS=25`; T-A5 exhaustive adds ~1 min/25 offers |
| Product code in PR-A | none |

## 6. Named, out of scope

- **Reorg recovery.** Archival is destructive by design
  ([state-machine.ts:55](../../node/state-machine.ts)): if a consuming block is
  reorged out, the offer cannot be restored without a full resync. Before
  production this needs a confirmation-depth decision, not a test.
- **Celestia inclusion height** is dropped at the primitive boundary
  ([ISSUES.md](ISSUES.md) §2). Renaming was right for a display field; it stays
  a real limitation for anyone wanting to verify an offer's blob by height.
