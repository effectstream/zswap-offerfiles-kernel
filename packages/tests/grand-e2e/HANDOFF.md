# Grand E2E — Implementation Handoff

**Audience:** an agent with this repo checked out and NO other context.
**Task:** implement the test suite specified here, in this directory
(`packages/tests/grand-e2e/`). Plan is approved; scope decisions are final
(§ Decisions). Do not redesign — implement.

**What this is:** one long-running (~2 h), NOT-in-CI e2e suite that exercises
every feature of the ZSwap-DA kernel, every rejection path, every lifecycle
transition, then applies load, chaos, a determinism check, and a final
invariant audit. Runner entry: `bun run test:grand` (add the script to the
root `package.json`, pointing at `packages/tests/grand-e2e/run.ts`).

---

## 1. What this system is (60-second orientation)

ZSwap-DA is a dual-chain indexer + offer relay for P2P atomic swaps on
Midnight (per MIP-0005/MIP-0006):

- A **maker** builds a proven, imbalanced Midnight `Transaction` ("offer"),
  encoded as a bech32m string `swapoffer1…` (16–25 KB). Raw serialized bytes
  are the canonical form; the string is a display encoding.
- Offers are published to **Celestia** (DA layer) as **raw bytes** (no
  wrapper) under the shared namespace `mn-swap-v1`
  (hex suffix `6d6e2d737761702d7631`). Either via our API
  (`POST /v1/offers` → batcher → Celestia) or by anyone directly
  (`blob.Submit`). The namespace is the source of truth — the STM validates
  every blob it fetches, no matter who posted it.
- The **node** (effectstream STM) also watches **Midnight** for: zswap
  nullifiers + commitments (`Midnight:NullifierAndCommitment` primitive),
  unshielded UTXO creates/spends, and Merkle-root advances. From these it
  maintains offer liveness and classifies terminal states.
- A **taker** fetches an offer, balances it (adds their side), merges, and
  submits the settlement to Midnight via the batcher's `midnight-balancer`
  target. Settlement is atomic.
- `offerId` = lowercase hex SHA-256 of the raw transaction bytes. Identical
  on every node; equals the hash of the DA blob.

**Offer statuses:** `live | consumed | cancelled | expired | not_found`.
- `consumed` — inputs spent in ONE Midnight tx AND (when the offer has
  stored "fill markers" — its own shielded output commitments, captured at
  ingestion) that tx also created those markers. Merging preserves outputs,
  so a genuine settlement always recreates them. Exact, incl. single-input.
- `cancelled` — inputs spent across >1 tx, or partially, or in one tx that
  did NOT create the markers (maker walked away). Classification is
  read-time SQL (`cancelledPredicate` in
  `packages/database/sql/queries.app.ts`).
- `expired` — TTL sweep archived it unfilled.
- **Known gap (assert as documented behavior):** unshielded-only offers
  cannot classify `cancelled` — spends aren't tx-grouped yet — any spend
  reads `consumed`. Do not "fix" this in the suite; assert current behavior
  with a comment referencing the gap.

**Expiry semantics:**
- Shielded: no TTL field exists on a zswap offer. `expiresAt` = earliest
  input-root `last_seen_ms` + `ROOT_WINDOW_SECONDS` — a conservative FLOOR
  that advances while the chain keeps refreshing the root.
- Unshielded: `expiresAt` = earliest intent TTL (structurally always
  present).

## 2. Decisions (final — from Edward)

| Decision | Value |
|---|---|
| Real-offer scale | **~500 real offers, ~2 h total runtime** (≈40% settled, ≈20% cancelled, ≈20% expired, ≈20% left live) |
| TTL for the run | **10-minute window**: run the stack with `ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600` |
| Direct-Celestia adversarial path | **In scope** (see §6 for how to publish raw blobs) |
| Determinism check | **Yes** — full replay comparison (§9) |
| Location | `packages/tests/grand-e2e/`, runner `bun run test:grand` |
| CI | NOT wired into CI. Manual invocation only. |

## 3. Environment & how to run the stack

