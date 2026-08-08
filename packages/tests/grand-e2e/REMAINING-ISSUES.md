# Remaining work — the four open defects, and what production still needs

**#35 IS MERGED** (2026-08-08, `f298123`). The merge goal is met; this document
is now the register of what is left.

State as of 2026-08-08. Companion to
[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) (original plan, per-defect
measurements) and [FINDINGS.md](FINDINGS.md) (how we got here — §0 is the
current addendum).

## What shipped, and what the merge gate did not wait for

Banked, verified by the 2026-08-07 run (205 checks, 1 failure, `maxLagBlocks`
113, determinism identical across replicas):

| fixed | was |
|---|---|
| §2.1 unshielded fill-vs-cancel | a maker's self-transfer recorded as a completed sale — 9 trades vs 4 real, volume 13009 vs 5009 |
| §2.2 `last_price` inverted | wrong for half of all trades |
| §2.3 24 h window | bounded on `NOW()` against chain-derived `archived_at` |
| pagination on wall clock | replicas served different page orders, invisible to the determinism diff by construction |

Plus the schema collapse, 25 dead queries removed, un-broken pgtyped codegen, a
suite grown 143 → 205 checks, and **A1** (the `bookReadP95Ms` gate now measures
the median, so it can fail honestly).

**Two of the three pre-merge items did not land, and that is worth stating
plainly rather than quietly reclassifying:**

- **A2 — the cross-offer marker bypass was never registered as a red.** It is
  still a defect described only in markdown. It is now folded into #5, which has
  a designed fix, so it lands as that item's red rather than as standalone
  paperwork.
- **A3 — doc reconciliation is partial.** The refuted-premise sweep landed
  (`9b71b8c`), but **PRODUCTION-READINESS.md's (a)–(f) status table still
  describes the pre-work state** and §2.1/§2.3 headers do not say FIXED. That
  table is the first thing a newcomer reads, and it currently understates the
  system by four fixed defects. Now item #19.

**Still not production-ready.** Four product defects remain, three of them
market-data integrity, plus an undecided reorg policy. RED-8 stays registered so
the suite keeps failing honestly on §2.6.

---

## What to do next, in order

1. **#4 (PR-G, §2.6 expiry)** — smallest, its red is already registered, clean
   red→green, and it empties `KNOWN_RED`. Good first move on the new main.
2. **#5 (exact-identity markers)** — the highest-value item. It is the only
   *fabrication* defect (one payment → two recorded sales, attacker-chosen), and
   the design now **deletes** machinery rather than adding it. Confirmed on real
   data 2026-08-08: **7 of 7 payouts across 4 settled offers matched
   `(owner, intentHash(0), output_no)` exactly, with zero counterexamples.**
   Remaining unknown: every sampled offer used `guaranteed` sections, so the
   fallible-section case is still untested — cover it in the fixture.
3. **#6 (§2.4 cross-layer)** then **#7/#8 (§2.5 baskets + the pairs contract)** —
   both need fixtures built, not just code.
4. **#19 (finish A3)** — cheap, and the stale table actively misleads.
5. **#13 (reorg)** — needs a ruling, and by §6's own terms it blocks production.
6. **#16**, **#12**, then **#15 (the sweep)** last — its precondition is an empty
   defect list.

**Off the critical path, needing a human not code:** #8's ordering contract,
#11's dead-code-vs-defence ruling, #13, #14.

Items #1, #2, #3, #10, #17 and #18 are **done**.

---

## How this document got here

Kept because several entries below are *corrections* — the reasoning matters more
than the conclusion, and a future reader should know which claims were tested and
which were merely plausible.

Three revisions are folded in: an independent review that found five blocking
gaps (all verified, all held, two worse than reported); the ruling that
**breaking changes are free — nothing is deployed, and no retro-compatible
change is wanted anywhere**; and a **second independent review of this file**,
whose four blocking findings all held on verification. That second review is
worth summarising, because three of its findings were fixes that would not have
worked:

- the proposed pgtyped CI guard **passes in exactly the case it exists to catch**
  (#16);
- PR-I's attribution rule **cancels a legitimate settlement** (#5, t4);
- PR-G still let advertised expiry and actual deletion disagree, just inverted
  (#4);
- and T-E5's "two wallets" plan **would not have been concurrent at all** (#12).

It also closed #17 outright by finding the grammar file, and corrected a batcher
capacity number I had been reasoning from (#3).

**Fourth revision — THE CLEAN RUN LANDED.** 2026-08-07, 205 checks, **1 failure**,
72.7 min, `maxLagBlocks` **113** (under the 150 threshold, so this is a verdict
rather than a void run). Both determinism checks passed: a second node replayed
~4400 blocks from height 1 and produced byte-identical state. That verifies the
collapsed schema, the four NOT NULL tightenings, the deleted 015 backfill and
the new cursor key across replicas — none of which a unit test can establish.

The single failure is a metric artefact, not a defect (new item #18). RED-8 fired
correctly and XPASS was 0, so nothing shipped without its paperwork. Items #1 and
#2 are closed; #3's fix is proven in the field.

**Fifth revision — the marker-bypass premise fell to an experiment.** Edward
challenged #5's design: settlement is Midnight-only (so `celestia_height` had no
business in it), and unshielded outputs are MORE visible than shielded ones, so
classification should be simpler, not weaker. Both points held. Probing the
clean run's database showed per-party intents survive `Transaction.merge` and
the maker payout's creating intent equals **`intentHash(0)` of the offer's own
published intent** — refuting the "unknowable at publish" claim in the schema
and derive.ts (both now annotated in-code). #5's fix collapsed from a
feasibility-assignment design to **exact UTXO-identity markers**, the direct
analogue of shielded commitments; the counting, dedup and tiebreaker apparatus
was deleted rather than repaired. FINDINGS.md §0(4) records the experiment.

---

## 0. The queue at a glance

Ordering is in "What to do next" above. `—` = done.

| # | Issue | Kind | State |
|---|---|---|---|
| ~~1~~ | ~~Cursor key not failover-safe~~ | **RESOLVED** — key moved, guard proven | — |
| ~~2~~ | ~~Clean full run~~ | **DONE** — 205 checks, 1 fail, lag 113 | — |
| ~~3~~ | ~~`maxLagBlocks: 1403`~~ | **DIAGNOSED + MITIGATED** — external contention; CPU reservation holds | — |
| **4** | §2.6 `expiresAt` past at ingestion **+ cleanup on policy TTL** | **product defect — next** | open |
| 5 | Cross-offer marker bypass — **fix known: exact-identity markers** | product defect | open |
| 6 | §2.4 cross-layer offers unenforced | product defect | open |
| 7 | §2.5 baskets — **five** market surfaces | product defect | open |
| 8 | `/v1/pairs` ordering — contract undefined | product decision | open |
| 9 | SSE baseline keys absent | measurement | open |
| 10 | ~~`pair_stats` backfill~~ | **RESOLVED** — no-retrocompat ruling | — |
| 11 | T-A2 unreachable reject codes | ruling | open |
| 12 | T-E2 / T-E5 deferred coverage | coverage | open |
| 13 | Reorg recovery — **all derived state** | production decision | open |
| 14 | Runner not host-isolated | **disputed premise** | open |
| 15 | The closing sweep | closeout | open |
| 16 | pgtyped regeneration can silently break again | new — no guard | open |
| 17 | ~~`outputIndex ?? outputNo` shim~~ | **RESOLVED** — grammar confirmed, shim removed | — |
| ~~18~~ | ~~`bookReadP95Ms` gate unfalsifiable at count=10~~ | **DONE** — median now carries the gate | — |
| **19** | **PRODUCTION-READINESS (a)–(f) table still describes the pre-work state** | stale docs (ex-A3) | open |

### Order of work

**To merge:** A1 (#18) → A2 (register the marker-bypass red) → A3 (docs) → one
full run at 205/0 → merge.

**After merge**, by value: #4 (§2.6, smallest, red already in the scorecard) →
#5 (PR-B's own integrity, and A2 will already have written its red) → #6 §2.4 →
#7/#8 §2.5 + the pairs contract. #16 is small and independent, pick it up any
time. #12's coverage, then #15's sweep last — its precondition is an empty
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

## 1. RESOLVED — the cursor key and its stale regression test

**Done 2026-08-07** (commit `4af3fe6`). The key is `(celestia_height,
offer_hash)`; `getOpenOffersPage`, `resolveOfferCursor`, the api.ts plumbing and
the index all moved together, and `idx_offer_file_created_at_id` plus both
`first_seen_at` indexes were dropped — `first_seen_at` is now written and served,
never ordered or filtered.

**The guard was proven, not asserted.** With the index the page plans as an index
scan at cost 1.16; with it dropped, cost 1e10 and a Sort node appears — so both
assertions fail. That is what the previous guard could not do, and it is why the
schema comment about a missing index being a test failure is now true.

**Verified end to end:** p7a passed both determinism checks on the 2026-08-07 run
(`replayed state identical`, `offer_hash sets identical`), so the new key
reproduces across replicas. The new failover unit test — mirrored SERIAL ids, a
9-day-later `first_seen_at` — covers the case p7a structurally cannot.

<details>
<summary>Original analysis, kept for the record</summary>

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

</details>

---

## 2. DONE — the clean full run

**2026-08-07: 205 checks, 1 failure, 72.7 min, `maxLagBlocks` 113.** Under the
150 threshold, so this is a verdict rather than a void run.

| result | |
|---|---|
| **p7a determinism** | **both checks PASS** — replayed state identical, offer_hash sets identical |
| RED-8 | fired correctly (§2.6, PR-G) |
| XPASS | **0** — nothing shipped without deleting its paperwork |
| unshielded cancel shapes | all green — PR-B's marker gate + count against a live chain |
| `queue depth >= 4` | passed (it FAILED in the compromised run — corroborates that starvation, not the batcher, was the cause) |
| submit p95 | 6823 vs 6654 x 1.2 — ok |
| publishToIndexed p95 | 22458 vs 23983 x 1.2 — ok |
| SSE (CONSUMED-only) | p50 1830, p95 2308, count 21 — see #9 |
| the one failure | `bookRead p95 42 > 24` — a metric artefact, see #18 |

**What this closes:** PR-C, PR-D and PR-H are e2e-verified for the first time, as
are PR-B's two review fixes. The determinism pass is what actually validates the
collapsed schema, the four NOT NULL tightenings, the deleted 015 backfill and the
new cursor key — all across replicas, which no unit test reaches.

**Two caveats worth keeping visible.** `maxLagBlocks` 113 is above the old 53–95
band, explained by the slow genesis funding phase and a competing workload during
the first ~20 minutes. And the SSE sample was taken on that same partly-contended
box, so treat it as soft (#9).

<details>
<summary>Original plan for this item</summary>

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

</details>

---

## 3. DIAGNOSED — the lag is external box contention, caught in the act

**Cause established 2026-08-07, by direct observation during an aborted run.**
Candidate 1 of the three ("box contention from something outside the suite") is
correct. The stale-process hypothesis was wrong — the process table was verified
clean before this run started.

What was measured, live:

| t | load (1m) | state |
|---|---|---|
| pre-run | 4.38 | quiet |
| +5m | 6.96 | healthy, 15 checks |
| +10m | 15.77 | healthy, 64 checks |
| +15m | 75.23 | ~12 `rustc` processes appear; progress drops to +3 checks |
| +20m | 104.45 | `rustc` gone, replaced by a Node crash-test suite at 207% CPU |

The culprit was never ours: a **Codex sandbox** (`codex-linux-sandbox
--sandbox-policy-cwd /home/eddie/umbradb-fork`) running a cargo build, then that
project's crash-integration tests, on the same 16-core box. Our own processes
stayed modest throughout (proof-server 132%, run.ts 10.9%, batcher 10.1%).

**The decisive symptom, and the one to check first in future:** the Celestia
chain tip stopped advancing — 1565 for over five minutes, against a ~6 s block
time. That is not the indexer lagging; the local chain node itself was starved of
CPU. Once that happens no index-wait budget can be met and every downstream check
fails for the same non-reason, which is precisely the fifteen-failure cascade of
2026-08-06.

This explains both properties that made it so hard to pin down: it is
**intermittent** because it depends on what other sessions happen to be doing,
and it **never reproduced under analysis** because the competing work had
finished by the time anyone looked.

**Consequence for #2:** a run needs a quiet box, and "quiet" must be *verified*,
not assumed. Before starting, check the load average AND that the chain tip is
advancing; during the run, treat a stalled tip as an immediate abort rather than
letting it burn an hour producing a scorecard that reads like a product failure.

### MITIGATED — the CPU reservation works

The 2026-08-07 rerun was launched inside a user-slice cgroup:

    systemd-run --user --scope --unit=grand-e2e-run2 \
      -p CPUWeight=500 -p CPUQuota=1200% ./packages/tests/grand-e2e/fresh-run.sh

Two knobs doing opposite jobs. **CPUWeight=500** (default 100) is the protective
half — it only matters under contention, giving the stack 5x the share of a
default-weight neighbour, which is what should keep the chain node producing
blocks. **CPUQuota=1200%** is the polite half: a ceiling at 12 of 16 cores, so at
least 4 are always left for everything else and we are never the neighbour that
ruins someone else's run.

Verified at the kernel, not merely requested: `cpu.weight 500`, `cpu.max 1200000
100000`, 26 processes inside the scope. Cost measured mid-run: **0.159% of CPU
time throttled** (3.0s of 1890s), so the ceiling is correctly sized and raising
it would buy nothing. Result: `maxLagBlocks` 113, load never above ~8.5 even
during the p7a replay.

**Honest limits.** This is a *share* guarantee, not isolation — if something
saturates the box badly enough, 5x of very little is still very little. It should
convert "chain stops producing blocks" into "run is somewhat slower". It is not a
substitute for a quiet box, and it does not cover the Midnight proof-server,
which is a long-lived devnet process outside the scope.

Incidental finding: `nice_usec` was 1732s of 1752s of user time — essentially the
whole stack runs niced. Between cgroups `cpu.weight` overrides that, so the
reservation stands; but it does mean that *before* this change, under contention,
our processes were voluntarily yielding to every non-niced neighbour. That is
part of why the chain node was so easy to starve.

**How to test.** #2's run, with the process table verified clean first.

- ≤150 → hypothesis holds provisionally; one more clean run closes it.
- >150 with a clean table → bisect: (1) same load at PR-B's commit — it recorded
  83, so an intra-branch regression must be later; the new index set on the
  offer-file write path is the prime suspect; (2) per-phase wall times against a
  historical green run, to locate *where* lag accumulates; (3) box load.

**How to fix.** By cause only. Stale processes → already fixed, close. A new
index on the write path → drop it (the history `first_seen_at` index is already
marked droppable in the schema comment). Box contention → rerun quiet. Suite
outgrew the dev batcher (~25 s/tx, ~14 new on-chain offers) → **provisioning
decision**. The standing rule is absolute: do NOT widen the 3-minute index-wait
to make it pass.

**Correction on batcher capacity — do not reason from either configured value.**
Earlier notes said `maxSlotsPerWallet=1`; that is the code DEFAULT
([config.ts:86](../../batcher/config.ts:86)), while
[start-stack.sh:28](start-stack.sh:28) exports **7**. Neither is the real
concurrency: [config.ts:14](../../batcher/config.ts:14) computes
`min(floor(dustUtxoCount / costPerTx), maxSlotsPerWallet)`, so **available dust
bounds it** and the effective number can be anything from 1 to 7 run to run.
Record the batcher's startup `worker slots: N` line as a run artefact and reason
from that. (Note `wallets.ts` still describes "the single worker" in a comment —
written against the default, and now misleading.)

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
  ROOT_WINDOW_SECONDS`; then `min(...)` → call it `layerDeadline`.
- **ONE value, used twice.** Applying the policy minimum only to the scheduler
  reopens the defect from the other side: if the policy TTL is SHORTER than the
  derived deadline, the API advertises an expiry later than the actual deletion
  — still a lie, just inverted. So compute

      effectiveExpiresAt = min(layerDeadline, blockTimestamp + OFFER_TTL_SECONDS)

  store *that* in `metadata_expires_at`, and schedule cleanup (~line 742) at the
  *same* value. The advertised expiry and the actual deletion are then the same
  fact by construction, not by two calculations that happen to agree.

Preserve both existing properties: the value stays a **conservative floor**, and
stays **deterministic on replay** — every input is a chain fact.

**How to verify.** Unit red→green on all five cases, each asserting **equality
between the stored `metadata_expires_at` and the scheduled cleanup timestamp** —
that equality is the invariant, and testing the two independently is what let
them drift in the first place. Then a full run with p8's expiry check green,
`KNOWN_RED` **empty**, p7a identical. Land as two commits: red first, then fix +
RED-8 deletion.

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
- **t4 unequal alternatives:** same spend-set, earlier alternative declares TWO
  identical 20-UB markers, later declares ONE, settlement supplies ONE — assert
  the later one reads `consumed`. (Historically this was the counterexample
  that killed the naive-ordering design; under exact-identity markers it is
  simply true by construction — only the executed intent's identities appear —
  so it lands as a green regression test, not a red.)
- **t5 projection consistency:** drive X and Y's spends as two separate
  transitions and assert `pair_stats` after both, not just final status. Must
  fail on today's emit-per-transition ordering.
- **t6 shielded twin:** same-input shielded duplicates share a nullifier *and* a
  declared commitment — does one settlement mark both `consumed`? If yes this
  grows a shielded half; if no, record why the shape is immune.

**How to fix — REWRITTEN 2026-08-07 after a decisive experiment.** Edward's
challenge: shielded classification is exact because we look at the offer's own
commitments; unshielded outputs are fully transparent, so it should be simpler,
not weaker. He is right, and the experiment proves it.

**The premise under the whole shape-matching design is false.** The schema and
[derive.ts:128](../../validator/derive.ts:128) both claim markers cannot use
intent hash / output index because "those belong to the SETTLING intent, which
the maker cannot know when publishing." Tested against the completed run's
database (offer #3, settled by tx `f2516323…`):

    on-chain creates in the settling tx:
      intent 4352e3ac04bf -> taker's outputs        (2 rows)
      intent a5de78c39d90 -> MAKER PAYOUTS          (2 rows)
    published blob carries 1 intent:
      intentHash(0) = a5de78c39d90   <== MATCHES ON-CHAIN

Two facts, both contrary to the comment: **per-party intents survive the merge
verbatim** (every two-party settle in the run shows 2 intents / 2 owners), and
**the payout's creating-intent hash is `intentHash(0)` of the offer's own
intent** — computable from the blob at ingestion, before any settlement exists.
(`intentHash` is segment-parameterised and the published intent sat at segment
1, yet identity uses `0` — UTXO identity is segment-layout-independent, which is
exactly what makes it knowable in advance.)

**So the fix is exact-identity markers — the true unshielded analogue of
commitments:**

1. At ingestion, for each intent in the offer and each unshielded output at
   index `i`: expected UTXO identity = `(owner, intentHash(0), i)`. Store THOSE
   in `offer_file_unshielded_outputs` (keep type/value for display/audit).
2. Branch 3 of `unshieldedCancelledPredicate` becomes: cancelled unless every
   declared identity exists in `unshielded_creates`. Identity is globally
   unique, so the settling tx correlation is corroboration, not the key.
3. Correct the refuted comments in derive.ts and the schema.

What this dissolves — the entire apparatus the review and I designed for the
fungible-shape world:

- **The bypass dies by construction.** A different offer has a different intent,
  hence different identities; forging X's payout identity requires executing X's
  intent, and executing it IS paying — atomically, inputs and outputs together.
- **No demand/supply counting, no spend-set dedup, no feasibility assignment,
  no tiebreaker.** Attribution stops being a choice. (Edward's point (A) lands
  here too: `celestia_height` had no business in a Midnight settlement question
  — and with exact identities, nothing orders anything.)
- **Requirement (e) resolves itself.** Two offers sharing an input via two
  DIFFERENT intents: settlement executes one intent, so exactly one offer's
  identities appear on chain → it reads consumed, the other cancelled. No rule
  needed.
- **The projection race narrows to nothing structural.** Classification no
  longer depends on other offers' state — only on chain rows from the settling
  block, which commit in one DB transaction (the 008 argument). t5 stays as the
  proof, not as the driver of a design.

Residual, honestly stated: two byte-different wrappers embedding the LITERALLY
same intent share identities and would both read consumed off one settlement.
They are the same atomic swap listed twice; if that matters, dedupe by intent
hash at ingestion. Record as a note in the fix, not a blocker.

**CONFIRMATION PROBE — RUN 2026-08-08, design holds.** Every settled unshielded
offer in the clean run's database (9 of them) checked, not one sample:

| | offers | payouts | identity matched |
|---|---|---|---|
| had payouts | 4 | 7 | **7 / 7** |
| walk-aways | 5 | 0 | n/a — nothing to match |

**Zero counterexamples**: no case where a payout existed and its identity failed
to match `(owner, intentHash(0), output_no)`. The five zero-payout offers have no
create matching their markers ANYWHERE in the database, not merely in the
settling tx — they are genuine walk-aways, i.e. the cancels this predicate
exists to catch. (The probe's own verdict line initially called those five
"mismatches"; that was a bug in the probe — `payouts > 0 && …` treated "nothing
to identify" as failure. The data was always clean.)

**The one gap that survives:** all 9 sampled offers declared outputs in
`guaranteed` sections only. **The fallible-section case is still untested**, so
the fixture must cover it — that is now the only unknown in this design.

**How to verify.** t1/t2/t5 flip `.failing` → `test` (t4's unequal-alternatives
counterexample dissolves with the counting design — keep it as a green test that
the executed alternative reads consumed); t3 and the existing nine unshielded
cases untouched; t6 re-checked (shielded side is already identity-exact, which
is now the symmetric design, not a divergence). Full run: unshielded shapes
green, determinism holds, `pair_stats` identical across A and B.

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

**How to test.** #2's run records the current *behaviour*, but it cannot settle
this — **a run measures what the query does, not what the API should promise.**
This needs an explicit ruling before query, docs and assertion change:
most-liquid-first (current behaviour) or most-recently-traded-first (the
assertion's claim). Once ruled, add a unit test seeding identical `open_count`
*and* identical `last_traded_at` to prove the tiebreaker.

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

**Sample 1 of 2–3, captured 2026-08-07:** `p50 1830, p95 2308, max 2785,
count 21` (CONSUMED-only, as redefined). **Treat as soft.** The run passed the
`maxLagBlocks` gate at 113, so it is not void — but a competing workload had the
box for its first ~20 minutes and `maxLagBlocks` came in above the historical
53–95 band. Do not populate the keys from this sample alone.

**How to test.** Harvest CONSUMED-only p50/p95 from 2–3 clean runs. Samples from
any run failing the `maxLagBlocks` gate are void; samples from a run with known
contention are usable but should not be the only input.

**How to fix.** No baked-in headroom: [metrics.ts:137](metrics.ts:137) already
enforces `baseline × 1.2`, so a further ~1.5× would compound to 1.8× and gate
almost nothing. "Observed as-is" was underspecified for a multi-run sample —
state the rule: **take the MAXIMUM per-run p50 and the maximum per-run p95
across all valid clean runs**, and let the existing 1.2 supply the tolerance.
Max, not mean: the baseline must not go red on the noisiest run we already
consider healthy. Record the source run IDs in the existing `_note` field, which
already carries this kind of provenance.

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
batcher/chain. Assert: exactly one lands; the loser fails cleanly with the
**batcher/chain double-spend error** — *not* `UTXO_NOT_LIVE`, which is an
offer-ingestion API code and would be the wrong assertion; the offer archives
`CONSUMED` exactly once; exactly one print.

**Two wallets are NOT enough to make it concurrent, and the earlier plan was
wrong to assume so.** Every `/send-input` is chained through one module-level
`balancerChain` in
[wallets.ts:216](actors/wallets.ts:216) — a *client-side* serialisation whose own
comment says concurrent POSTs can sit unanswered past any sane fetch timeout —
and `settleOffer` submits through exactly that path
([wallets.ts:798](actors/wallets.ts:798)). Two funded wallets still queue behind
each other. The test therefore needs:

- a deliberate **concurrent submission helper that bypasses `balancerChain`**,
  used only by this fixture;
- proof the batcher really has ≥2 worker slots (see #3 — read the startup
  `worker slots: N` line, do not assume);
- proof **both requests were in flight before the first receipt**, otherwise the
  test passes while having proved nothing about the race.

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
- **The obvious tripwire is too weak, and so was the first correction to it.**
  Global STM height monotonicity cannot detect a same-height replacement — but
  neither will the indexer ever *see* one: the fetch loop is sequential and
  resumes at `lastHeight + 1`, so a replaced height is simply never re-requested.
  The observable signature is **discontinuity**: block `h+1` whose parent is not
  the hash we stored for `h`. Validate **parent/hash continuity in the sync
  layer**, where block identity still exists.

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
unit-tested against the shape the fetch loop can actually produce — store block
`(h, hashA)`, then feed `h+1` whose parent is **not** `hashA`, and assert the
halt; plus a broken-continuity case *inside* a single fetched batch.

**Known gap in that coverage, and it needs an upstream change:** Midnight
exposes parent hashes, but effectstream's current Celestia output discards
parent identity, so a continuity check can only cover one of the two sources
today. Covering Celestia means an upstream sync change — size that before
promising the check is complete.

Buffered: boundary tests plus a full run confirming TTL scheduling and
index-wait budgets survive N. Either way §6's row becomes "decided: <what>".

**Needs a ruling once fact-finding lands.**

---

## 14. Runner host isolation — needs your call

**Plan.** **Disputed premise — needs Edward to settle it.** Two independent
reviews state that Docker Compose was explicitly requested "where practical, to
avoid host-port collisions", and that a host-bound `fresh-run.sh` should
therefore not be the default. I cannot corroborate that: there is no such
request in this conversation, no `CLAUDE.md`/`AGENTS.md` in the repo, no
`docker-compose*`/`compose.y*ml` anywhere in the tree, and nothing in project
memory. It may well come from a session or instruction I do not have — which is
exactly why this should not be silently adopted *or* silently dismissed.

**If the request is real, this is not a "scope question" but a standing
requirement, and #2 should not run host-bound until a Compose wrapper exists or
it is documented why it cannot.** If it is not, the recommendation below stands.

**Evidence has since arrived, and it favours the reviewers.** The 2026-08-07 run
was destroyed by a foreign workload on the same box — a Codex sandbox building
and testing `umbradb-fork` — which starved the local chain node until it stopped
producing blocks (see #3). Whatever was or was not requested earlier, this box
demonstrably hosts concurrent agent sessions, and the suite has now lost two runs
to that. Port collisions were only the visible half of the problem; **CPU
contention is the half that actually voids results**, and a Compose wrapper with
its own network does not fix that on its own — it needs a CPU reservation, or a
dedicated box, or a preflight that refuses to start on a loaded machine.

Cheapest thing that would have saved both runs: **a preflight gate** that
refuses to start when the 1-minute load average is above a threshold, plus the
in-run stalled-tip abort from #3. Neither requires Compose.

The underlying facts are true either way: `fresh-run.sh` binds fixed
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
concurrent runs.

**PARTIALLY ADDRESSED 2026-08-07.** A CPU reservation is now in use (see §3):
`systemd-run --user --scope -p CPUWeight=500 -p CPUQuota=1200%`, verified at the
kernel and costing 0.16% throttling. The run that followed passed with
`maxLagBlocks` 113. That covers the CPU half of the problem — which is the half
that voids results — but **not** the port half, and not the proof-server, which
lives outside the scope as a long-lived devnet process.

Still open, and still your call: whether to add the preflight port/load gate,
parameterize the fixed ports, or wrap in Compose. The cheapest remaining item is
the preflight gate; the reservation has already removed the urgency.

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

    rg -n 'test\.failing\s*\(' packages --glob '*.test.ts'   # no output, exit 1

Scoped to test files and to actual *calls* on purpose: a bare
`grep -rn "test\.failing" packages/` also matches this plan, the review notes and
the commit messages that discuss the mechanism, so it can never reach zero and
would make the sweep unfalsifiable. (Measured: 4 non-test-file matches today.)

Plus `KNOWN_RED` entry count 0, and one final full run: ~205+ checks, 0
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

**How to fix.** **The obvious guard does not work, and it fails in exactly the
way this item is about.** Naively:

    bun run build:pgtypes
    git diff --exit-code packages/database/sql/queries.queries.ts   # WRONG

When parsing fails, pgtyped leaves the existing generated file **untouched**, so
the diff is empty and the step passes — the same silent success, one layer up.
Grepping for "Skipped" is also unsafe: an unchanged *successful* generation
legitimately reports it.

Make the absence of output the failure. Either:

- **Delete first, require recreation (preferred, no upstream change):**

      rm packages/database/sql/queries.queries.ts
      bun run build:pgtypes
      git diff --exit-code packages/database/sql/queries.queries.ts

  A skipped generation now leaves the file missing, so the diff fails loudly.

- **Or make it fatal at the source:** have the generator wrapper propagate
  pgtyped's `Error processing …` as a non-zero exit. Better for local runs too,
  but it is an upstream change.

**How to verify.** Deliberately break it — reintroduce a top-level `--` comment
in `queries.sql`, confirm CI goes red, revert. A guard that does not go red
under that exact test is the guard we already had.

---

## 17. RESOLVED — the `outputIndex ?? outputNo` shim is gone

Left open only because the grammar package was not found in the worktree's
`node_modules`. It is in the bun install cache, and it settles the question:

    @effectstream/sm@0.103.1/primitives/src/midnight-unshielded-spend/…-grammar.ts:12
    @effectstream/sm@0.103.1/primitives/src/midnight-unshielded-create/…-grammar.ts:12
        outputIndex: Type.Number()

**Required, and `outputNo` appears in neither grammar.** It is the LEDGER's field
name ([derive.ts:79](../../validator/derive.ts:79)), which is how the two came to
be conflated in a transition reading STM payloads. Under the no-retrocompat
ruling the alias is simply dead, so both sites now read `payload?.outputIndex`.

The `Number(...)` coercion went with it, which matters more than the alias: a
malformed payload must reach the `Number.isFinite` guard and be **rejected**, not
be coerced toward `0` and silently attributed to the wrong UTXO. Same principle
as the NOT NULL columns — do not fabricate evidence for a required field.

Verified: 182 tests pass, `run.ts` builds. p7b's deep audit is the standing
regression guard, since it asserts stored spend refs equal the transaction's own
UTXO triples.

---

## 18. NEW — the `bookReadP95Ms` gate cannot fail honestly at count=10

**Plan.** The 2026-08-07 run's single failure:

    [FAIL] p7b-audit ▸ metrics within baseline × 1.2
           (book read p95 ms: 42 > baseline 20 × 1.2 = 24)

    bookReadMs: {count: 10, p50: 7, p95: 42, max: 42}

**Not a regression.** The median is 7 ms, historically 7–8 ms — unmoved. With ten
samples the "p95" IS the max, so any single slow read defines it and trips the
gate. `baseline.json`'s own note already diagnoses this exact failure and states
the test: *"A real regression moves the median."*

This mattered because the cursor change (#1) replaced a `(timestamptz, int)`
comparison with `(bigint, text)` over a 64-char hash, which was the obvious
suspect. The median says the suspicion was wrong.

**This is the metric's second offence.** The note records that the baseline was
already raised 10 → 20 for the same reason — one 19 ms read with the median
unmoved. Raising it again to 42 would be the third round of the same move, and it
is exactly the "widen the threshold until it passes" antipattern this project
refuses for index-wait timeouts. A gate that has to be relaxed every time it fires
is not measuring anything.

**How to test.** Feed the checker a synthetic snapshot: `count=10, p50=7, p95=42`
must PASS (outlier, median healthy) while `count=10, p50=30, p95=45` must FAIL
(median genuinely moved). Today the first fails and the second also fails, for the
same reason — which is the point: the gate cannot distinguish them.

**How to fix.** In `metrics.ts`, gate book reads on the **median**, not p95, with
a baseline near the observed 7–8 ms and the existing ×1.2 tolerance. Options if
tail latency is genuinely wanted too: keep a p95 gate but only apply it when
`count >= 50` (below that, report it as a note like the TTL SSE population), or
raise the sample count so p95 stops being the max. Report the outlier either way —
it should be visible, just not a failure.

Note this is the same class as the SSE metric split (#9): a number that mixed two
populations and had to be redefined rather than re-baselined. Same lesson.

**How to verify.** The synthetic cases above, plus a full run reaching **205/0**
with RED-8 the only expected red. Test-only change; no product code.

---

## 19. NEW — PRODUCTION-READINESS's headline table still describes the old world

**Plan.** The (a)–(f) "Status today" table at the top of
[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) is what anyone reads first,
and every row still describes the state before this work:

    c | All data is correctly logged as real sales
      | **broken on the unshielded path** — and the suite currently asserts
      | the break as correct behaviour

That has been fixed, verified, and merged. Same for (d)'s inverted `last_price`
and mixed-clock window, and (b)'s "nothing re-validates what the API serves"
(p8-served does). §2.1 and §2.3's headers also lack the **FIXED** marker that
§2.2 carries. This is the leftover half of the merge item A3.

The risk is not cosmetic: a stale register **understates the system by four
fixed defects**, so the next reader either redoes finished work or distrusts the
document entirely — and this document is the only place the *open* defects are
described in enough detail to act on.

**How to test.** No test; it is prose. The check is that every claim in the
table is either true today or carries a fix reference.

**How to fix.** Rewrite the (a)–(f) rows to the post-merge state, mark §2.1 and
§2.3 **FIXED** like §2.2, and update §1.0's implementation table where the run
has since proven entries. Cross-link the four remaining defects to their items
here rather than restating them, so there is one register, not two that drift.

**How to verify.** Each (a)–(f) row states what is true now and names the item
covering the remainder; no defect appears as open in one document and fixed in
the other.

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
