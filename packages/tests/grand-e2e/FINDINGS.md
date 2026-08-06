# Findings & resume point — production-readiness work

State as of 2026-08-06. Read with [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md),
which holds the full plan and the per-defect detail.

---

## 1. The PR stack

Each is stacked on the previous, so review/merge bottom-up.

| PR | branch | what | verified |
|---|---|---|---|
| [#30](https://github.com/effectstream/zswap-offerfiles-kernel/pull/30) | `test/production-readiness-base` | PR-A: base test suite, `KNOWN_RED` registry, `p8-served` phase. **No product code.** | full run 205/0 |
| [#31](https://github.com/effectstream/zswap-offerfiles-kernel/pull/31) | `fix/unshielded-fill-classification` | PR-B: §2.1 unshielded fill-vs-cancel + migration 014 | full run 205/0, determinism identical |
| [#32](https://github.com/effectstream/zswap-offerfiles-kernel/pull/32) | `fix/pair-stats-price-orientation` | PR-C: §2.2 `last_price` inversion | unit red→green; e2e price checks passed in the 2026-08-06 run |
| [#33](https://github.com/effectstream/zswap-offerfiles-kernel/pull/33) | `fix/chart-window-chain-clock` | PR-D: §2.3 24 h window on chain clock | unit red→green; **not yet e2e-verified** |
| [#34](https://github.com/effectstream/zswap-offerfiles-kernel/pull/34) | `fix/cursor-chain-ordered` | PR-H: cursor on `first_seen_at`, excluded-columns guard | unit 180/0; **not yet e2e-verified** |

Independent reviews exist at `/home/eddie/zswap-offerfiles-kernel-x/PR-3{0,1,2,3,4}-REVIEW.md`.
Verification of their claims was in progress when this was written — **read those and
the agent verdicts before merging anything.**

---

## 2. Product defects — status

Six found, four fixed. All six were confirmed by measurement, not by reading code.

| § | defect | status |
|---|---|---|
| 2.1 | Unshielded fill-vs-cancel unclassifiable — a maker spending their own UTXO on themselves was recorded as a completed sale (measured: 9 trades vs 4 real, volume 13009 vs 5009) | **FIXED** PR-B |
| 2.2 | `pair_stats.last_price` inverted for half of all trades — `want÷give` with no reference to which colour became base | **FIXED** PR-C |
| 2.3 | 24 h stats window bounded on `NOW()` while comparing chain-derived `archived_at` | **FIXED** PR-D |
| — | Keyset pagination ordered on `created_at` (`DEFAULT NOW()`) — replicas served different page orders, invisible to the determinism diff by construction | **FIXED** PR-H |
| 2.4 | Cross-layer offers unenforced. **Confirmed reachable**: `Transaction.merge` of a real shielded + unshielded offer passes our FULL ladder including `wellFormed`. Ruled REJECT. | **OPEN** → PR-E |
| 2.5 | Basket offers fabricate prints — one settlement becomes 4 trades at 4 prices, volume double-counted. Ruled ACCEPT-but-exclude-from-market-data. | **OPEN** → PR-F |
| 2.6 | `expiresAt` already in the past at ingestion on a quiet chain (measured: ingested 18:34:20, served expiry 18:23:36) while the offer is served `status: live` | **OPEN** → PR-G, red recording correctly |

### The pattern worth carrying forward

Three of these (§2.2, §2.3, PR-H) are the same shape: **two halves of the system on
different clocks, where a partial fix created the divergence.** Making `archived_at`
chain-derived is what turned the 24 h window's `NOW()` from accidentally-consistent
into contradictory. Adding the `MAX(height)` escape to the read gate and not to the
expiry derivation is §2.6.

PR-H closes the class structurally: `excluded-columns-are-write-only.test.ts` asserts
no `DIFF_EXCLUDED_COLUMNS` column appears in any `ORDER BY`/`WHERE`/`GROUP BY`/`JOIN`.
A column can be legitimately excluded from the determinism diff *and* silently driving
behaviour; nothing connected those two facts before.

---

## 3. The last run (2026-08-06 18:11) — COMPROMISED, do not use as a verdict

15 failures, but they are **one throughput failure counted fifteen times**, not fifteen
defects.

**What is cleared.** Zero STF failures. Zero NOT NULL violations. p7b's deep audit
passed (`stored spend refs equal the transaction's own nullifiers / UTXO triples`,
`fill markers stored for every offer that has shielded outputs`). So ingestion,
migration 014's tables and migration 015's `NOT NULL` are all healthy under load.

**What went wrong.** The `maker self-fill` settle timed out; from that point publishes
starved. `taker settle concurrency reached queue depth ≥ 4` **failed** — it passed on
every previous run — so batcher concurrency was materially down. p3b then skipped BOTH
competitor sets (`publish failed for #20`, `#30`), producing zero checks, and p5's
batches failed to publish. Everything downstream (chart counts, volume, classification,
`trade_count`, casualty rate) follows from offers never existing.

**Root cause, most likely.** The self-fill settles on the SAME wallet that built the
offer, and `buildOffer` leaves the give coin reserved by the recipe. Every other
settlement uses a different wallet, so the reservation is irrelevant to it; p3b and the
cancel cycles both `revert` before spending. **Fix is staged and uncommitted in
`phases/p3-lifecycle.ts`** — a `revert(built.finalized)` before `settleAndAssert`.

**Not proven.** The symptom was a *timeout*, which is also what proof-server contention
looks like. If the next run times out again, the reservation was not the cause.

**Confound to keep in view.** p5's own note reports the dev batcher runs one wallet at
`maxSlotsPerWallet=1`, ~25 s/tx serialised. PR-A added ~14 on-chain offers (three
unshielded cancel shapes, 3-way competition per layer, held-back republishes, self-fill,
unshielded expiry). If the next run still starves, the suite's load has genuinely
outgrown the dev batcher and that is a **provisioning decision, not a test fix**. Do not
widen the 3-minute index timeout to make it pass.

---

## 4. Open items

**Blocking nothing, but unresolved:**

- **SSE baseline keys are absent** from `baseline.json` on purpose. The metric was
  redefined (see below) so its number must be re-derived from measurement, and one
  quiet run is not enough. Need 2–3 clean runs at typical load. Populate
  `sseDeliveryLagP50Ms` / `sseDeliveryLagP95Ms` then.
- **`/v1/pairs is ordered by last_traded_at, newest first`** failed in the last run.
  Could be real or an artefact of too few fills. Recheck on a clean run before
  investigating.

**The SSE metric split (done, but its premise is weaker than first claimed).** p7b now
gates CONSUMED archives only and reports TTL archives as a note. Rationale: a TTL
archive runs from a scheduled input, so its `archived_at` is a block timestamp the STM
may not reach until much later during storm catch-up — STM scheduling latency wearing
the label of SSE delivery, and `maxStmLagBlocks` already gates that. **However**: on the
run that measured it, TTL max was 4777 ms, nowhere near the 23572 spike it was meant to
explain, and `maxLagBlocks` was 53 vs 83–95 before — i.e. that run was simply calmer.
The split is good metric hygiene; it is **not proven** to be the cause of the spikes.

**Best remaining hypothesis for the lag spikes:** stale processes from hard-killed runs.
`fresh-run.sh`'s reaper originally covered only the batcher, dust provisioner and
indexer. It now also covers `main.grand-b.ts` (the p7a replica node — the heaviest thing
the suite runs, measured at load 17 while replaying), `main.dev.ts`, and `start-pglite`
(which owns port 5432, so a survivor blocks the next bootstrap entirely). Both high-lag
runs followed a session kill. Watch `maxLagBlocks` over the next few runs.

---

## 5. Environment gotchas that cost real time

- **A reboot re-enables system PostgreSQL on 5432**, which the stack's PGlite needs.
  Symptom: three identical bootstrap failures whose only real evidence is
  `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` one line deep in
  `stack.log`; the `exited with code 143` lines are the orchestrator tearing down
  afterwards. Fix: `sudo systemctl stop postgresql` (already `disable`d on this box).
  A preflight check in `start-stack.sh` would turn 6 wasted minutes into one clear line.
- **`pkill -f` matches the killing shell's own command line.** Cost two debugging cycles
  in this project. Always bracket: `'main[.]dev[.]ts'`.
- **Backticks inside SQL comments terminate the enclosing TS template literal.** The
  query strings in `queries.app.ts` are template literals; prose punctuation is not free.
- **No `tsconfig.json` in this repo.** `bunx tsc` does not work; the gate is
  `bun build --target=bun packages/tests/grand-e2e/run.ts` plus `bun test`.

---

## 6. Resume here

1. **Read the independent reviews** at `/home/eddie/zswap-offerfiles-kernel-x/PR-3*.md`
   and the agent verdicts on them. Fix what is valid before merging.
2. **Commit the staged self-fill revert** in `phases/p3-lifecycle.ts`.
3. **Re-run** `./packages/tests/grand-e2e/fresh-run.sh` (~55 min, preflight 5432 first).
   Expect: 8 §2.1 checks green, RED-8 as `[RED ]`, no XPASS, determinism identical.
   This run also owes: PR-D and PR-H e2e verification, a `maxLagBlocks` reading, and a
   CONSUMED-only SSE measurement.
4. **Then PR-G** (§2.6) — smallest remaining fix, apply the `MAX(height)` escape the
   read gate already uses to the `expiresAt` derivation in `state-machine.ts`.
5. **PR-E / PR-F** need fixtures built, not just code. §2.4's fixture route is proven
   (`probe-cross-layer.ts`); §2.5's needs a third shielded colour, which is one
   `TOKEN_SEPS` entry — `mintShielded` parameterises the colour by domain separator on
   the already-deployed contract, so no new contract is required.

Two standalone probes are committed and reproduce their findings in seconds with no
stack: `probe-cross-layer.ts` (§2.4 + §2.5) and `packages/database/multileg-pairs.test.ts`
(renders the actual API responses for a basket offer).