- **Runtime:** `bun` (everything: scripts, tests, package manager).
- **Start the full stack:**
  `NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 bun run dev`
  (orchestrator TUI: Midnight node :9944, Midnight indexer :8088 GraphQL,
  proof server :6300, Celestia devnet light node :26658, pglite Postgres
  :5432 user `postgres` db `postgres`, batcher :3334, node API :9999).
  Startup takes ~4–6 min incl. contract deploy + test-token mint
  (`mint-test-tokens` prints `MINTED {shieldedA, shieldedB, unshielded}`).
- **DB access from tests:** plain `pg` client to `127.0.0.1:5432` (see
  `packages/tests/lib/db.ts`). App tables in `public`, framework tables in
  `effectstream` schema (`primitive_accounting`, `effectstream_blocks`, …).
- **Node API:** `http://127.0.0.1:9999` — full reference in root `API.md`
  (accurate; regenerated from handlers). Playground: `:10601/docs/`.
- **⚠️ pglite is wiped on every `bun run dev`** — a stack restart is a
  fresh DB. Chaos tests that restart the *node/STM only* must NOT restart
  the orchestrator (kill/restart the individual process instead, §8).

### Known operational gotchas (all load-bearing)

1. **Indexer SPO crash (worked around, do not remove):** the 0.103.0
   Midnight indexer's SPO sub-indexer crashes the whole indexer on the
   first completed epoch. The launch script
   (`packages/contracts-midnight/package.json`, `midnight-indexer:start`)
   starves it via `APP__INFRA__SPO_NODE__URL=ws://127.0.0.1:1` +
   huge `RECONNECT_MAX_ATTEMPTS`. Expect harmless reconnect noise in its
   log. Phase 0 must assert the indexer is still alive after 65+ min.
2. **STF errors are INVISIBLE by default.** The effectstream runtime
   catches state-transition errors and sends them to telemetry only
   (`process-blocks.ts` STEP 5). The suite MUST tail the sync process log
   for silence-breaking evidence differently: assert **effect**, not logs —
   e.g. row counts vs `effectstream.primitive_accounting` counts (§10).
   Optionally patch the catch in node_modules to `console.error` (grep for
   `log.remote` in `@effectstream/runtime/src/process-blocks.ts`) — that
   patch is wiped by `bun install`.
3. **Every DB query object passed to the STM's `World.resolve` must be a
   real pgtyped `PreparedQuery`** (has `.queryIR`). Already the case; if
   you add queries to `packages/database/sql/queries.app.ts`, use the
   existing `prepared()`/`compileIR()` helpers there (oracle-tested in
   `queries.app.test.ts`).
4. **Proving is the cost.** One real offer ≈ 10–30 s through the proof
   server. 500 offers in ~2 h REQUIRES parallelism across wallets (§7).
5. NTP/L2 block time is 1 s in dev; the STM executor (blockL2 in
   `/v1/health/sync`) can lag the sync merge — always wait on *effects*
   (DB rows / API responses), never on wall-clock sleeps alone.

## 4. Existing helpers — REUSE, don't reinvent

