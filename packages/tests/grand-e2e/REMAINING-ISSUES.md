# Remaining issues — plan, test, fix, verify

State as of 2026-08-07. Companion to
[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) (original plan, per-defect
measurements) and [FINDINGS.md](FINDINGS.md) (how we got here).

All work now lands on **one PR:
[#35](https://github.com/effectstream/zswap-offerfiles-kernel/pull/35)**,
`feat/production-readiness`, 26 commits off main. PRs #30–#34 are closed and
superseded; their commits survive intact in #35's history, so the five review
verdicts at `/home/eddie/zswap-offerfiles-kernel-x/PR-3{0,1,2,3,4}-REVIEW.md`
still apply to the same commits. Items below land as **commits on #35**, not as
separate PRs — the PR-letter names are kept only because the review documents
and commit messages use them.

**Nothing below has been executed.** Each item carries its plan, its red, its
fix and its verification.

Two revisions are folded in: an independent review that found five blocking gaps
(all five verified against the tree, all five held, two worse than reported),
and the decision that **breaking changes are free — nothing is deployed, and no
retro-compatible change is wanted anywhere.** That second ruling closed one item
outright and reshaped three others.

---

## 0. The queue at a glance

| # | Issue | Kind | State |
|---|---|---|---|
| **1** | **Cursor key not failover-safe; its guard tests the OLD key** | **blocking, product** | half already closed |
| 2 | Clean full run — nothing verified e2e since PR-B | verification debt | next after #1 |
| 3 | `maxLagBlocks: 1403` unexplained | diagnosis | measure in #2 |
| 4 | §2.6 `expiresAt` past at ingestion **+ cleanup on policy TTL** | product defect | PR-G |
| 5 | Cross-offer marker bypass **+ projection race** | product defect | PR-I |
| 6 | §2.4 cross-layer offers unenforced | product defect | PR-E |
| 7 | §2.5 baskets — **five** market surfaces | product defect | PR-F |
| 8 | `/v1/pairs` ordering — contract undefined | product decision | with #7 |
| 9 | SSE baseline keys absent | measurement | rides in runs |
| 10 | ~~`pair_stats` backfill~~ | **RESOLVED** — no-retrocompat ruling | §10 |
| 11 | T-A2 unreachable reject codes | ruling | doc |
| 12 | T-E2 / T-E5 deferred coverage | coverage | suite-only |
| 13 | Reorg recovery — **all derived state** | production decision | needs ruling |
| 14 | Runner not host-isolated | scope question | **needs your call** |
| 15 | The closing sweep | closeout | PR-J |
| 16 | **pgtyped regeneration can silently break again** | new — no guard | small |
| 17 | **`outputIndex ?? outputNo` shim unconfirmed** | new — flagged, untouched | needs grammar |

### Execution order

1. **#1 cursor key** — the only blocking item; a product defect already on #35.
2. **#2 the run** — first honest verdict since PR-B; also resolves #3, measures
   #9, and answers #8.
3. **#4 → #5 → #6 → #7/#8** — #4 is smallest and its red already records; #5 is
   PR-B's own integrity; #6 and #7 need fixtures built.
4. **#16** alongside any of the above (small, independent).
5. **#12 coverage**, then **#15 the sweep** last — its precondition is an empty
   defect list.

**Off the critical path:** #11, #13, #14 and #17 need a ruling or an external
fact, not code. They can be settled while runs execute.

---

## 0.1 What the consolidation already closed

Resolved by merging the stack into #35, beyond the five PRs' own content:

- **One schema.** Migrations 001–015 folded into `000-init.sql`; the chain is
  gone. Four columns became NOT NULL and each caught something real — commits
  `6ea988d`, `18003cb`, `b7e3169`.
- **015's backfill deleted outright** — it wrote
  `COALESCE(metadata_created_at, created_at, NOW())`, reintroducing exactly the
  node-local ordering the cursor change exists to remove. **This was one of the
  two mechanisms behind issue #1**, so half of that item is already closed.
- **25 dead generated queries removed**, including `InsertOfferFile`, which
  inserts the dropped `auth_*` / `metadata_maker_note` columns and would fail if
  called. Fifteen more were defined in *both* `queries.sql` and `queries.app.ts`
  — genuinely ambiguous bindings through `mod.ts`.
- **`bun run build:pgtypes` un-broken.** It had been aborting on a parse error,
  logging "Skipped: no changes or no queries detected", and **exiting 0** — so it
  regenerated nothing while reporting success. That drift is what hid the
  duplication. See #16 for the guard that should stop it recurring.

Also disposed of, so nobody re-investigates: `api.test.ts` logs
`Contract files not found` since the gitignored contract JSON was untracked, but
`env.ts` wraps that read in try/catch returning `null`. **Noise, not a failure**
— verified, not assumed.

---

## 1. BLOCKING — the cursor key and its stale regression test

**Plan.** Two defects. One is already half-closed by the consolidation.

**(a) The regression guard tests a query that no longer exists.**
[cursor-pagination.test.ts:144](../../database/cursor-pagination.test.ts:144)
EXPLAINs:

    WHERE (o.created_at, o.id) < (…) ORDER BY o.created_at DESC, o.id DESC
    expect(plan).toContain("idx_offer_file_created_at_id")

Production orders on `(first_seen_at, id)` via `idx_offer_file_first_seen_at_id`
(`getOpenOffersPage`). **The test would stay green if the production index were
dropped outright.** The file mentions `created_at` 19 times against
`first_seen_at` 6 — it was largely never migrated. The schema comment claiming
"a missing index is a test failure rather than a silent slow scan" is currently
false.

**(b) The key is not failover-safe.** For a shielded offer `first_seen_at` comes
from `known_roots.first_seen_ms` — the block in which **this node** first
observed the root — so a replica started at a later `MIDNIGHT_START_BLOCK`
orders the book differently. p7a cannot detect it: `main.grand-b.ts` uses
`startBlockHeight 1` on every primitive, so both instances agree *by
construction*. Compounding it, `id` is documented as local bookkeeping.

**Already closed:** the third mechanism — 015's backfill writing `created_at` /
`NOW()` into the sort key — is gone with the migration chain (§0.1).

Semantics matter too: `first_seen_at` is proof-root age, not publication time,
so "newest first" is not what the book returns.

**How to test.**

- Fix the guard first: rewrite the EXPLAIN against the **production** key and
  index, and sweep the file's remaining `created_at` occurrences.
- **Failover test** — the one p7a structurally cannot do: two DBs holding the
  same offers but with different serial-ID histories (insert in a different
  order) and different Midnight start heights; assert identical page order, and
  that paginating across a failover mid-walk skips and repeats nothing.

**How to fix.** Move the cursor to a globally stable publication tuple:

- **`(celestia_height, offer_hash)` — chosen.** Both chain/content-derived,
  both already NOT NULL, no dependence on sync start or serial assignment.
  `offer_hash` is the MIP-0006 offerId, so ties break identically everywhere,
  and the tuple *is* publication order semantically.
- Rejected: `(metadata_created_at, offer_hash)` — closer to human "newest", but
  the column is nullable and would need the same tightening.

The index and `resolveOfferCursor`'s history probe move with it. `first_seen_at`
stays a served field — a fine display value and a bad sort key. Drop whichever
of `idx_offer_file_created_at_id` / `idx_offer_file_first_seen_at_id` is left
unused, and confirm the archive path copies both new key parts onto history rows
so mid-pagination archival still resolves.

**How to verify.** New guard EXPLAINs the production key and **fails if the
index is dropped**; failover test green; full run with p7a determinism
identical; p8's cursor walk unchanged.

---

## 2. The clean full run

**Plan.** One `fresh-run.sh` at #35's head, after #1 lands. PR-C's price checks
passed once on 2026-08-06, but PR-D and PR-H have **never** been e2e-verified,
PR-B's review fixes landed after its last green run, and the whole tree now sits
on a rewritten schema.

**How to test.**

    ./packages/tests/grand-e2e/fresh-run.sh

Read **`maxLagBlocks` first**. Above ~150 the run is **void, not failed** — go to
#3 and do not debug downstream failures. Historical band: 53–95.

Known pre-run hazards: shutdown orphans (`main.dev.ts`, PGlite holding 5432 —
the reaper covers both), and a reboot re-enabling system PostgreSQL on 5432
(symptom: `SASL: SCRAM-SERVER-FIRST-MESSAGE` in `stack.log`).

**How to fix.** Nothing — this item *is* the verification.

**How to verify.** Pass requires all of: `maxLagBlocks` ≤ ~150; 0 failures of
~205; **RED-8 the only expected red**; p7a byte-identical across A and B; the
unshielded cancel shapes green (PR-B's marker gate and count against a live
chain, which no unit test reaches). Record in passing: `/v1/pairs` ordering
(#8), and CONSUMED-only SSE p50/p95 (#9, sample 1 of 2–3).

---

## 3. `maxLagBlocks: 1403` — the unexplained 15× regression

**Plan.** The last run's 15 failures were one throughput failure counted fifteen
times (FINDINGS §3): the STM fell ~1403 blocks (~23 min) behind, against a 53–95
band. Best hypothesis (FINDINGS §4): **stale processes from hard-killed runs** —
both high-lag runs followed a session kill, and the reaper then covered only the
batcher, dust provisioner and indexer. It now also reaps `main.grand-b.ts`
(load 17 while replaying), `main.dev.ts` and `start-pglite`. If right, the fix
has shipped and #2 confirms it.

**How to test.** #2's run, with the process table verified clean first.

- ≤150 → hypothesis holds provisionally; one more clean run closes it.
- >150 with a clean table → bisect: (1) same load at PR-B's commit — it recorded
  83, so an intra-branch regression must be later; the new index set on the
  offer-file write path is the prime suspect; (2) per-phase wall times against a
  historical green run, to locate *where* lag accumulates; (3) box load.

**How to fix.** By cause only. Stale processes → already fixed, close. A new
index on the write path → drop it (the history `first_seen_at` index is already
marked droppable in the schema comment). Box contention → rerun quiet. Suite
outgrew the dev batcher (one wallet, `maxSlotsPerWallet=1`, ~25 s/tx, ~14 new
on-chain offers) → **provisioning decision**. The standing rule is absolute: do
NOT widen the 3-minute index-wait to make it pass.

**How to verify.** Two consecutive runs inside the historical band. One proves
nothing — the failure was intermittent.

---

## 4. PR-G — §2.6: expiry, advertised *and* actual

**Plan.** Measured: ingested 18:34:20, served `status: live` with `expiresAt`
18:23:36 — expired eleven minutes before arrival. Fixing only the advertised
timestamp is half a fix, and the tree confirms why:

- Cleanup is scheduled at `data.blockTimestamp + OFFER_TTL_SECONDS`
  ([state-machine.ts:742](../../node/state-machine.ts:742)) — a fixed policy TTL
  computed independently of the derived expiry.
- `api.ts` never filters on `metadata_expires_at`; it only echoes it (:225,
  :285). Liveness is "row is in `offer_file`, not history".

So correcting the string leaves the offer **in the live book**, served and
unfillable. Two phantom classes survive: a superseded root near the end of its
window, and a short unshielded intent TTL.

Root cause is the pattern FINDINGS §2 names — a partial fix creating divergence.
The read gate got the `MAX(height)` escape (the ledger's `past_roots` re-inserts
the current root every block); the derivation and the scheduler did not.

**How to test.** RED-8 ([known-red.ts:67](known-red.ts:67)) already records the
advertised half, and XPASS discipline forces this commit to delete it. Add
DB/STM tests asserting **both** `expiresAt` and the scheduled cleanup time over
five cases: (1) quiet **current** root — escape applies; (2) **superseded** root
near the boundary — expires early, and cleanup must be scheduled early too;
(3) **multiple roots, current + stale** — bounded by the stale one; (4) short
**unshielded intent TTL** — cleanup before policy TTL; (5) normal case — policy
TTL wins, nothing regresses.

**How to fix.** Two coupled changes in
[state-machine.ts](../../node/state-machine.ts):

- **Derivation (~line 612).** Compute a deadline **per root**, then take the
  minimum. Explicitly *not* `MIN(last_seen_ms)` plus a separate is-current flag:
  that lets a current root's freshness extend a superseded root's window. Per
  root: `isCurrent ? max(last_seen_ms, blockTimestamp) : last_seen_ms`, `+
  ROOT_WINDOW_SECONDS`; then `min(...)`.
- **Scheduling (~line 742).** `future_ms_timestamp = min(derived expiresAt,
  blockTimestamp + OFFER_TTL_SECONDS)`. The policy TTL stays an upper bound; the
  derived expiry can only pull cleanup earlier.

Preserve both existing properties: the value stays a **conservative floor**, and
stays **deterministic on replay** — every input is a chain fact.

**How to verify.** Unit red→green on all five, asserting expiry *and* schedule;
full run with p8's expiry check green, `KNOWN_RED` **empty**, p7a identical.
Land as two commits: red first, then fix + RED-8 deletion.

---

## 5. PR-I — the cross-offer marker bypass, and the projection race

**Plan.** Found in PR-B's review, **still not registered as a red** — which
violates our own discipline; the red comes first. Markers match
`(owner, token_type, value)` correlated only through the settling tx, with no
offer scoping: two offers each wanting 20 UB to the same maker, "settled" by one
tx paying 20 **once**, both read `consumed`. PR-B's count fix closed the
*intra*-offer case; this is the *inter*-offer case.

Two constraints shape the fix:

- **Honest settlements cannot underpay.** A taker-built settlement is a merge,
  and merging preserves declared outputs verbatim, so a tx spending offers X and
  Y carries both payouts. A shortfall can only be constructed by a maker
  re-signing raw spends outside the offer intents. **All-shortfall ⇒
  fabrication.**
- **Except duplicates.** Requirement (e)'s duplicates share the SAME input, so
  one payout is the *correct* supply — they are alternatives, not additive.
  Demand counts **per distinct spend-set**.

**The projection race — verified, and it breaks the naive design.**
`midnight-unshielded-spend` is keyed on a single `(owner, intentHash, outputNo)`:
one primitive per output. Each transition archives the offers matching *that
output* and immediately emits `offer_consumed`, whose async listener updates
`pair_stats`. For disjoint offers X and Y settled by one tx, **X's pair-stat
update runs before Y is archived** — before global demand for that tx is
knowable. A later read-time classification can then call both `cancelled` while
`pair_stats` has permanently counted X. Read-time truth and the write-time
projection diverge with no path back.

**How to test.** New cases in
[unshielded-fill-vs-cancel.test.ts](../../database/unshielded-fill-vs-cancel.test.ts),
the first ones landed `test.failing` (this repo's unit-red mechanism, cf.
[multileg-pairs.test.ts:82](../../database/multileg-pairs.test.ts:82)):

- **t1 fabrication (red):** X, Y disjoint inputs, one tx, ONE 20-UB payout →
  both `cancelled`. Today both `consumed`.
- **t2 duplicate disable (red):** X, Y sharing one input, one settlement, one
  payout → **exactly one** `consumed`. This is requirement (e). Today both.
- **t3 honest batch (must stay green):** X, Y disjoint, one tx paying 20 twice →
  both `consumed`.
- **t4 unequal alternatives:** same spend-set but *different* marker counts or
  partially overlapping marker tuples — "dedupe by spend-set" alone does not say
  which demand represents the group. Define it: the group's demand is that of
  the offer winning attribution.
- **t5 projection consistency:** drive X and Y's spends as two separate
  transitions and assert `pair_stats` after both, not just final status. Must
  fail on today's emit-per-transition ordering.
- **t6 shielded twin:** same-input shielded duplicates share a nullifier *and* a
  declared commitment — does one settlement mark both `consumed`? If yes this
  grows a shielded half; if no, record why the shape is immune.

**How to fix.** In `unshieldedCancelledPredicate`
([queries.app.ts](../../database/sql/queries.app.ts)), per settling tx and
`(owner, token_type, value)`: supply = matching `unshielded_creates` rows for
that tx; demand = Σ `count` over attributing offers, **deduped by spend-set**;
shortfall ⇒ all `cancelled`. Among same-spend-set duplicates, attribution is
deterministic and keyed on **`(celestia_height, offer_hash)`** — the same tuple
#1 adopts, and for the same reason.

For the race, one of three, in preference order:

1. **Attribute after the full spending tx is known** — cleanest, but needs a
   tx-complete signal the per-output primitive does not obviously provide.
   **Unresolved: confirm whether any such signal exists before committing to
   this.**
2. **Make pair-stat updates idempotently recompute** from final classified
   history rather than incrementing per event — self-healing, and it subsumes
   #10 entirely.
3. **Persist final attribution before emitting** market-data events.

Heavier SQL than the current per-offer correlate; a read-time CTE over "offers
sharing this settling tx" is acceptable — classification is already read-time.

**How to verify.** t1/t2/t4/t5 flip `.failing` → `test`; t3 and the existing
nine unshielded cases untouched; t6 resolved either way, in writing. Full run:
unshielded shapes green, determinism holds, and `pair_stats` identical across A
and B — which is what actually proves the race closed.

---

## 6. PR-E — §2.4: cross-layer offers, ruled REJECT

**Plan.** Confirmed reachable, not hypothetical:
[probe-cross-layer.ts](probe-cross-layer.ts) merges a real shielded and a real
unshielded offer via `Transaction.merge`, and the result passes our **full**
ladder including `wellFormed`. Ruling (§2.4): REJECT — no support exists for
mixed-type settlement.

**How to test.** Red in two places:

- **Unit red:** a transaction whose derived legs span both layers currently
  passes the ladder — assert `CROSS_LAYER`, landed `test.failing`.
- **e2e red:** a `KNOWN_RED` entry for a new p4 fixture family — build the
  merged offer, submit at **both** doors (`blob.Submit` and the API), assert
  rejection with `CROSS_LAYER` and no indexing from the DA door; p8-served then
  re-asserts no served offer has legs on two layers.

**How to fix.** A `CROSS_LAYER` code in
[validate.ts](../../validator/validate.ts), beside the other derived-legs checks
(the two-sided `NOT_A_SWAP` check at :210 already holds the legs): after
deriving, if the layer set across all legs has size > 1, reject.
`deriveTokenLegs` already nets per (colour, layer), so the same colour on two
layers is two legs and is caught — MIP-0006's own framing. Pure function of the
offer bytes → identical verdict at both doors and on replay; no schema, no STM
change. Ladder placement: after structural decode, with the leg-shape checks,
before proof work — same tier as `NOT_A_SWAP`.

**How to verify.** Unit red→green; e2e fixture red→green with its `KNOWN_RED`
entry deleted in the same commit; full run green including determinism. The
probe stays in tree as documentation of reachability.

---

## 7. PR-F — §2.5: baskets excluded from FIVE market surfaces

**Plan.** Ruled ACCEPT-but-exclude: baskets are sealed pre-agreed settlements —
they live, settle and archive, but contribute nothing to price discovery,
because one settlement was becoming four trades at four prices on pairs nobody
traded. Eligibility (restated RED-5): **at most one give colour and at most one
want colour**.

The review found a fifth surface, and it is the most visible. `getPairs`
([queries.app.ts:640](../../database/sql/queries.app.ts:640)) builds live pair
rows with a `FULL OUTER JOIN` onto a give×want self-join computing `open_count`.
A 2×2 basket manufactures **four apparent pairs with open counts** on
`/v1/pairs` even with history, charts, mids and `pair_stats` all filtered.

**How to test.** Unit red exists —
[multileg-pairs.test.ts:82](../../database/multileg-pairs.test.ts:82). Extend to
all five surfaces, then the e2e fixture:

- Third shielded colour: one `TOKEN_SEPS` entry in [config.ts](config.ts) plus a
  funding grant (`mintShielded(deployed, sepByte, …)` parameterises colour by
  domain separator on the deployed contract — no new contract, §1.0.1).
- Build the basket by merging two offers (2 gives × 2 wants), publish, settle.
- Assert **both halves of the ruling**: it IS accepted (served live, archives
  `CONSUMED`, settleable) AND invisible to market data — zero chart prints,
  `pair_stats` untouched, volume and mid unchanged, and **no pair rows and no
  `open_count` contribution in `getPairs`**.

**How to fix.** Filter at five read surfaces in
[queries.app.ts](../../database/sql/queries.app.ts); ingestion, serving and
settlement unchanged:

1. `getTradeHistory` (:501)
2. `getPairStats24h` (:439)
3. `upsertPairStatsByOfferId` (:582) — write-side projection; filtering here
   keeps baskets out of `pair_stats` rather than hiding them at read time
4. `getOpenLegs` → `currentMid` in [trade-data.ts](../../node/trade-data.ts)
5. **`getPairs` (:640)** — both the `live` subquery's `open_count` and the pair
   rows it manufactures

Predicate: per offer and direction, `COUNT(DISTINCT token_color) <= 1` over
`offer_file_tokens{,_history}` — a grouped `EXISTS`/`HAVING` correlate in the
existing style. Repo hazard: **no backticks in SQL comments** inside these
template literals (cost two debugging cycles already).

**How to verify.** Unit red→green across all five; e2e fixture green;
`pair_stats` byte-identical across A and B in p7a. Assert the acceptance half
survived — the basket must still archive `CONSUMED`, or the fix overreached.

---

## 8. `/v1/pairs` ordering — the contract is undefined

**Plan.** **Correction to an earlier diagnosis.** A tie-breaking bug from
chain-quantised `last_traded_at` was theorised; the SQL says otherwise:

    ORDER BY open_count DESC, last_traded_at DESC NULLS LAST

The primary key is **`open_count`**, not recency. So the e2e assertion
(`/v1/pairs is ordered by last_traded_at, newest first`) tests a contract the
query never promised, and its failure is not necessarily intermittent — the tie
theory was built on a misreading. There is also no final deterministic
tiebreaker, so full ties order arbitrarily.

**How to test.** #2's run records the current result, but do not chase it —
first **decide the contract**: most-liquid-first (current behaviour) or
most-recently-traded-first (the assertion's claim). Then align query, assertion
and docs, and add a unit test seeding identical `open_count` *and* identical
`last_traded_at` to prove the tiebreaker.

**How to fix.** Recommended: keep `open_count DESC` — a market UI usually wants
liquidity first with recency secondary, which is what the SQL already does. Fix
the assertion, state the contract in the API docs, and append **`pair_key`** as
the final tiebreaker so full ties are deterministic across replicas. Ships with
#7, which is already editing this query.

**How to verify.** Assertion matches the documented contract; tiebreaker test
green; `/v1/pairs` byte-identical across A and B in p7a.

---

## 9. SSE baseline keys

**Plan.** `sseDeliveryLagP50Ms` / `sseDeliveryLagP95Ms` are absent from
[baseline.json](baseline.json) **on purpose**: the metric was redefined
(CONSUMED-only; TTL archives reported as a note, since their `archived_at` is a
scheduled block time the STM may reach late during catch-up), so the number must
be re-derived. Honesty note from FINDINGS §4 stands: the split is good hygiene
but is **not proven** to explain the historical spikes — that run was calmer.

**How to test.** Harvest CONSUMED-only p50/p95 from 2–3 clean runs (#2 is sample
one). Samples from any run failing the `maxLagBlocks` gate are void.

**How to fix.** Store the **observed** p50 and p95 as-is, with no baked-in
headroom: [metrics.ts:137](metrics.ts:137) already enforces `baseline × 1.2`, so
adding a further ~1.5× would compound to 1.8× and gate almost nothing. Record
the source run IDs in the existing `_note` field, which already carries this
kind of provenance.

**How to verify.** The next run gates on the new keys and passes; the scorecard
shows measured values within `baseline × 1.2`.

---

## 10. RESOLVED — no `pair_stats` backfill

**The ruling settles it.** Nothing is deployed and no retro-compatible change is
wanted, so there are no pre-fix `pair_stats` rows anywhere that matters:
production will deploy from height 1 and replay with the corrected code, and dev
DBs are wiped by `fresh-run.sh`. The two traps a rebuild would have had to dodge
(missing `archive_reason = 'CONSUMED'` filter re-importing cancels; stale
`trade_count` producing internally inconsistent rows) are now moot.

**Residual, and it is documentation only:** a long-lived dev DB shows wrong
historical prices until wiped. Record that in ISSUES.md; do not build a
migration for it.

Note #5's fix option 2 (idempotent recompute from classified history) would make
any future repair free as a side effect. That is a reason to prefer option 2, not
a reason to reopen this.

---

## 11. T-A2's unreachable reject codes — rule dead code or defence

**Plan.** `NO_SPENDABLE_INPUT`, `UNKNOWN_TOKEN`, `ROOT_UNREADABLE` never fire at
a real gate: the SDK will not build an input-free swap, and every token tag it
emits is `shielded`/`unshielded`/`dust`. All three stay covered at validator-unit
level against doubles. §1.0.1 names the fork — *a fail-closed branch no real
input can reach is either dead code or a defence against a future wire format.*

**How to test.** Reachability is already answered exhaustively; only doubles
reach them. No new tests — unit-double coverage is the right level for a
wire-format defence.

**How to fix.** A ruling recorded in §1.0.1. **Keep, documented as fail-closed
defence (recommended):** cheap, tested, and they exist precisely for bytes
today's SDK cannot produce — which is what a hostile or future wire format is.
Deleting narrows the fail-closed surface to save nothing. The alternative,
deleting as dead code, is defensible only under a strict no-unreachable-code
policy this codebase does not otherwise hold.

Note this is *not* in tension with the no-retrocompat ruling: these branches
defend against future inputs, not past ones.

**How to verify.** Ruling in §1.0.1 with one line of rationale per code; the
unit doubles stay as the permanent floor. Folded into #15.

---

## 12. T-E2 / T-E5 — the two deferrals, both re-scoped

**Plan.** Coverage for requirement (e)'s edges, deferred for wallet plumbing.
The review corrected both designs; both corrections are right.

**T-E2, partial overlap.** The loser cannot be observed "unsettleable while
live": `midnight-unshielded-spend` archives *every* matching offer the moment the
shared input is seen spent, so the loser leaves the live book in the same
transition. Test what is observable: fund exact UTXOs {A, B, C}; offer₁ spends
{A, B}, offer₂ spends {B, C}; settle offer₁; assert offer₂ **disappears from the
live book**, reads `cancelled` (partial-spend branch — B consumed elsewhere, C
never spent), **cannot settle**, and produces **no print**.

**T-E5, two takers one coin.** Settlements cannot go through the Celestia door —
that door carries offer blobs; settlements go through the Midnight
batcher/chain. Use **two independently funded taker wallets** and submit both
finalized transactions concurrently (the dev batcher's single-wallet
serialisation is exactly what two wallets sidestep). Assert: exactly one lands;
the loser fails cleanly with the **batcher/chain double-spend error** — *not*
`UTXO_NOT_LIVE`, which is an offer-ingestion API code and would be the wrong
assertion; the offer archives `CONSUMED` exactly once; exactly one print.

**How to fix.** Nothing, unless they find something.

**How to verify.** New checks green on a full run; §1.0's rows flip ⛔ → ✅.
Suite-only, no product code.

---

## 13. Reorg recovery — wider than archives, and a better tripwire

**Plan.** Named out of scope in §6 but it blocks the word "production": archival
is destructive by design ([state-machine.ts:55](../../node/state-machine.ts)) —
a reorged-out consuming block means the offer cannot be restored without full
resync. Two corrections from the review, both material:

- **Scope.** A fork contaminates far more than archives: `nullifiers`,
  `commitments`, `unshielded_creates`/`unshielded_spends`, `known_roots` and
  Celestia offer insertions are all permanent-by-design records written from
  chain events. Buffering only destructive archives leaves every one corrupted.
- **The obvious tripwire is too weak.** Global STM height monotonicity cannot
  detect a **same-height source-block replacement** — the most common reorg
  shape. Validate **parent/hash continuity in the sync layer**, where block
  identity is still available.

**How to test.** Fact-find first: can the effectstream feed, as this indexer
consumes it, deliver a reorg — a height seen twice, a height going backwards, or
the same height with different content? Celestia finality is single-slot once
included; the open question is what the L2 feed guarantees between inclusion and
our STM input.

**How to fix.** By what fact-finding returns:

- **Finalized-only (likely):** record the invariant and add the **parent-hash
  continuity check in the sync layer**, halting loudly on violation. Halting is
  correct: proceeding destructively archives against a fork, and a halted
  indexer is recoverable where a corrupted one is not.
- **Feed can reorg:** buffer the **complete source stream** before STM
  application — not just archives — by an N-block confirmation depth sized to the
  feed's actual reorg depth. Real design work: the buffer interacts with TTL
  scheduling and index-wait budgets.
- Soft-archive/tombstones: heavyweight third option, not recommended unless the
  buffer proves insufficient, since it reopens the history schema.

**How to verify.** Finalized-only: invariant documented, continuity check
unit-tested (feed a same-height different-hash block, assert the halt).
Buffered: boundary tests plus a full run confirming TTL scheduling and
index-wait budgets survive N. Either way §6's row becomes "decided: <what>".

**Needs a ruling once fact-finding lands.**

---

## 14. Runner host isolation — needs your call

**Plan.** Raised by the review; **not adopted into the critical path**, because
no isolation model was requested. The facts are true: `fresh-run.sh` binds fixed
host ports (PGlite on 5432, the stack's service ports) and reaps by `pkill`
pattern, so a concurrent run or an unrelated host process sharing a name
collides. That is how the system-PostgreSQL collision and the `pkill` self-kill
(exit 144) cost time already (FINDINGS §5).

**The question:** is single-run-per-box acceptable, or should the suite be
isolated? Options, ascending cost: document the constraint and add a
**preflight port check** (turns six wasted minutes into one clear line — wanted
independently in FINDINGS §5); parameterize every port via env; or a full
Compose wrapper with its own network.

**Recommendation:** preflight check now, defer Compose unless you want
concurrent runs. **Do not** let this block #2 — the box is dedicated.

---

## 15. PR-J — the closing sweep

**Plan.** End state: **zero expected failures anywhere**. Preconditions: #4, #5,
#6, #7 landed and the #11 ruling made. Skipping it leaves a registry that
tolerates reds forever — the exact failure mode XPASS exists to prevent.

**How to test.** The suite's own guards:
[known-red.test.ts](known-red.test.ts) keeps the registry well-formed; the
scorecard's expected-red section must render empty.

**How to fix.** `KNOWN_RED` should already be empty (each fix deletes its own
entry; #4 takes RED-8, the last) — the sweep **verifies** emptiness, and anything
remaining is a fix that skipped its paperwork. **Keep the mechanism**
(`known-red.ts`, its test, the `check()` branch): it is the discipline for the
next defect and costs nothing empty; deleting it would force reinventing it.
Sweep `test.failing` markers repo-wide. Close the documents: §1.0 all-✅/ruled,
the six §2 defects marked fixed, FINDINGS gains a closing section, ISSUES.md
updated, this queue emptied or archived.

**How to verify.**

    grep -rn "test\.failing" packages/ | wc -l   # → 0

plus `KNOWN_RED` entry count 0, and one final full run: ~205+ checks, 0
failures, 0 expected reds, determinism identical.

---

## 16. NEW — stop pgtyped regeneration from silently breaking again

**Plan.** `bun run build:pgtypes` aborted on a parse error, logged
"Skipped: no changes or no queries detected", and **exited 0**. It reported
success while regenerating nothing, for long enough that the checked-in
`queries.queries.ts` drifted out of sync with `queries.sql` and hid fifteen
duplicated query definitions. The parse error is fixed (§0.1), but **nothing
stops it recurring** — the same silent-success path is still there.

**How to test.** The guard is the test: regenerate in CI and fail if the output
differs from what is committed.

**How to fix.** A CI step, cheapest first:

    bun run build:pgtypes
    git diff --exit-code packages/database/sql/queries.queries.ts

This catches both failure modes at once — a skipped regeneration (output stale
vs. `queries.sql`) and an un-committed regeneration. If the generator's DB
bootstrap is too heavy for the unit job, the weaker fallback is to grep
`build:pgtypes` output for "Skipped" and fail on it; prefer the diff.

**How to verify.** Deliberately break it — reintroduce a top-level `--` comment
in `queries.sql`, confirm CI goes red, revert.

---

## 17. NEW — confirm the `outputIndex ?? outputNo` payload shim

**Plan.** [state-machine.ts:248 and :330](../../node/state-machine.ts:248) read
`payload?.outputIndex ?? payload?.outputNo`. It looks like a two-shape
compatibility shim and was flagged during the retrocompat sweep, but it was
**deliberately left in place**: `outputNo` is the ledger's own field name (see
[derive.ts:79](../../validator/derive.ts:79)), so this may bridge two genuinely
different sources rather than two versions of one.

Removing the wrong half fails **silently**: the `Number.isFinite` guard rejects
the payload, logs "Skipping malformed unshielded-spend payload", and unshielded
spends simply stop being recorded — taking fill-vs-cancel classification with
them, which is the whole of §2.1.

**How to test.** Read the `midnight-unshielded-{spend,create}` grammars and
confirm which field the primitive emits. The package is **not installed in this
tree** — that is why this is open rather than done. Failing that, assert on a
live run: log which branch of the `??` fires across a full suite and see whether
the second ever does.

**How to fix.** If the grammar emits only `outputIndex`, drop the `?? outputNo`
and keep the guard. If both appear, keep the shim and **replace the comment
with the reason**, so the next sweep does not re-flag it.

**How to verify.** Whichever branch is taken: unshielded spend rows still land
during a full run (p7b's audit already asserts stored spend refs equal the
transaction's own UTXO triples, so a regression here fails loudly there).

---

## Appendix A: review findings — verification record

Verified against the tree rather than accepted on report.

| Finding | Verdict | Evidence |
|---|---|---|
| Fixes on wrong branch | **CONFIRMED** → dissolved by #35 | `18eaa1e`/`7dc077e` touched PR-A/B/C/D files while sitting on PR-H |
| Cursor not failover-safe | **CONFIRMED, worse** | cursor-pagination.test.ts:144 guards `idx_offer_file_created_at_id` and `(created_at, id)`; production uses `first_seen_at`. Guard passes if the real index is dropped |
| PR-G misses real expiry | **CONFIRMED** | cleanup at `blockTimestamp + OFFER_TTL_SECONDS` (state-machine.ts:742); api.ts never filters `metadata_expires_at` (:225, :285 echo only) |
| PR-I projection race | **CONFIRMED** | `midnight-unshielded-spend` keyed on one `(owner,intentHash,outputNo)`, emits `offer_consumed` per archived row inside that transition |
| PR-F misses `getPairs` | **CONFIRMED** | queries.app.ts:640 derives pair rows + `open_count` from a give×want self-join |
| `/v1/pairs` not newest-first | **CONFIRMED** | `ORDER BY open_count DESC, last_traded_at DESC NULLS LAST`, no `pair_key` tiebreaker |
| SSE 1.5× compounds | **CONFIRMED** | metrics.ts:137 enforces `baseline × 1.2` |
| T-E5 via Celestia door | **CONFIRMED** | Celestia carries offer blobs; settlements go via Midnight |
| T-E2 loser observable while live | **CONFIRMED** | archive fires in the same transition as the spend observation |
| Reorg scope + tripwire | **CONFIRMED** | permanent tables are all chain-written; height monotonicity misses same-height replacement |
| PR-D catch-all still open | **REFUTED at tip — but proved the branch finding** | `chainWindowStart` has no `.catch()` and a comment stating the review's own recommendation; the fix was in `18eaa1e`, on #34. The reviewer read #33's real head and was right about it |
| Compose isolation | **Facts true, scope not requested** | → #14, your call |

## Appendix B: deliberately NOT in this queue

- **Celestia inclusion height** stays dropped at the primitive boundary (§6) —
  recoverable offline by scanning the namespace around the NTP window.
- **Batcher dust doom-loop** — fixed upstream in effectstream 0.103.1
  (effectstream#847); bumped and verified in this tree.
- **A `pair_stats` rebuild** — see #10; the ruling removed the need.
