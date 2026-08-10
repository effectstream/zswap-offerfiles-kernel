# Remaining work — four goals between here and production

**#35 IS MERGED** (2026-08-08, `f298123`). The merge goal is met; this document
is now the register of what is left.

State as of 2026-08-10. Companion to
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

**Still not production-ready.** Three product defects remain (#5, #6, #7), all
market-data integrity, plus an undecided reorg policy (#13). §2.6 is fixed in
PR #37, which deleted RED-8 — the `KNOWN_RED` registry is now EMPTY, so any red
in a future run is a plain failure.

---

## How to execute this document, cold

Written so ANY agent can pick an item up with no conversation context. The
per-item sections carry the what/why; this block is the operational floor.

**The verification loop, for every item:**

    bun test packages/database packages/validator packages/node \
             packages/offer-guard packages/batcher packages/tests/grand-e2e
    bun build --target=bun packages/tests/grand-e2e/run.ts   # THE typecheck gate
    ./packages/tests/grand-e2e/fresh-run.sh                   # full e2e, ~75 min

There is **no tsconfig in this repo** — `bunx tsc` does not work; the `bun
build` line above is the only compile gate. Run the e2e inside the CPU
reservation from §3 (`systemd-run --user --scope -p CPUWeight=500 -p
CPUQuota=1200%`), read **`maxLagBlocks` first** (>~150 = the run is VOID, not
failed), and watch the chain tip during the run — a tip that stops advancing
means the box is starved and the run is void; abort, do not debug downstream.

**Required reading before touching anything:** [FINDINGS.md](FINDINGS.md) §0
(current state) and §5 (environment gotchas — system PostgreSQL steals port
5432 after a reboot; `pkill -f` matches its own command line, bracket the
pattern; a backtick inside a SQL comment terminates the enclosing TS template
literal in `queries.app.ts`). Discipline: [known-red.ts](known-red.ts) header —
the registry is EMPTY, every fix deletes its own red, `test.failing` is the
unit-level equivalent.

**Tooling traps found the hard way:** `gh pr edit` fails in this repo on a
deprecated Projects-classic GraphQL query and aborts the edit while looking
like it worked — use `gh api repos/<org>/<repo>/pulls/<N> -X PATCH -F
body=@file`. Bun uses isolated installs: a package imported by
`packages/tests` code must be in `packages/tests/package.json`.

**References:** file+symbol names are authoritative; `:line` numbers were
captured across several revisions and may have drifted.

**Rulings already made — do not re-litigate, implement:** §2.4 REJECT; §2.5
ACCEPT-but-exclude-from-market-data; #8 liquidity-first; #11 keep-as-defence;
#13 reorg recovery is the engine's job (snapshot + resync). Any scope change to
one of these goes to Edward; nothing else currently needs his ruling.

---

## The road ahead — four goals, in order

State 2026-08-10: PRs **#36** (this plan + review corrections) and **#37**
(PR-G) are open; main is at the #35 merge.

### GOAL 1 — land what is built, verified (\< a day)

*Achieves: §2.6 closed end-to-end; an empty-`KNOWN_RED` baseline where any
future red is a plain failure; the register of truth current on main.*

1. Merge **#36** (docs only — this file).
2. **e2e run at #37's head** under the CPU reservation, tip watched. Pass =
   p8's expiry check green with an EMPTY registry, 205/0, determinism holds.
   This is the run that converts PR-G from "unit-verified" to done, and it
   doubles as SSE sample 2 of 2–3 (#9).
3. Merge **#37**.

### GOAL 2 — no fabricated or polluted market data (the core of production)

*Achieves: properties (c) and (d) fully — nothing on the chart that did not
happen, nothing missing that did. This is the remaining substance.*

4. **#6 cross-layer REJECT** (§2.4) — reachable today via `Transaction.merge`;
   small validator change + fixture at both doors.
5. **#7 baskets across five surfaces + #8 the `/v1/pairs` contract** (§2.5) —
   one query set, one ruling, one fixture with a third colour.
6. **#5 exact-identity markers — CARVED OUT as its own PR effort (2026-08-10)**,
   not a queue step: it is the only *fabrication* defect but also the hardest,
   and it decomposes into four phases that are each real work —
   **(a) offer generation** (fallible-section and duplicate-intent shapes have
   never been constructed; direct `ledger-v8` intent building),
   **(b) validation** (the ladder and `collectUnshieldedOutputs` on those
   shapes; segment-aware identities),
   **(c) execution / merging / balancing** (settle them on the dev chain,
   including the fallible-failure path), and
   **(d) reading effects** (segment-correct markers, exact-identity
   classification, literal-duplicate dedup, post-commit publication).
   Runs in parallel with #6/#7 rather than blocking them. Detail in §5.

### GOAL 3 — the production go/no-go — **ALL THREE DECISIONS RULED 2026-08-10**

*Achieved: #8 liquidity-first (implement with #7); #11 keep-as-defence (doc
paragraph folds into #19, spawns #20's adversarial-input coverage); #13 reorg
recovery is the ENGINE's job — snapshot + resync, with p7a-proven replay making
it safe on our side. Nothing to build here except:*

7. **#14 Compose** — the one execution constraint left: wrap the runner where
   practical, document the proof-server as the exception.

### GOAL 4 — leave the suite trustworthy (closeout)

*Achieves: guardrails that outlive this effort — the suite stays a usable gate.*

10. **#19** — PRODUCTION-READINESS's (a)–(f) table still describes the pre-work
    world; rewrite to post-merge truth, one register not two.
11. **#16 pgtyped CI guard** (delete-then-regenerate, diff), **#9 SSE keys**
    (max of per-run p50/p95 across 2–3 clean runs), **#12 T-E2/T-E5 coverage**,
    **#20 adversarial wire inputs** (build alongside #5(a) — same tooling).
12. **#15 the sweep** — zero `test.failing`, zero registry entries, one final
    205/0 run. The run that says done out loud.

Items #1, #2, #3, #4, #10, #17 and #18 are **done**.

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
| 8 | ~~`/v1/pairs` ordering~~ | **RULED: liquidity-first** — implement with #7 | ruled |
| 9 | SSE baseline keys absent | measurement | open |
| 10 | ~~`pair_stats` backfill~~ | **RESOLVED** — no-retrocompat ruling | — |
| 11 | ~~T-A2 unreachable reject codes~~ | **RULED: keep as defence** — spawns #20 | ruled |
| 12 | T-E2 / T-E5 deferred coverage | coverage | open |
| 13 | ~~Reorg recovery~~ | **RULED: engine responsibility** — snapshot + resync | ruled |
| 14 | Runner not host-isolated — **Compose is a settled constraint** | execution constraint | open |
| 15 | The closing sweep | closeout | open |
| 16 | pgtyped regeneration can silently break again | new — no guard | open |
| 17 | ~~`outputIndex ?? outputNo` shim~~ | **RESOLVED** — grammar confirmed, shim removed | — |
| ~~18~~ | ~~`bookReadP95Ms` gate unfalsifiable at count=10~~ | **DONE** — median now carries the gate | — |
| **19** | **PRODUCTION-READINESS (a)–(f) table still describes the pre-work state** | stale docs (ex-A3) | open |
| **20** | **Adversarial wire inputs — actually HIT the T-A2 codes** | new — coverage, from #11's ruling | open |

### Order of work

See "What to do next, in order" at the top — this heading used to repeat a
pre-merge A1/A2/A3 gate that no longer exists.

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

**SPLIT 2026-08-10 — its own PR effort, in four phases.** Each phase has a
deliverable that stands alone; (a) gates the rest and its outcome can reshape
them, so do not build (b)–(d) speculatively.

| phase | work | exit criterion |
|---|---|---|
| **(a) Generate** | A fixture-builder over `ledger-v8` (the `probe-cross-layer.ts` pattern — the ledger API, not a wallet) that constructs: a **fallible-section** unshielded offer, two byte-different wrappers embedding the **literal same intent**, a **multi-intent** wrapper, and the plain guaranteed shape as control. None but the control has ever been built here; if a shape is unconstructible, that is a FINDING to record, not a dead end. | blobs that decode, hash and round-trip |
| **(b) Validate** | The ladder on those shapes: accept/reject correctly, `deriveTokenLegs` right, `collectUnshieldedOutputs` iterating **entries** and computing segment-aware identities (`intentHash(0)` guaranteed / `intentHash(physSeg)` fallible), markers stored exactly | unit tests incl. precomputed-identity equality against (a)'s blobs |
| **(c) Execute** | Settle each shape on the dev chain: merge with a taker intent, balance, submit, observe the fallible section actually execute. Also characterise the **fallible-failure** path (segment rolls back — what does the offer look like then? inputs unspent → presumably still live; do not assert, measure) | settled tx hashes on chain per shape, failure path documented |
| **(d) Read** | The indexer end: creates recorded with the physical-segment hash, classification on exact identities, the literal-duplicate dedup rule (stated precisely for multi-intent wrappers), and **post-commit publication** for `pair_stats`/SSE — outbox vs in-transaction projection, with the held-open-transaction PostgreSQL test | t1/t2/t4/t5 + the duplicate red green; e2e green; determinism holds |


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
commitments. The segment rule is NOT uniform, and getting it wrong cancels
valid trades:**

`UtxoState::apply_offer` stamps every output with `parent.intent_hash(segment_id)`
(ledger 8.1.0 `semantics.rs:1645-1679`), and the two call sites pass different
things:

| offer section | segment passed | identity |
|---|---|---|
| **guaranteed** | literal `0` — the loop iterates `for (phys_seg, intent)` but passes `segment`, which is 0 in that branch (`semantics.rs:940-974`) | `intentHash(0)` |
| **fallible** | the intent's **physical segment id** (`semantics.rs:1079-1095`) | `intentHash(physSeg)` |

The earlier revision of this item generalised `intentHash(0)` to both and called
fallible "the last untested unknown". It was not unknown — the pinned ledger
answers it, and implementing the generalisation literally would store a marker
that **can never match the on-chain create, classifying every valid fallible
settlement as cancelled**. `Transaction::merge` preserves intent-map keys and
rejects collisions rather than renumbering (`structure.rs:1383-1437`), so the
physical key is stable and knowable from the published blob.

1. At ingestion, per intent and per unshielded output index `i`:
   identity = `(owner, intentHash(SEG), i)` where `SEG` is `0` for a
   guaranteed-section output and the intent's **physical map key** for a
   fallible-section one. Store those in `offer_file_unshielded_outputs` (keep
   type/value for display/audit).
   **`collectUnshieldedOutputs` currently iterates `intents.values()`
   ([derive.ts:137](../../validator/derive.ts:137)), which discards the key it
   now needs — it must iterate entries.**
2. Branch 3 of `unshieldedCancelledPredicate` becomes: cancelled unless every
   declared identity exists in `unshielded_creates`. Identity is globally
   unique, so the settling-tx correlation is corroboration, not the key.
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
**Two things it does NOT dissolve. Both were wrongly written off in the previous
revision, and both are required parts of this item:**

**(i) Literal-intent duplicates still turn one payment into two prints.** Two
byte-different wrappers embedding the LITERALLY same intent share every exact
identity. The earlier note called this "the same swap listed twice… not a
blocker". It is the original integrity defect in a narrower shape:

1. both rows share the spent input and archive on the one settlement;
2. both find the same exact markers and classify `consumed`;
3. the archive loop emits `offer_consumed` **once per row**
   ([state-machine.ts:303](../../node/state-machine.ts:303));
4. `upsertPairStatsByOfferId` increments `trade_count` per offer id.

One payment, two market prints — and it directly contradicts requirement (e),
whose own test demands exactly one `consumed` duplicate. So a **red for two
byte-different wrappers carrying the literal same intent is required**, and
canonical-execution dedup (or deterministic exactly-one attribution) is part of
the fix. "Dedupe by intent hash" is not yet a rule: it must say what happens for
multi-intent wrappers, where two offers may overlap on some intents and not
others.

**(ii) The pre-commit projection/SSE race is REAL and exact markers do not touch
it.** The previous revision claimed it had "nothing structural" left because the
chain rows commit in one DB transaction. The rows are transactional; **the
events are not post-commit**:

- the unshielded-spend transition calls `emitAppEvent` while the runtime's block
  transaction is still open ([state-machine.ts:303](../../node/state-machine.ts:303));
- `emitAppEvent` is a synchronous local `EventEmitter.emit`
  ([event-bus.ts:24](../../node/event-bus.ts:24));
- the API listener immediately runs `upsertPairStatsByOfferId` **on a separate
  pool** ([api.ts:97](../../node/api.ts:97)) — and its comment claims the event
  "fires after the archive transaction commits", which is simply false;
- effectstream commits only after every primitive has run, and
  `Midnight-UnshieldedSpend` is configured BEFORE `Midnight-UnshieldedCreate`
  ([config.dev.ts:149,158](../../node/config.dev.ts:149)), so the spend's archive
  and emit precede the same block's create rows;
- the SSE route forwards the same local event immediately.

On PostgreSQL the pair-stats update can therefore run before the archive and
same-block creates are visible, write nothing, and never retry — and SSE can
announce a lifecycle state that is later rolled back. PGlite's scheduling may
hide it, so **t5 as described is not proof of safety**.

The fix needs transaction-aware publication: a durable outbox, a runtime-level
post-commit buffer, or performing the projection inside the block transaction
after the required primitives have run. Verification must be a controlled
PostgreSQL test that holds the block transaction open and proves neither pair
stats nor SSE publish before commit, plus the rollback path.

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

**How to verify.** t1/t2/t5 and the new literal-duplicate red flip `.failing` →
`test`; t4 lands green (under exact identities only the executed intent's
identities appear, so the executed alternative reads consumed by construction);
t3 and the existing nine unshielded cases untouched; t6 re-checked (the shielded
side is already identity-exact — now the symmetric design, not a divergence).

**A FALLIBLE-SECTION FIXTURE IS MANDATORY, not a nice-to-have:** it must assert
both the precomputed marker (`intentHash(physSeg)`, not `intentHash(0)`) and the
final `consumed` classification. Without it the segment rule is untested in
exactly the direction that silently cancels valid trades.

**Known unknown for whoever builds it: no fallible-section unshielded offer has
ever been constructed in this suite.** All nine sampled offers were
guaranteed-only, and whether the wallet SDK path can even emit one is
unestablished. Expect to construct the intent directly via `ledger-v8` (the
`probe-cross-layer.ts` pattern — the ledger API, not a wallet, is the reliable
route to unusual shapes). Proving that construction route is the first task of
this item, not a detail: if fallible outputs are genuinely unreachable from any
real wallet, THAT is a finding to record, and the defence-in-depth still wants
the segment-correct marker stored.

Plus the PostgreSQL publication test from (ii), and a full run: unshielded shapes
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

## 8. RULED — `/v1/pairs` is liquidity-first

**Edward, 2026-08-10: "Liquidity first; we want to always show the major
players — and make the users see by default the largest pools."**

Contract: `ORDER BY open_count DESC, last_traded_at DESC NULLS LAST, pair_key`.
The SQL already does the first two; implementation is: append the `pair_key`
tiebreaker (mandatory — block-time quantisation makes ties common and replicas
must agree), fix the e2e assertion which claims newest-first, state the contract
in the API docs, and add the identical-`open_count`-and-`last_traded_at` unit
test. Ships with #7, which already edits `getPairs`.


**DECISION BRIEF — the options, for Edward:**

| | contract | for | against |
|---|---|---|---|
| **A (recommended)** | liquidity-first: `open_count DESC, last_traded_at DESC, pair_key` | what the SQL already does; a market list wants actionable books first; zero product change — only the assertion and docs move | recency buried for deep books |
| B | recency-first: `last_traded_at DESC NULLS LAST, open_count DESC, pair_key` | "what is moving" reading; matches the current (unkept) test claim | a pair with 50 open offers but no trade today sinks below a one-off print; changes served behaviour |
| C | no ordering contract — stable `pair_key` order only, clients sort | cheapest; never wrong | weakest API; every client reimplements sorting |
| D | `?sort=liquidity\|activity` param | serves both readings | most work; premature for one consumer |

Whichever is chosen: `pair_key` as the final tiebreaker is **mandatory**, not
stylistic — `last_traded_at` quantises to block time, so ties are common and an
uncontracted tie order differs across replicas.

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

Note #5's publication fix (post-commit projection, see #5(ii)) would make any
future repair free as a side effect, since the projection becomes rebuildable
from classified history. A reason to sequence #5 first, not to reopen this.

---

## 11. RULED — keep all three as fail-closed defence

**Edward, 2026-08-10: keep [A]** — and go further: a future task should TRY TO
HIT these codes with hand-crafted inputs, accepting that this requires complex
manual generation. That task is **#20**.

Implementation of the ruling itself: one paragraph per code in
PRODUCTION-READINESS §1.0.1 stating the defence rationale (the DA namespace is
permissionless; reachability is not bounded by the SDK), folded into #19's doc
pass. The unit-double tests remain the floor until #20 replaces them with real
wire bytes.


**DECISION BRIEF — the options, for Edward.** The deciding fact: the DA
namespace is **permissionless**. The ladder's input is attacker-chosen bytes,
not SDK output — "no SDK today can build it" bounds the reachable inputs of
honest clients only.

| | ruling | for | against |
|---|---|---|---|
| **A (recommended)** | keep all three, documented as fail-closed wire-format defence | cheap, unit-tested against doubles; exactly the branches a hostile hand-rolled client or a future SDK/wire change would hit; each has a distinct `offer_rejections` code, so if one EVER fires in production that is a labelled signal | carries "unreachable" code |
| B | delete as dead code | smallest ladder | a future format change resurrects the input shape into a generic error path — or past the gate; repo holds no strict no-dead-code policy elsewhere |
| C | collapse the three into one generic MALFORMED code | keeps the defence, sheds the taxonomy | destroys the ops diagnostic — `offer_rejections` aggregates by code, and "what is being rejected lately" becomes mush |

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

## 13. RULED — reorg recovery is the engine's job, not the indexer's

**Edward, 2026-08-10: "We should not care too much about this. This is an
engine-effectstream issue: if there is a rollback, the engine will stop, reload
an older snapshot, and resync."**

So the contract is: effectstream detects the rollback, halts, restores a
pre-fork snapshot, and replays — and the indexer's job is only to make that
replay SAFE, which is already proven: p7a shows replay-from-height-1 reproduces
every public table byte-identically, and all STM inputs are chain facts. Nothing
to build here.

What this descopes, recorded so nobody re-litigates it: the parent-hash
continuity tripwire, the N-block buffer, and tombstones — all parked as engine
concerns. If operating experience ever shows the engine NOT catching a
rollback, this item reopens with the analysis below already done.

<details>
<summary>The pre-ruling analysis, kept for that eventuality</summary>


**DECISION BRIEF — the options, for Edward.** Three facts needed before ruling,
none established yet: (1) does the Midnight node feed effectstream finalized
blocks or head? (2) what is Celestia's inclusion-vs-finality gap in our
deployment? (3) expected chain length at launch — the cost of "wipe and resync"
grows with it.

| | approach | for | against |
|---|---|---|---|
| **A (recommended now)** | finalized-only invariant + parent-hash continuity tripwire in the sync layer, halting loudly | small; a halted indexer is recoverable, a corrupted one is not | Celestia parent identity is discarded upstream — coverage is Midnight-only until an effectstream change lands (size it; document the gap) |
| **D (pairs with A)** | accept + resync runbook: on any continuity alert, wipe and replay from genesis | p7a makes this CREDIBLE — replay is proven byte-identical, ~75 min at dev scale | cost scales with chain length; a runbook is not a mechanism |
| B | N-block confirmation buffer on the COMPLETE source stream before STM application | covers a non-finalized feed properly | real design work — interacts with TTL scheduling, index-wait budgets, and book freshness (served state is N blocks stale); N must come from measured reorg depth, not a guess |
| C | soft-archive / tombstones (reversible ingestion) | survives reorgs in place | heaviest; reopens the entire history schema; only warranted if reorgs are an expected operational event |

Recommended sequence: fact-find (1)–(3), ship A+D regardless (the tripwire is
wanted even on a finalized feed — it converts "impossible" into "loud"), and
revisit B only if fact-finding says the feed can actually reorg.

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

</details>

---

## 14. Runner host isolation — Compose is a settled constraint

**Plan.** **SETTLED: use Docker Compose where practical.** Three independent
reviews have now stated this was an explicit standing instruction for running
tests — host ports must not collide. I could not corroborate it from this
repo, conversation or memory, and said so twice; that is recorded in the
revision history rather than re-litigated here. Treat it as a constraint:
isolate via Compose where practical, and **document any component that cannot
be** (the Midnight proof-server is a long-lived devnet process outside any
scope we create).

The CPU reservation (§3) and a load preflight are **complementary**, not
substitutes: they address contention, which voids results, while Compose
addresses port/network collision, which prevents runs from starting.

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

## 18. DONE — the `bookReadP95Ms` gate now measures the median

Fixed and merged (`a83965b`). At count=10 the p95 IS the max, so one slow read
defined the gate and it had already been raised 10 → 20 once for the same
reason. The median now carries it (`bookReadP50Ms`), the tail is enforced only
at >= 50 samples (`MIN_TAIL_SAMPLES`) and reported as a note below that, and the
same rule covers `sseDeliveryLagP95Ms`. `metrics.test.ts` pins the distinction
the old gate could not make: `{count:10, p50:7, p95:42}` passes,
`{count:10, p50:30, p95:45}` fails.

Still open from that work: `submitP95Ms` (~29 samples) and
`publishToIndexedP95Ms` (~33) share the low-count property and remain gated on
p95 alone. They pass today; they should gain p50 baselines at the next
recalibration.

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

## 20. NEW — adversarial wire inputs: actually hit the T-A2 codes

**Plan.** Born from #11's ruling. `NO_SPENDABLE_INPUT`, `UNKNOWN_TOKEN` and
`ROOT_UNREADABLE` are kept as fail-closed defence, currently proven only
against hand-made TypeScript doubles. The stronger proof is REAL bytes through
the REAL Celestia door that reach each code — demonstrating the defence fires
where it claims to, at the gate it claims to guard.

**How to test.** This IS the test. Three families of hand-crafted blobs:
- **`NO_SPENDABLE_INPUT`** — a structurally valid MIP-0005 transaction whose
  offer carries zero spendable inputs. The SDK refuses to build one; direct
  `ledger-v8` intent construction (the #5(a) fixture-builder — same tooling,
  build them together) or byte-level surgery on a valid blob.
- **`UNKNOWN_TOKEN`** — a token tag outside shielded/unshielded/dust. Likely
  requires byte-level mutation of a serialized transaction, then re-encoding
  bech32m; the deserializer may reject it first — WHERE it is rejected is the
  finding (our code vs the ledger parser), and "the parser structurally
  precedes our gate" is an acceptable answer if measured.
- **`ROOT_UNREADABLE`** — a blob whose declared proof root bytes do not parse.
  Same surgery approach.

Each lands as a p4 fixture family: submit at the Celestia door, assert the
exact reject code in `offer_rejections`, assert nothing was indexed.

**How to fix.** Nothing, unless a family reveals the code is unreachable even
by surgery (parser rejects earlier) — then the ruling's documentation is
updated with the measured reason, which is a better answer than the current
assumption either way.

**How to verify.** Three new p4 checks green; `offer_rejections` shows each
code exactly once per run; the unit doubles stay as the fast-path floor.

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
