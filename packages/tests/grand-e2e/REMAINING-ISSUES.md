# Remaining issues — plan, test, fix, verify

State as of 2026-08-07, **revised after independent review**. Companion to
[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) (original plan, per-defect
measurements) and [FINDINGS.md](FINDINGS.md) (how we got here).

**Nothing here has been executed.** Every item carries its plan, its red, its fix
and its verification.

Revision note: an independent review found five blocking gaps. All five were
verified against the tree and all five hold — two of them are worse than
reported. One "correction" (PR-D's catch-all) was refuted at the stack tip but
turned out to be an *instance* of blocking finding #0. Verification evidence is
recorded inline so the next reader does not have to re-derive it.

**Second revision — the five-PR stack is now ONE PR
([#35](https://github.com/effectstream/zswap-offerfiles-kernel/pull/35)).** That
dissolved blocking item #0 rather than solving it: the restack was only
necessary because merging bottom-up would land #31 without its marker gate, and
a single atomic PR cannot do that. Also landed: the migration chain is collapsed
into one schema file, and 25 dead generated queries are gone. See §0.1.

---

## 0. The queue at a glance

| # | Issue | Kind | Lands as |
|---|---|---|---|
| ~~0~~ | ~~Review fixes sit on the wrong branches~~ | **RESOLVED** — single PR #35 | see §0.1 |
| **1** | **Cursor key is not failover-safe, and its regression test guards the old key** | **blocking, product** | next commit |
| 2 | Clean full run — nothing verified e2e since PR-B | verification debt | a run |
| 3 | `maxLagBlocks: 1403` unexplained | diagnosis | depends |
| 4 | §2.6 `expiresAt` past at ingestion **+ cleanup still on policy TTL** | product defect | **PR-G** |
| 5 | Cross-offer marker bypass **+ projection race** | product defect | **PR-I** |
| 6 | §2.4 cross-layer offers unenforced | product defect | **PR-E** |
| 7 | §2.5 baskets — **five** market surfaces, not four | product defect | **PR-F** |
| 8 | `/v1/pairs` ordering — **intent undefined**, not a tie bug | product decision | with PR-F |
| 9 | SSE baseline keys absent | measurement | `baseline.json` |
| 10 | `pair_stats` backfill | decision | after #5 and #7 |
| 11 | T-A2 unreachable reject codes | ruling | doc |
| 12 | T-E2 / T-E5 deferred coverage | coverage | suite-only PR |
| 13 | Reorg recovery — **all derived state, not just archives** | production decision | decision + tripwire |
| 14 | Runner is not host-isolated | scope question | **needs your call** |
| 15 | The sweep — the plan's original PR-H | closeout | **PR-J** |

### Execution order

1. ~~#0 restack~~ — **done**, by collapsing the stack into one PR (§0.1).
2. **#1 cursor key** — a product defect on the open PR, not future work.
3. **#2 the run** — first honest verdict; also resolves #3 and measures #9.
4. **#4 PR-G**, then **#5 PR-I** (PR-B's own integrity), **#6 PR-E**, **#7+#8 PR-F**.
5. **#10, #11, #13** decisions — human rulings, can proceed in parallel.
6. **#12 coverage**, then **#15 the sweep** last (precondition: empty defect list).

**Letter map.** The plan's PR-H was the closing sweep; shipped
[#34](https://github.com/effectstream/zswap-offerfiles-kernel/pull/34) took that
letter for the pagination fix. So: marker bypass = **PR-I**, sweep = **PR-J**.

---

## 0.1 RESOLVED — the stack is one PR

The five stacked PRs are now
[#35](https://github.com/effectstream/zswap-offerfiles-kernel/pull/35), a single
branch off main. The problem below was never about *where* the fixes lived; it
was that a bottom-up merge could land PR-B's marker check without its gate. One
atomic PR cannot do that, so the restack became unnecessary rather than done.

Landed with the merge, beyond the five PRs' own content:

- **One schema.** Migrations 001-015 folded into `000-init.sql`; the chain is
  gone. Four columns became NOT NULL and each caught something real — see the
  commit messages on `6ea988d`, `18003cb`, `b7e3169`.
- **015's backfill deleted outright.** It wrote
  `COALESCE(metadata_created_at, created_at, NOW())`, which reintroduced exactly
  the node-local ordering the cursor change exists to remove. That was one of
  the two mechanisms behind issue #1 below; only the `first_seen_at` derivation
  itself remains.
- **25 dead generated queries removed**, and `bun run build:pgtypes` un-broken —
  it had been aborting on a parse error, logging "Skipped", and exiting 0, so it
  regenerated nothing while reporting success. That masked fifteen queries
  defined in both `queries.sql` and `queries.app.ts`.

What did NOT change: the per-PR review verdicts at
`/home/eddie/zswap-offerfiles-kernel-x/PR-3{0,1,2,3,4}-REVIEW.md` still apply to
the corresponding commits, which survive intact in #35's history.

<details>
<summary>Original item #0, kept for the record</summary>

## 0. (superseded) The review fixes are on the wrong branches

**Plan.** Verified: `18eaa1e` and `7dc077e` both sit on `fix/cursor-chain-ordered`
(#34), but their contents belong to three PRs below it:

    18eaa1e  ci.yml, known-red.ts, known-red.test.ts, lib/util.ts,
             contract-offer-files.undeployed.json      → PR-A  (#30)
             trade-data.ts, trade-data.test.ts         → PR-D  (#33)
             queries.app.ts, queries.sql, p7b-audit.ts → PR-B/C (#31/#32)
    7dc077e  migration 014, marker gate + count in queries.app.ts,
             unshielded-fill-vs-cancel.test.ts         → PR-B  (#31)
             migration 015, seed-market.ts             → PR-H  (#34)

Consequence, exactly as reported: a bottom-up merge lands **#31 without its
marker gate and count-aware matching** — i.e. the full-bypass version — and #31
still fails its own standalone review verdict. The stack is only safe if merged
all-or-nothing, which defeats the point of stacking.

**This also explains the one refuted review item.** The review flagged PR-D's
catch-all fallback as still open. At the tip it is *not*: `chainWindowStart`
carries no `.catch()` and an explicit comment saying a catch "would only swallow
GENUINE faults … and silently revert this to the wall clock, which is the exact
bug this function exists to fix." But that fix is in `18eaa1e` — on #34. The
reviewer read #33's actual head and was correct about it. **Not a separate
issue; a symptom of this one.**

**How to test.** Per-PR, at each PR's own head after the restack — that is the
check that was missing:

    git checkout <branch> && bun test packages/database packages/node
    bun build --target=bun packages/tests/grand-e2e/run.ts   # no tsconfig in this repo

Each PR's focused tests must pass **standalone**, not merely at the tip.

**How to fix.** Split the two commits by file and rebase upward:

| Content | Owning PR |
|---|---|
| `known-red.{ts,test.ts}`, `lib/util.ts`, `ci.yml`, contract JSON | #30 PR-A |
| marker gate, `count` matching, migration 014, its unit tests, history indexes | #31 PR-B |
| `queries.sql` stale `UpsertPairStatsByOfferId` | #32 PR-C |
| `trade-data.{ts,test.ts}` uncaught chain-tip lookup | #33 PR-D |
| migration 015, cursor query, `seed-market.ts`, `p7b-audit.ts` cursor bits | #34 PR-H |

`p7b-audit.ts` is touched by both commits and spans concerns — split by hunk, or
if the hunks are entangled, attribute the whole file to the lowest PR that needs
it and let the upper ones rebase cleanly over it.

**How to verify.** Each of the five branches: focused tests green at its own
head; `git diff` between consecutive branches shows only that PR's concern; the
five review verdicts at
`/home/eddie/zswap-offerfiles-kernel-x/PR-3{0,1,2,3,4}-REVIEW.md` re-checked
against the corrected heads. Then one full run at the new tip (#2) — the restack
rewrites history, so the run must happen after, not before.

---

</details>

---

## 1. BLOCKING — the cursor key and its stale regression test

**Plan.** Two defects, one confirmed worse than reported.

**(a) The regression guard tests a query that no longer exists.**
[cursor-pagination.test.ts:144](../../database/cursor-pagination.test.ts:144)
EXPLAINs:

    WHERE (o.created_at, o.id) < (…) ORDER BY o.created_at DESC, o.id DESC
    expect(plan).toContain("idx_offer_file_created_at_id")

Production is now `(first_seen_at, id)` on `idx_offer_file_first_seen_at_id`
([queries.app.ts](../../database/sql/queries.app.ts), `getOpenOffersPage`). The
test would stay green if the production index were **dropped outright**. The
file mentions `created_at` 19 times against `first_seen_at` 6 — it was largely
not migrated. This is the plan-shape guard PR-H's own migration comment relies
on ("a missing index is a test failure rather than a silent slow scan"); that
sentence is currently false.

**(b) The key is not failover-safe, and 015's own comment concedes it.** For a
shielded offer `first_seen_at` comes from `known_roots.first_seen_ms` — the
block in which **this node** first observed the root — so a replica started at a
later `MIDNIGHT_START_BLOCK` orders the book differently. p7a cannot detect it:
`main.grand-b.ts` uses `startBlockHeight 1` on every primitive, so both
instances agree *by construction*. Compounding it: `id` is documented as local
bookkeeping (005-offer-hash.sql), and the 015 backfill is
`COALESCE(metadata_created_at, created_at, NOW())` — reintroducing node-local
values on any DB with pre-012 rows.

Also semantic: `first_seen_at` is proof-root age, not publication time, so
"newest first" is not what the book returns.

**How to test.**

- Fix the guard first: rewrite the EXPLAIN against the **production** key and
  index; sweep the other `created_at` occurrences in the file.
- **Failover test** (the one p7a structurally cannot do): two DBs with the same
  offers but different serial-ID histories (insert in a different order) and
  different Midnight start heights; assert identical page order and that
  paginating across a failover mid-walk skips and repeats nothing.

**How to fix.** Move the cursor to a globally stable publication tuple. Two
candidates:

- **`(celestia_height, offer_hash)` — recommended.** Both chain/content-derived,
  both already NOT NULL, no dependence on sync start or serial assignment.
  `offer_hash` is the MIP-0006 offerId, so ties break identically everywhere.
  Semantically it IS publication order.
- `(metadata_created_at, offer_hash)` — the Celestia block time, closer to
  human "newest", but the column is nullable and needs the same NOT NULL
  tightening 015 applies to `first_seen_at`.

Either way the index and `resolveOfferCursor`'s history probe move with it, and
015's comment gets rewritten — its current text argues for a key we are
abandoning. Keep `first_seen_at` as a served field; it is a fine display value
and a bad sort key.

**How to verify.** New guard EXPLAINs the production key and fails if the index
is dropped; failover test green; full run with p7a determinism identical; the
cursor walk in p8 unchanged. If `(celestia_height, offer_hash)` is chosen,
confirm the archive path copies both onto history rows so mid-pagination
archival still resolves.

---

## 2. The clean full run

**Plan.** One `fresh-run.sh` at the tip **after #0 and #1 land** — running before
the restack measures a tree that will not exist. PR-D and PR-H have never been
e2e-verified; PR-B's review fixes landed after its last green run.

**How to test.**

    ./packages/tests/grand-e2e/fresh-run.sh

Read **`maxLagBlocks` first**. Above ~150 the run is **void, not failed** — go to
#3 and do not debug downstream failures. Historical band: 53–95.

Pre-run hazards, both known: two shutdown orphans (`main.dev.ts` 2260053, PGlite
4135691 holding 5432 — the reaper covers both now), and a reboot re-enabling
system PostgreSQL on 5432 (symptom: `SASL: SCRAM-SERVER-FIRST-MESSAGE` in
`stack.log`).

**How to fix.** Nothing — this item *is* the verification.

**How to verify.** Pass requires all of: `maxLagBlocks` ≤ ~150; 0 failures of
~205; **RED-8 the only expected red**; p7a byte-identical across A and B; the
unshielded cancel shapes green (PR-B's marker gate and count against a live
chain, which no unit test reaches). Record in passing: `/v1/pairs` ordering
result (#8) and CONSUMED-only SSE p50/p95 (#9, sample 1 of 2–3).

---

## 3. `maxLagBlocks: 1403` — the unexplained 15× regression

**Plan.** The last run's 15 failures were one throughput failure counted fifteen
times (FINDINGS §3): the STM fell ~1403 blocks (~23 min) behind, against a 53–95
band. Best hypothesis (FINDINGS §4): **stale processes from hard-killed runs** —
both high-lag runs followed a session kill, and the reaper then covered only the
batcher, dust provisioner and indexer. It now also reaps `main.grand-b.ts`
(load 17 while replaying), `main.dev.ts` and `start-pglite`. If right, the fix
has shipped and #2 confirms it.

**How to test.** #2's run, with the process table verified clean beforehand (the
reaper does this; check its work once, since this run is the hypothesis test).

- ≤150 → hypothesis holds provisionally; one more clean run closes it.
- >150 with a clean table → bisect: (1) same load at PR-B's head — PR-B's own run
  recorded 83, so an intra-stack regression must be in C/D/H, prime suspect
  migration 015's indexes on the offer-file write path; (2) per-phase wall times
  vs a historical green run, to locate *where* lag accumulates; (3) box load.

**How to fix.** By cause only: stale processes → already fixed, close. 015's
history index → drop it; the migration comment already authorises this (unused
by `resolveOfferCursor`, kept for symmetry). Box contention → rerun quiet. Suite
outgrew the dev batcher (one wallet, `maxSlotsPerWallet=1`, ~25 s/tx, ~14 new
on-chain offers) → **provisioning decision**. The standing rule is absolute: do
NOT widen the 3-minute index-wait to make it pass.

**How to verify.** Two consecutive runs inside the historical band. One proves
nothing — the failure was intermittent.

---

## 4. PR-G — §2.6: expiry, advertised *and* actual

**Plan.** Measured: ingested 18:34:20, served `status: live` with `expiresAt`
18:23:36 — expired eleven minutes before arrival. The original plan fixed only
the advertised timestamp. **The review is right that this is half a fix, and the
tree confirms why:**

- Cleanup is scheduled at `data.blockTimestamp + OFFER_TTL_SECONDS`
  ([state-machine.ts:742](../../node/state-machine.ts:742)) — a fixed policy TTL,
  computed independently of the derived expiry.
- `api.ts` never filters on `metadata_expires_at`; it only echoes it (:225,
  :285). Liveness is "row is in `offer_file`, not history".

So correcting the string leaves the offer **in the live book**, still served,
still unfillable. Two phantom classes survive: a superseded root near the end of
its window, and a short unshielded intent TTL.

Root cause is the pattern FINDINGS §2 names — a partial fix creating divergence.
The read gate got the `MAX(height)` escape (the ledger's `past_roots` re-inserts
the current root every block); the derivation and the scheduler did not.

**How to test.** RED-8 ([known-red.ts:67](known-red.ts:67)) already records the
advertised half; XPASS discipline forces PR-G to delete it. Add DB/STM tests
asserting **both** `expiresAt` and the scheduled cleanup time, over five cases
the review names and I agree with:

1. Quiet **current** root — escape applies, expiry anchored at block time.
2. **Superseded** root near the window boundary — no escape, expires early, and
   cleanup must be scheduled early too.
3. **Multiple roots, current + stale** — bounded by the stale one.
4. Short **unshielded intent TTL** — cleanup before policy TTL.
5. Normal case — policy TTL wins, nothing regresses.

**How to fix.** Two coupled changes in
[state-machine.ts](../../node/state-machine.ts):

- **Derivation (~line 612).** Compute a deadline **per root**, then take the
  minimum. Explicitly *not* `MIN(last_seen_ms)` plus a separate is-current flag:
  as the review notes, that lets a current root's freshness extend a superseded
  root's window. Per root: `isCurrent ? max(last_seen_ms, blockTimestamp) : last_seen_ms`,
  `+ ROOT_WINDOW_SECONDS`; then `min(...)`.
- **Scheduling (~line 742).** `future_ms_timestamp = min(derived expiresAt,
  blockTimestamp + OFFER_TTL_SECONDS)`. The policy TTL stays an upper bound;
  the derived expiry can only pull cleanup earlier.

Preserve both existing properties: the value stays a **conservative floor**
(never over-promises fillability) and stays **deterministic on replay** — every
input is a chain fact, so instance B derives identically.

**How to verify.** Unit red→green on all five cases, asserting expiry *and*
schedule; full run with the p8 expiry check green, `KNOWN_RED` **empty**, and
p7a identical (the derivation changed — both instances must change together).
Red→green shown as two commits: red first, then fix + RED-8 deletion.

---

## 5. PR-I — the cross-offer marker bypass, and the projection race

**Plan.** Found in PR-B's review, **still not registered as a red** — which
violates our own discipline. Markers match `(owner, token_type, value)`
correlated only through the settling tx, with no offer scoping: two offers each
wanting 20 UB to the same maker, "settled" by one tx paying 20 **once**, both
read `consumed`. PR-B's count fix closed the *intra*-offer case; this is the
*inter*-offer case.

Two constraints shape the fix:

- **Honest settlements cannot underpay.** A taker-built settlement is a merge,
  and merging preserves declared outputs verbatim, so a tx spending offers X and
  Y carries both payouts. A shortfall can only be constructed by a maker
  re-signing raw spends outside the offer intents. **All-shortfall ⇒ fabrication.**
- **Except duplicates.** Requirement (e)'s duplicates share the SAME input, so
  one payout is the *correct* supply — they are alternatives, not additive.
  Demand counts **per distinct spend-set**.

**The projection race — verified, and it breaks the naive design.**
`midnight-unshielded-spend` is keyed on a single `(owner, intentHash, outputNo)`:
one primitive per output. Each transition archives the offers matching *that
output* and immediately emits `offer_consumed`, whose async listener updates
`pair_stats`. For disjoint offers X and Y settled by one tx, **X's pair-stat
update runs before Y is archived** — before global demand for that tx is even
knowable. A later read-time classification can then call both `cancelled` while
`pair_stats` has permanently counted X. Read-time truth and the write-time
projection diverge with no path back.

**How to test.** New cases in
[unshielded-fill-vs-cancel.test.ts](../../database/unshielded-fill-vs-cancel.test.ts),
first two landed `test.failing` (this repo's unit-red mechanism, cf.
[multileg-pairs.test.ts:82](../../database/multileg-pairs.test.ts:82)):

- **t1 fabrication (red):** X, Y disjoint inputs, one tx, ONE 20-UB payout →
  both `cancelled`. Today both `consumed`.
- **t2 duplicate disable (red):** X, Y sharing one input, one settlement, one
  payout → **exactly one** `consumed`. This is requirement (e). Today both.
- **t3 honest batch (must stay green):** X, Y disjoint, one tx paying 20 twice →
  both `consumed`.
- **t4 unequal alternatives (review's addition, adopted):** same spend-set but
  *different* marker counts / partially overlapping marker tuples — "dedupe by
  spend-set" alone does not say which demand represents the group. Define it:
  the group's demand is the demand of the offer that wins attribution.
- **t5 projection consistency:** drive X and Y's spends as two separate
  transitions and assert `pair_stats` after both — not just final status. The
  test must fail on today's emit-per-transition ordering.
- **t6 shielded twin:** same-input shielded duplicates share a nullifier *and* a
  declared commitment — does one settlement mark both `consumed`? If yes this PR
  grows a shielded half; if no, record why the shape is immune.

**How to fix.** In `unshieldedCancelledPredicate`
([queries.app.ts](../../database/sql/queries.app.ts)), per settling tx and
`(owner, token_type, value)`: supply = matching `unshielded_creates` rows for
that tx; demand = Σ `count` over attributing offers, **deduped by spend-set**;
shortfall ⇒ all `cancelled`. Among same-spend-set duplicates, attribution is
deterministic and — per the review, and consistent with #1 — keyed on
**`(celestia_height, offer_hash)`**, not `(first_seen_at, id)`, which would
repeat exactly the instability #1 exists to remove.

For the race, one of three, in preference order:

1. **Attribute after the full spending tx is known** — cleanest, but needs a
   tx-complete signal the per-output primitive does not give.
2. **Make pair-stat updates idempotently recompute** from final classified
   history rather than incrementing per event — self-healing, and it also fixes
   any historical drift (see #10).
3. **Persist final attribution before emitting** market-data events.

Heavier SQL than the current per-offer correlate; a read-time CTE over "offers
sharing this settling tx" is acceptable — classification is already read-time.

**Stack mechanics:** land PR-I on top of the corrected tip and add a pointer
from PR-B's description, so PR-B cannot merge without the red on record.

**How to verify.** t1/t2/t4/t5 flip `.failing` → `test`; t3 and the existing
nine unshielded cases untouched; t6 resolved either way, in writing. Full run:
unshielded shapes green, determinism holds, and `pair_stats` identical across
A and B — which is what actually proves the race closed.

---

## 6. PR-E — §2.4: cross-layer offers, ruled REJECT

**Plan.** Confirmed reachable, not hypothetical:
[probe-cross-layer.ts](probe-cross-layer.ts) merges a real shielded and a real
unshielded offer via `Transaction.merge` and the result passes our **full**
ladder including `wellFormed`. Ruling (§2.4): REJECT — no support exists for
mixed-type settlement. The route is proven; what remains is the code and the
fixture.

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

- `deriveTokenLegs` nets per (colour, layer), so same colour on two layers is
  two legs and is caught — MIP-0006's own framing.
- Pure function of the offer bytes → identical verdict at both doors and on
  replay. No schema, no STM change.
- Ladder placement: after structural decode, with the leg-shape checks, before
  proof work — same tier as `NOT_A_SWAP`, so verdicts stay stable.

**How to verify.** Unit red→green; e2e fixture red→green with the PR deleting
its own registry entry; full run green including determinism. The probe stays in
tree as documentation of reachability.

---

## 7. PR-F — §2.5: baskets excluded from market data, across FIVE surfaces

**Plan.** Ruled ACCEPT-but-exclude: baskets are sealed pre-agreed settlements —
they live, settle and archive, but contribute nothing to price discovery,
because one settlement was becoming four trades at four prices on pairs nobody
traded. Eligibility (restated RED-5): **at most one give colour and at most one
want colour**.

**The review found a fifth surface, and it is the most visible one.**
`getPairs` ([queries.app.ts:640](../../database/sql/queries.app.ts:640)) builds
live pair rows with a `FULL OUTER JOIN` onto a give×want self-join computing
`open_count`. A 2×2 basket manufactures **four apparent pairs with open counts**
on `/v1/pairs` even with history, charts, mids and `pair_stats` all filtered —
i.e. filtering only the original four leaves the defect visible on the primary
market endpoint.

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

**How to verify.** Unit red→green across all five; e2e fixture green; `pair_stats`
byte-identical across A and B in p7a. Assert the acceptance half survived — the
basket must still archive `CONSUMED`, or the fix overreached the ruling.

---

## 8. `/v1/pairs` ordering — my diagnosis was wrong; the intent is undefined

**Plan.** **Correction.** I previously theorised a tie-breaking bug from
chain-quantised `last_traded_at`. The SQL says otherwise:

    ORDER BY open_count DESC, last_traded_at DESC NULLS LAST

The primary key is **`open_count`**, not recency. So the e2e assertion
(`/v1/pairs is ordered by last_traded_at, newest first`) is testing a contract
the query never promised, and its failure is not necessarily intermittent or
tie-related — the tie theory was built on a misreading. There is also no final
deterministic tiebreaker, so full ties order arbitrarily.

**How to test.** #2's run records the current result, but do not chase it —
first **decide the intended contract**: most-liquid-first (`open_count`, current
behaviour) or most-recently-traded-first (the assertion's claim). Both are
defensible; a market UI usually wants the former with recency as the secondary,
which is what the SQL does. Then align query, assertion and docs, and add a
unit test seeding identical `open_count` *and* identical `last_traded_at` to
prove the tiebreaker.

**How to fix.** Once decided: state the contract in the API docs, correct
whichever of query/assertion disagrees, and append **`pair_key`** as the final
tiebreaker so full ties are deterministic across replicas. Ships with PR-F,
which is already editing this query.

**How to verify.** Assertion matches the documented contract; tiebreaker test
green; `/v1/pairs` byte-identical across A and B in p7a.

---

## 9. SSE baseline keys

**Plan.** `sseDeliveryLagP50Ms` / `sseDeliveryLagP95Ms` are absent from
[baseline.json](baseline.json) **on purpose**: the metric was redefined
(CONSUMED-only; TTL archives reported as a note, since their `archived_at` is a
scheduled block time the STM may reach late during catch-up), so the number must
be re-derived. Honesty note from FINDINGS §4 stands: the split is good hygiene
but is **not proven** to explain the historical spikes — that run was simply
calmer.

**Correction adopted.** My earlier "~1.5× the observed p95" would compound with
the runner's existing tolerance: [metrics.ts:137](metrics.ts:137) enforces
`baseline × 1.2`, giving an effective 1.8× and a gate that catches almost
nothing.

**How to test.** Harvest CONSUMED-only p50/p95 from 2–3 clean runs (#2 is sample
one). Samples from any run failing the `maxLagBlocks` gate are void — that is
the contamination the redefinition exists to exclude.

**How to fix.** Store the **observed** p50 and p95 as-is, with no baked-in
headroom; let the existing 1.2 multiplier be the only tolerance. Record the
source run IDs in the existing `_note` field, which already carries this kind of
provenance.

**How to verify.** The next run gates on the new keys and passes; the scorecard
shows measured values within `baseline × 1.2`.

---

## 10. `pair_stats` backfill — decide AFTER #5 and #7

**Plan.** PR-C fixed `last_price` orientation for new writes; earlier rows keep
the inverted value. Two traps in any recompute, both real: a naive rebuild must
filter `archive_reason = 'CONSUMED'` or it counts cancels as trades
(re-introducing §2.1 through the back door), and `trade_count` is stale relative
to a corrected rebuild, so a partial update produces internally inconsistent
rows.

**Sequencing correction adopted.** This decision must come **after PR-I
(attribution) and PR-F (basket eligibility)** are settled. Rebuilding first
would materialise rows those PRs then declare invalid — basket prints the read
path now excludes, and fill attributions PR-I reverses.

**How to test.** If rebuilding: seed `pair_stats` with wrong-orientation rows
plus a history mixing CONSUMED and non-CONSUMED archives, baskets, and
co-settled offers; rebuild; assert orientation, `trade_count`, volumes and
basket exclusion all consistent — the traps as assertions.

**How to fix.** Two options:

- **(a) Rebuild.** `pair_stats` is a fully derivable write-side projection —
  truncate and repopulate from `offer_file_history` + `offer_file_tokens_history`
  with corrected orientation, both trap filters, PR-F's exclusion and PR-I's
  attribution. Note this is close to PR-I's fix option 2 (idempotent recompute);
  if that ships, this is nearly free.
- **(b) From-zero stance (recommended).** Production deploys from height 1 and
  replays with fixed code — there are no pre-PR-C rows in production, and dev DBs
  are wiped by `fresh-run.sh`. Matches the project's "new system, no migrations"
  stance (014/015 exist because PR-B/PR-H needed *schema*; repairing data
  production will never hold is different). Cost: long-lived dev DBs show wrong
  historical prices until wiped — documented, not repaired.

**How to verify.** (b): a line in ISSUES.md and PR-C's description stating the
stance and scope. (a): the unit test above, then a full run — p7a is the strong
check, since a rebuild diverging from replay-from-zero shows as an A/B diff.

**Needs a ruling from Edward, after #5 and #7.**

---

## 11. T-A2's unreachable reject codes — rule dead code or defence

**Plan.** `NO_SPENDABLE_INPUT`, `UNKNOWN_TOKEN`, `ROOT_UNREADABLE` never fire at
a real gate: the SDK will not build an input-free swap, and every token tag it
emits is `shielded`/`unshielded`/`dust`. All three stay covered at validator-unit
level against doubles. §1.0.1 already names the fork — *a fail-closed branch no
real input can reach is either dead code or a defence against a future wire
format*. This item is choosing.

**How to test.** Reachability is already answered exhaustively; only doubles
reach them. No new tests — unit-double coverage is the right level for a
wire-format defence.

**How to fix.** A ruling recorded in §1.0.1:

- **Keep, documented as fail-closed defence (recommended).** Cheap, tested, and
  they exist precisely for bytes today's SDK cannot produce — which is what a
  hostile or future wire format is. Deleting narrows the fail-closed surface to
  save nothing.
- Delete as dead code — defensible only under a strict no-unreachable-code
  policy this codebase does not otherwise hold.

**How to verify.** Ruling in §1.0.1 with one line of rationale per code; the
unit doubles stay as the permanent floor. Folded into PR-J.

---

## 12. T-E2 / T-E5 — the two deferrals, both re-scoped

**Plan.** Coverage for requirement (e)'s edges, deferred for wallet plumbing.
The review corrected both designs; both corrections are right.

**T-E2, partial overlap.** **Correction:** the loser cannot be observed
"unsettleable while live". `midnight-unshielded-spend` archives *every* matching
offer the moment the shared input is seen spent, so the loser leaves the live
book in the same transition. Test what is actually observable: fund exact UTXOs
{A, B, C}; offer₁ spends {A, B}, offer₂ spends {B, C}; settle offer₁; assert
offer₂ **disappears from the live book**, reads `cancelled` (partial-spend
branch — B consumed elsewhere, C never spent), **cannot settle**, and produces
**no print**.

**T-E5, two takers one coin.** **Correction:** settlements cannot go through the
Celestia door — Celestia carries offer blobs; settlements go through the Midnight
batcher/chain. My earlier suggestion was architecturally wrong. Use **two
independently funded taker wallets** and submit both finalized transactions
concurrently (the dev batcher's single-wallet serialisation is exactly what two
wallets sidestep). Assert: exactly one lands; the loser fails cleanly with the
**batcher/chain double-spend error** — *not* `UTXO_NOT_LIVE`, which is an
offer-ingestion API code and would be the wrong assertion; the offer archives
`CONSUMED` exactly once; exactly one print.

**How to fix.** Nothing, unless they find something.

**How to verify.** New checks green on a full run; §1.0's rows flip ⛔ → ✅. Lands
as one suite-only PR in the PR-A tradition (no product code).

---

## 13. Reorg recovery — wider than archives, and a better tripwire

**Plan.** Named out of scope in §6 but it blocks the word "production": archival
is destructive by design ([state-machine.ts:55](../../node/state-machine.ts)) —
a reorged-out consuming block means the offer cannot be restored without full
resync.

**Two corrections adopted, both material.**

- **Scope.** A fork contaminates far more than archives: `nullifiers`,
  `commitments`, `unshielded_creates`/`unshielded_spends`, `known_roots`, and
  Celestia offer insertions are all permanent-by-design records written from
  chain events. Buffering only destructive archives leaves every one of those
  corrupted.
- **The tripwire I proposed is too weak.** Global STM height monotonicity cannot
  detect a **same-height source-block replacement** — the most common reorg
  shape. Validate **parent/hash continuity in the sync layer**, where the block
  identity is still available.

**How to test.** Fact-find first: can the effectstream feed, as this indexer
consumes it, deliver a reorg — a height seen twice, a height going backwards, or
the same height with different content? Celestia finality is single-slot once
included; the open question is what the L2 feed guarantees between inclusion and
our STM input.

**How to fix.** By what fact-finding returns:

- **Finalized-only (likely):** record the invariant and add the **parent-hash
  continuity check in the sync layer**, halting loudly on violation. Halting is
  correct: proceeding destructively archives against a fork, and a halted indexer
  is recoverable where a corrupted one is not.
- **Feed can reorg:** buffer the **complete source stream** before STM
  application — not just archives — by an N-block confirmation depth sized to
  the feed's actual reorg depth. Real design work: the buffer interacts with TTL
  scheduling and index-wait budgets.
- Soft-archive/tombstones: heavyweight third option, not recommended unless the
  buffer proves insufficient, since it reopens the history schema.

**How to verify.** Finalized-only: invariant documented, continuity check
unit-tested (feed a same-height different-hash block, assert the halt).
Buffered: boundary tests plus a full run confirming TTL scheduling and
index-wait budgets survive N. Either way §6's row becomes "decided: <what>",
with owner and date.

**Needs a ruling from Edward once fact-finding lands.**

---

## 14. Runner host isolation — needs your call

**Plan.** Raised by the review; **not adopted into the critical path**, because
no isolation model was requested for this work. The underlying facts are true:
`fresh-run.sh` binds fixed host ports (PGlite on 5432, the stack's service
ports) and reaps by `pkill` pattern, so a concurrent run or an unrelated host
process sharing a name collides. That is exactly how the system-PostgreSQL
collision and the `pkill` self-kill (exit 144) cost time already (FINDINGS §5).

**The question for you:** is single-run-per-box acceptable, or should the suite
be isolated? Options, ascending cost: document the constraint and add a
**preflight port check** (turns six wasted minutes into one clear line —
already wanted independently in FINDINGS §5); parameterize every port via env;
or a full Compose wrapper with its own network.

**Recommendation:** preflight check now (cheap, addresses the actual observed
pain), defer Compose unless you want concurrent runs. **Do not** let this block
#2 — the box is currently dedicated.

---

## 15. PR-J — the sweep (the plan's original PR-H)

**Plan.** The closing chore the letter collision orphaned. End state: **zero
expected failures anywhere**. Preconditions: PR-E, PR-F, PR-G, PR-I merged and
the #11 ruling made. Skipping it leaves a registry that tolerates reds forever —
the exact failure mode XPASS exists to prevent.

**How to test.** The suite's own guards: [known-red.test.ts](known-red.test.ts)
keeps the registry well-formed; the scorecard's expected-red section must render
empty.

**How to fix.** `KNOWN_RED` should already be empty (each fix PR deletes its own
entry; PR-G takes RED-8, the last) — the sweep **verifies** emptiness, and
anything remaining is a fix PR that skipped its paperwork. **Keep the
mechanism** (`known-red.ts`, its test, the `check()` branch): it is the
discipline for the next defect and costs nothing empty; deleting it (the plan's
original wording) would force reinventing it. Sweep `test.failing` markers
repo-wide. Close the documents: §1.0 all-✅/ruled, the six §2 defects marked
fixed with PR numbers, FINDINGS gains a closing section, ISSUES.md updated, this
queue emptied or archived.

**How to verify.**

    grep -rn "test\.failing" packages/ | wc -l   # → 0

plus `KNOWN_RED` entry count 0, and one final full run: ~205+ checks, 0
failures, 0 expected reds, determinism identical — the run that says
production-ready out loud.

---

## Appendix A: review findings — verification record

Verified against the tree rather than accepted on report.

| Finding | Verdict | Evidence |
|---|---|---|
| Fixes on wrong branch | **CONFIRMED** | `18eaa1e`/`7dc077e` on `fix/cursor-chain-ordered`, touching PR-A/B/C/D files |
| PR-H not failover-safe | **CONFIRMED, worse** | test at cursor-pagination.test.ts:144 guards `idx_offer_file_created_at_id` and `(created_at, id)`; production uses `first_seen_at`. Guard passes if the real index is dropped |
| PR-G misses real expiry | **CONFIRMED** | cleanup at `blockTimestamp + OFFER_TTL_SECONDS` (state-machine.ts:742); api.ts never filters `metadata_expires_at` (:225, :285 echo only) |
| PR-I projection race | **CONFIRMED** | `midnight-unshielded-spend` keyed on one `(owner,intentHash,outputNo)`, emits `offer_consumed` per archived row inside that transition |
| PR-F misses `getPairs` | **CONFIRMED** | queries.app.ts:640 derives pair rows + `open_count` from a give×want self-join |
| `/v1/pairs` not newest-first | **CONFIRMED** | `ORDER BY open_count DESC, last_traded_at DESC NULLS LAST`, no `pair_key` tiebreaker. My tie theory was a misreading |
| SSE 1.5× compounds | **CONFIRMED** | metrics.ts:137 enforces `baseline × 1.2` |
| T-E5 via Celestia door | **CONFIRMED** | Celestia carries offer blobs; settlements go via Midnight. My design was wrong |
| T-E2 loser observable while live | **CONFIRMED** | archive fires in the same transition as the spend observation |
| Reorg scope + tripwire | **CONFIRMED** | permanent tables are all chain-written; height monotonicity misses same-height replacement |
| **PR-D catch-all still open** | **REFUTED at tip — but proves finding 1** | `chainWindowStart` has no `.catch()` and a comment stating the review's own recommendation; the fix is in `18eaa1e`, on #34. The reviewer read #33's real head and was right about it |
| Compose isolation | **Facts true, scope not requested** | → #14, your call |

## Appendix B: deliberately NOT in this queue

- **Celestia inclusion height** stays dropped at the primitive boundary (§6) —
  recoverable offline by scanning the namespace around the NTP window.
- **Merging the five PRs** — mechanical once #0, #1 and #2 are done; bottom-up,
  each merge preceded by its review verdict re-checked against the corrected head.
- **Batcher dust doom-loop** — fixed upstream in effectstream 0.103.1
  (effectstream#847); bumped and verified in this tree.