| Path | What it gives you |
|---|---|
| `packages/tests/lib/wallet.ts` | `buildWallet(seedHex)`, `shieldedKeys`, `transferShielded`, `waitForShielded`, `waitForSync` |
| `packages/tests/lib/offer-files.ts` | `joinOfferFiles(wallet)` (join deployed contract), `mintShielded(deployed, domainSep, amount, nonce)` → token color |
| `packages/tests/lib/batcher.ts` | `mergeFinalized(txs)`, `nonDustImbalances`, `settleViaBatcher(tx)`, `describeImbalances` |
| `packages/tests/lib/api.ts` | typed client: `getZswaps`, `getZswapByHash`, `submitOffer`, `getZswapsPage` (MIP payload types) |
| `packages/tests/lib/db.ts` | `count(db, table)`, `waitFor(name, fn, tries, ms)`, `nullifiersGrew`, `offersGone` |
| `packages/tests/stm/api.test.ts` | END-TO-END REFERENCE: full maker→publish→index→read→reconstruct→merge→settle→archive flow. Copy its patterns. |
| `api-examples/09..11-*.ts` | submit-offer and settle-offer walkthroughs incl. `balanceFinalizedTransaction` taker flow |
| `packages/validator` | `validateZswapOffer(blob, opts)` (the rejection ladder — use to pre-verify adversarial fixtures reject for the RIGHT reason), `collectOutputCommitments`, `OfferFiles` re-export |
| `packages/offer-guard` | `offerHashFromBlob/Bytes`, `offerBytesToBech32`, `latin1ToBytes`, `mip6NamespaceBytes`, `guardOffer`, `DedupStore` |
| `packages/validator/fixtures/valid-offer.bech32` | a real Lace-made offer blob (for parse-level tests only — its coins don't exist on your fresh chain, so submitting it yields `ROOT_UNKNOWN`; useful for exactly that case) |

Maker offer construction (from `stm/api.test.ts`):
```ts
const r = await wallet.initSwap(
  { shielded: { [giveColor]: AMT } },
  [{ type: "shielded", outputs: [{ type: wantColor, amount: AMT, receiverAddress: myAddr }] } as any],
  shieldedKeys(w),
  { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
);
const blob = OfferFiles.encode((await wallet.finalizeTransaction(r.transaction)).serialize());
```
Submit-gate retry: on 400 `ROOT_UNKNOWN` retry every 5 s up to ~2 min (root
propagation), as `submitAndWaitRoot` does in `stm/api.test.ts`.

Taker settle (from `api-examples/11-settle-offer.ts`): deserialize the
detail's `offerBech32` → `wallet.balanceFinalizedTransaction(tx, keys, {ttl})`
→ `finalizeRecipe` → `settleViaBatcher` (or `submitTransaction`).
Alternative (two complementary offers, no balancing): `mergeFinalized`.

**Cancel construction:** maker simply spends the offer's input coin(s) in
ordinary transfer(s) to self: 1 tx for single-input-cancel (3.5), two txs
for split-cancel (3.3), spend only one of two coins for partial (3.4).

## 5. API surface being tested (summary — details in API.md)

`GET /v1/offers` (cursor pagination `after_hash`, filters `token`,
`direction`; rows are MIP `OffchainOfferPayload`, `offerBech32` OMITTED,
`blobChars` present) · `GET /v1/offers/:offerId` (blob included; resolves
archived) · `GET /v1/offers/:offerId/status` · `POST /v1/offers/status`
(`{offer}` or `{offers:[…≤50]}`) · `POST /v1/offers` (`{offer}` →
`{success, offerId, result}`) · `GET /v1/offers/stream` (SSE, `data:`-only
frames, dispatch on `type`; NOTE: events carry numeric row id in `offerId`
and the content hash in `offerHash` — correlate via `offerHash`) ·
`/v1/known-tokens` · `/v1/pairs` · `/v1/quote` · `/v1/chart/stats|history`
· `/v1/midnight/config` · `/v1/health` + `/v1/health/sync`.
Rate limit 60 req/min/IP → 429 (`{error:"RATE_LIMITED"}`).

Rejection codes to assert (submit + STM): `BAD_ENCODING`, `BAD_DESERIALIZE`,
`TOO_LARGE`, `NOT_A_SWAP`, `NO_SPENDABLE_INPUT`, `NULLIFIER_SPENT`,
`UTXO_NOT_LIVE` (API) / `UTXO_SPENT`+`UTXO_UNKNOWN` (validator codes),
`ROOT_UNKNOWN` (with `hint` + `diagnostics`), `DUPLICATE_OFFER` (HTTP 409),
`VALIDATION`, `INVALID_CURSOR`, `INVALID_HASH`, `NOT_FOUND`,
`RATE_LIMITED`. Crypto tamper (4.6) rejects with the crypto step's code —
assert it is NOT one of the structural codes above (proves crypto runs last).

## 6. Direct-Celestia publishing (adversary + path-B tool)

Celestia light node RPC: `http://127.0.0.1:26658` (auth token: read
`CELESTIA_AUTH_TOKEN` env; empty locally). Namespace bytes: use
`mip6NamespaceBytes()` from `@zswap-da/offer-guard` (29 bytes: version 0x00
+ 18 zero bytes + `6d6e2d737761702d7631`).

Reference for the wire format: the batcher's Celestia adapter
(`packages/batcher/` — see `buildBatchData`: bech32m → raw bytes → base64
`blob.data`). Publish via JSON-RPC `blob.Submit`:
```ts
await fetch("http://127.0.0.1:26658", { method: "POST",
  headers: { "Content-Type": "application/json", ...(token && {Authorization:`Bearer ${token}`}) },
  body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "blob.Submit",
    params: [[{ namespace: base64(namespaceBytes), data: base64(rawOfferBytes), share_version: 0 }], { gas_price: 0.002 }] }) });
```
Path-B positive (1.4): publish a VALID offer's raw bytes → assert indexed.
Adversarial (4.7): publish random bytes / truncated tx / replayed blobs →
assert `offer_rejections` rows (table `public.offer_rejections`, has
reason + celestia height) and ZERO `offer_file` rows for them.

## 7. Load plan (Phase 5)

**5a Cheap storm (no proving):** ≥ 2,000 invalid API submissions (rotate
the 4.x fixture kinds; run from ≥ 2 source IPs is not possible locally —
accept 429s as part of the assertion) + ≥ 300 direct-Celestia garbage
blobs at ~1/s. Assert: all rejected with correct codes, zero indexed, node
memory (RSS via `ps`) grows < 30%, API p95 < 500 ms during storm.

**5b Real storm:** fund **10 maker + 6 taker wallets** (deterministic seeds
`"00".."0f"` style, as `packages/tests` does: 64-hex strings). Funding
fan-out: genesis mints 2 shielded token types (reuse `mintShielded` with
distinct domainSeps) and transfers slices to each wallet — do transfers in
parallel batches. Then generate **500 offers** with wallet-level
parallelism (each wallet sequentially proves; 10 wallets ≈ 10× throughput;
expect ~60–90 min for generation+publication interleaved with the storms).
Mix: ~50% shielded↔shielded (two token pairs for chart assertions), ~25%
unshielded↔unshielded, ~25% mixed. Fates: 200 settled (takers run
concurrently, queue depth ≥ 4), 100 cancelled (all four shapes from §3),
100 expired (mass-expiry: publish, don't touch, wait out the 10-min TTL —
schedule these EARLY so expiry lands inside the run), 100 left live.

**Metrics to collect** (write `metrics.json` + a human `SCORECARD.md`):
submit p50/p95, publish→indexed latency histogram, STM lag over time
(blockL2 vs merge from `/v1/health/sync`), SSE delivery lag (event ts vs
DB `archived_at`), book p95 at max size, batcher queue depth, RSS of node
+ indexer processes, pglite DB size. First run = calibration (record);
subsequent runs enforce recorded values +20% margin (store baseline in
`baseline.json`, committed).

## 8. Chaos (Phase 6, during 5b)

- Kill the Midnight indexer (`pkill -f npm-midnight-indexer` child binary)
  → relaunch via `cd packages/contracts-midnight && bun run
  midnight-indexer:start` (it re-indexes from genesis with `--clean`;
  event-id regeneration is deterministic; our tables dedup on conflict).
  Assert: sync lag returns to ≤ 2, zero lost/duplicated offers vs a
  pre-kill snapshot.
- Kill/restart the node/STM process only (find the `sync` child of the
  orchestrator; if too entangled, document and skip — do NOT restart the
  orchestrator, that wipes pglite).
- Batcher restart with queued submissions → no double blob on Celestia
  (count blobs per height range before/after).

## 9. Determinism check (Phase 7a) — REQUIRED

After the storm quiesces (all fates settled, sync at tip):
1. `pg_dump` (or per-table CSV via `COPY`) all `public.*` tables ordered by
   PK → `state-A.sql`.
2. Stop the node/STM process; wipe ONLY its derived state? — NOT possible
   with shared pglite; instead: start a **second node instance** against a
   **fresh pglite on another port** (see `packages/node/main.dev.ts` +
   `config.dev.ts` for ports/env; set `EFFECTSTREAM_API_PORT=9998` and the
   pglite port env) pointed at the SAME Midnight node/indexer + SAME
   Celestia node, sync from height 1.
3. Wait until its blockL2 reaches instance A's height; dump → `state-B`.
4. Diff, excluding volatile columns: `created_at`/`recorded_at`
   wall-clock columns and framework `effectstream_tx_hash` (known
   nondeterminism, documented upstream). Everything else — offers, ids,
   hashes, legs, statuses, nullifiers, commitments, roots (first/last seen
   are chain-timestamp-derived and MUST match) — must be identical.
   `offerId` equality across instances is the cross-node identity claim of
   MIP-0005 — call it out in the scorecard.
If a second full node instance proves impractical (port collisions in
framework internals), the fallback (document which you used): re-run the
entire suite from scratch with identical seeds and diff final states
(costs a second 2 h run; acceptable).

## 10. Final invariant audit (Phase 7b)

Single pass, SQL + API, after everything:
- Partition: every offer in exactly one of `offer_file` /
  `offer_file_history`; `offer_hash` unique across both; equals
  sha256(decode(`transaction_hex`)) for every row (recompute in JS).
- Classification soundness: for every history row, recompute expected
  status from `nullifiers`/`commitments` ground truth in the test (not via
  the API) and compare with `GET /v1/offers/:id` — 100% agreement with the
  fates the test itself performed (its own ledger of intent is the oracle).
- Completeness: `count(nullifiers)` == nullifier events in
  `effectstream.primitive_accounting` (payload_type
  `Midnight:NullifierAndCommitment`, kind nullifier); same for
  commitments; same for unshielded creates/spends. THIS is the guard
  against silent-STF regressions.
- `known_roots`: all rows inside the 10-min window at audit time.
- Charts: `volume_base/quote` == Σ over the test's own fill ledger;
  cancels contribute 0; `/v1/chart/history` rows == fill count per pair.
- SSE ledger: exactly one `offer_indexed` per indexed offer, one terminal
  event per archived offer (match on `offerHash`).
- Shape guard: every offer-endpoint response validates against the codec's
  `OffchainOfferPayload` (import types from
  `@effectstream/mip-zswap-offer/mip6`) and contains no snake_case keys.
- Zero rows in `offer_file` with status other than live-set membership;
  zero unexpected `offer_rejections` (each must map to an adversarial
  action the test performed — keep a ledger of submitted garbage hashes).

## 11. Suggested file layout

```
packages/tests/grand-e2e/
  HANDOFF.md          ← this document
  run.ts              ← orchestrates phases, writes SCORECARD.md
  config.ts           ← scale knobs (offers=500, wallets, TTL expectations)
  ledger.ts           ← the test's own record of every action+expected fate
  actors/wallets.ts   ← funding fan-out, wallet pool
  actors/adversary.ts ← invalid fixtures + direct-Celestia publisher
  phases/p0-smoke.ts … p7-audit.ts
  metrics.ts          ← collectors + baseline enforcement
  baseline.json       ← calibration (commit after first full run)
```
Conventions: follow the repo style (see `packages/tests/stm/*`): plain bun
scripts with an `assert(name, fn)` helper, no test framework for the long
phases; deterministic seeds; NO `Math.random()` in anything that feeds the
determinism check; every phase idempotent-resumable is NOT required (a
failed run restarts the stack from scratch).

## 12. Definition of done

- `bun run test:grand` against a fresh `ROOT_WINDOW_SECONDS=600
  OFFER_TTL_SECONDS=600 bun run dev` stack completes in ≤ ~2.5 h and exits
  0 with a `SCORECARD.md` (all phases green, metrics vs baseline, the
  determinism diff summary, and the documented-gap assertions listed as
  such).
- Zero flakes across two consecutive full runs.
- Nothing added to CI. No changes to production code paths EXCEPT: if you
  find a real bug, STOP and report it in the scorecard rather than
  patching around it — finding bugs is this suite's purpose.
