# ZSwap Offerfile Kernel: Atomic Token Swaps on Midnight + Celestia DA

A decentralized token swap platform that combines **Midnight Network** (privacy-preserving ZK contracts) with **Celestia** (data availability layer). Users create atomic swap offers that are published to Celestia, indexed by the sync node, and completed on Midnight.

This repo is the **backend**: sync node, batcher, contracts, database, validator, the COW
solver (a separate process that quotes and settles against a Midnight Intents relay), and
e2e tests. It is frontend-agnostic — an example browser frontend lives in the [effectstream monorepo](https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da) (see [Frontend](#frontend)).

- **Backend (this repo):** https://github.com/effectstream/zswap-offerfiles-kernel
- **Example frontend:** https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da

Deployed app (preview network): https://zswap.zkdojo.com
Check deployed API playground: https://api-zswap.zkdojo.com/docs

## Quick Start

```bash
bun install
bun run dev   # PGLite + Compact compile + Midnight + Celestia + sync + batcher
```

On dev startup the `midnight-mint-test-tokens` process mints test tokens via the
offer-files contract (two shielded colors + one unshielded color to the genesis
wallet), so e2e swaps have real multi-token inventory and the unshielded
liveness sets receive on-chain events.

- API: http://localhost:9999
- API playground: `bun run docs:dev` → http://localhost:10601/docs/ (or build + http://localhost:9999/docs)
- Batcher: http://localhost:3334
- Proof server: http://localhost:6300 (`VITE_PROOF_SERVER_URL`)
- Orchestrator API: http://localhost:4747

### macOS note

macOS 26+'s dyld rejects the vendored `celestia-appd` binary with
`dyld: __DATA_CONST segment missing SG_READ_ONLY flag` (a stale Go/linker flag
in celestia-app v6.4.10). `bun run dev` and `bun run test` auto-heal this via
their `predev`/`pretest` hook (`scripts/patch-macos-celestia.ts`, run it
directly with `bun run fix:celestia`). The binary downloads lazily, so on a
brand-new checkout the **first** `bun run dev` may still crash once as it
downloads the unpatched binary — just run `bun run dev` again and the hook
patches it.

## Frontend

An **example** Vite + Midnight-wallet frontend lives in the effectstream
monorepo (formerly `paima-engine`) at
[`templates/zswap-da`](https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da).
It runs against this stack and doubles as a reference for wiring your own UI to
this backend.

Check out the effectstream monorepo as a **sibling** of this repo (the frontend
resolves `@zswap-da/contract-offer-files` via a relative `file:` dependency).
Start this repo's dev stack first (it compiles the Compact contract), then start
the frontend:

```bash
git clone git@github.com:effectstream/effectstream.git     # if not already checked out
cd effectstream/templates/zswap-da
bun install
bun run dev   # vite on :10600
```

The frontend fetches the API, the batcher, and all ZK assets from this backend:
`GET /keys/*` and `GET /zkir/*` serve the contract circuit keys (from
`packages/contracts-midnight/contract-offer-files/src/managed`) and the zswap +
dust primitive keys (from the Midnight ZK-params cache,
`~/.cache/midnight/zk-params`, override with `MIDNIGHT_ZK_PARAMS_DIR`). Without
the primitive keys the browser mint fails with
`GET /keys/midnight/zswap/output.prover 404` — run the proof server once (the
dev stack does) to populate the cache.

## Environments

| Layer | Dev (`bun run dev`) | Mainnet (`bun run start:mainnet`) |
|-------|---------------------|------------------------------------|
| DA | Local Celestia devnet (`packages/contracts-celestia`) | Celestia mainnet beta via local light node |
| Privacy chain | Local Midnight devnet (`packages/contracts-midnight`) | Midnight (the `@effectstream/midnight-contracts` resolved networkId) |
| Database | PGLite (in-memory) | PGLite (in-memory) |
| Node entry | `packages/node/main.dev.ts` | `packages/node/main.mainnet.ts` |
| Batcher entry | `packages/batcher/batcher.dev.ts` | `packages/batcher/batcher.mainnet.ts` |
| Orchestrator | `start.dev.ts` | `start.mainnet.ts` |
| COW solver | **separate process** — `bun run start:solver` (or `packages/solver/solver.dev.ts`) | **separate process** — `bun run start:solver` (or `packages/solver/solver.mainnet.ts`) |
| Price feed | **separate process, optional** — `bun run --filter @zswap-da/price-feed start` (or `… once` for a single refresh) | same, plus the `price-feed` compose service (`--profile prices`) |

**Neither orchestrator launches the solver.** `start.dev.ts` and `start.mainnet.ts`
bring up chain, database, node and batcher only; see
[Running the COW solver](#running-the-cow-solver).

**The price feed is optional.** `start.dev.ts` registers it only when
`COINGECKO_API_KEY` is set, and never as a system-dependency, because
`packages/database/migrations/000-init.sql` **seeds** real reference prices
(captured 2026-09-02): a stack that never runs it still quotes 1 WBTC ≈ 32 WETH
rather than a colour-hash rate. See [Reference prices](#reference-prices).

## Reference prices

`GET /v1/prices` serves the USD prices behind `GET /v1/quote` and behind the
batcher's fee sponsorship. USD is the numeraire: every price is a USD price and
no asset — stablecoins included — is assumed to be worth one dollar. Three
tables back it:

| Table | Holds |
|---|---|
| `asset_prices` | USD **per coin** for a tradable asset, keyed by its CoinGecko id. Seeded in `000-init.sql` with values captured 2026-09-02 |
| `known_tokens` | a colour's `decimals` (base units per coin) and optional `asset_id`. Prices are served **per base unit**, i.e. the asset price ÷ `10^decimals` |
| `token_prices` | only operator overrides (`manual`) and the deterministic demo rows (`fallback`) for tokens with no asset behind them |

Tokens map to assets **by name** — `WBTC`/`WSBTC`/`BTC` → `bitcoin`, `WETH`/`WSETH`/
`ETH` → `ethereum`, `USDC` → `usd-coin`, `USDM` → `usdm-2`, `NIGHT` → `midnight-3` —
because faucet-minted colours derive from the contract address and change on every
clean redeploy. `known_tokens.asset_id` overrides the map; `PRICE_FEED_MAP`
(`NAME_OR_COLOR=<asset_id>[:decimals],…`) overrides the defaults.

`packages/price-feed` refreshes `asset_prices` from CoinGecko. It is a process of
its own — the node never makes an outbound price call:

```bash
bun run --filter @zswap-da/price-feed once    # one refresh, exit 0 (all) / 2 (partial)
bun run --filter @zswap-da/price-feed start   # loop, one cycle a day
docker compose run --rm price-feed --once     # the same, in deploy/
```

One cycle is five requests (`bitcoin`, `ethereum`, `usd-coin`, `midnight-3`,
`usdm-2`) issued one at a time, at least a second apart, stopping at the first
`429`. About 5 calls a day.

| Variable | Default | Meaning |
|---|---|---|
| `COINGECKO_API_KEY` | — | Required to fetch. Sent as the `x-cg-demo-api-key` header, never in a query string. Without it `--once` exits 64 and loop mode idles |
| `COINGECKO_BASE_URL` | `https://api.coingecko.com/api/v3` | Point at a stub in tests |
| `PRICE_FEED_INTERVAL_MS` | `86400000` | Loop period |
| `PRICE_FEED_REQUEST_SPACING_MS` | `1000` | Minimum gap between two requests |
| `PRICE_FEED_ASSETS` | the five seeded ids | Comma-separated CoinGecko ids |
| `PRICE_FEED_MAP` | — | Node + feed: `NAME_OR_COLOR=<asset_id>[:decimals],…`. A malformed entry is a startup error, never a silent skip |
| `SPONSOR_DISCOUNT_BPS` | `250` | How far below reference an offer must be priced to earn fee sponsorship. Published in `/v1/prices.sponsor_discount` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PW` / `DB_NAME` | `127.0.0.1` / `5432` / `postgres` / `postgres` / `postgres` | Where the feed writes |

## Running the COW solver

The solver is a **component of its own**, not part of the backend command. It is
one process that attaches to an already-running kernel API and to a Midnight
Intents relay, mirrors the Offer Files book, publishes price ladders, and
settles relay-dispatched swap jobs from its own wallet.

```bash
bun run start:solver          # the one documented deployment entrypoint
```

`bun run start:mainnet` deliberately does **not** start it. Trading must be an
explicit act: folding the solver into the backend command would let an operator
who only wanted an indexer end up with a wallet-spending process attached to a
relay. The per-network entrypoints (`packages/solver/solver.{dev,preview,mainnet}.ts`)
remain available for local work; `start.solver.ts` is the network-agnostic one a
container runs.

**Mandatory configuration.** `start:solver` resolves and validates everything
below *before* it opens a wallet, a socket, or the journal, and a startup that
is missing or malformed values exits non-zero listing **every** problem at once
(one restart shows the whole list):

| Variable | Why it is mandatory |
|---|---|
| `MIDNIGHT_NETWORK_ID` | The SDK silently defaults to `undeployed`; a deployment must declare its network. An unknown value is refused rather than turned into generated `https://rpc.<typo>.midnight.network` URLs. |
| `ZSWAP_API` | Kernel Offer Files REST/SSE base. Otherwise defaults to `http://127.0.0.1:9999`, a developer default. |
| `SOLVER_RELAY_WS_URL` | Outbound Midnight Intents solver socket (`ws://`/`wss://`, no embedded credentials). |
| `SOLVER_RELAY_HTTP_URL` | The relay's public HTTP base for durable `GET /jobs/:jobId` recovery. Never derived from the websocket URL — deployed prefixes differ (for example `/api/v1`). |
| `SOLVER_RELAY_AUTH_TOKEN` | Shared relay bearer, at least 32 characters (the relay refuses shorter). The kernel exact-files read stays unauthenticated. |
| `SOLVER_JOURNAL_PATH` | Absolute path on a persistent per-instance volume. `:memory:` is impossible here. |
| `SOLVER_SEED` | An unset seed silently selects the repository's public dev seed. That seed is accepted only on `MIDNIGHT_NETWORK_ID=undeployed`. |

The relay URLs, the token and the journal are required **in dry-run too**: a
rehearsal that leaves half the configuration unvalidated is not a rehearsal.
`SOLVER_ENABLED=false` exits 0 without demanding any of it. On `mainnet`,
`SOLVER_DRY_RUN` defaults to `true` and live settlement additionally requires the
exact `SOLVER_MAINNET_LIVE_TRADING_ACK=true` — the same boundary
`solver.mainnet.ts` enforces, so this entrypoint is not a cheaper route to live
trading. Startup prints the resolved topology with no secret in it (the seed
never appears; the bearer only as its length).

A container deployment runs exactly this command as its solver service, with the
journal path pointing into a mounted volume, and depends on the kernel and relay
services rather than launching them.

### What the solver supports (and what it does not)

- **Midnight 1.x / ledger-v8 only**, single-leg **shielded** offers with two
  distinct token colors and positive amounts, at most **8 makers** per job, plus
  an optional shielded residual paid from solver inventory. Unshielded legs,
  mixed value layers, multi-leg baskets and Midnight 2.x are out of scope and
  are refused before admission, not partially supported.
- Maker offers are built `payFees:false`, so the maker's offer carries no fee
  payment: **the settling side pays**. The solver sizes and pays DUST for the
  settlement it submits, under the `SOLVER_DUST_*` admission budget. Sizing that
  fee requires **no swap-token inventory at all** — see
  [`SOLVER_FEE_SIZING_TAKER_INPUTS`](#fee-sizing-solver_fee_sizing_taker_inputs).
  The solver still needs NIGHT/DUST to pay the fee itself.
- Published ladders are indicative data for the relay's own interpolation, not
  reservations. Job admission is re-decided at job time against the current
  book, inventory and policy.

### Job semantics: lower demands settle, surplus stays with the solver

**Behavior change.** A dispatched job carries the taker's exact demand, which the
reference relay allows to be *below* the solver's advertised interpolated
output. The solver now accepts every job with
`0 < amountOut <= interpolate(amountIn)`:

- the maker prefix is chosen exactly as before (largest whole-offer prefix whose
  input fits `amountIn`);
- if the prefix pays less tokenOut than the demand, the difference is a
  **residual** the solver pays from inventory (`Stock`), reserved as before;
- if the prefix pays more, the difference is **surplus that the solver keeps**,
  together with any unspent tokenIn — matching the reference solver, which keeps
  `dy - requiredOutput`.

Jobs above the advertised output are still refused, as are jobs outside the
published ladder, non-positive demands, stale routes, disallowed pairs,
below-minimum outputs and unaffordable residuals. Previously these lower demands
were refused as `route_not_current`; deployments that relied on that refusal will
now see them settle.

### The solver needs NO token inventory to quote whole-maker rungs

**Availability change.** Sizing the settlement's DUST fee no longer touches the
solver's coins: the taker's half is modelled by a *synthetic* transaction built
from ledger primitives with the taker half's shape, because the DUST fee is a
function of transaction structure only. So:

- **every whole-maker rung is publishable and settleable by a solver holding
  zero of both tokens.** The maker offer being consumed pays the rung; the
  solver contributes nothing but the fee;
- **tokenOut is needed only for *interior* sizes.** Publishing a second rung
  opens the interpolated interval below it, and any size inside that interval is
  served as "consume the whole prefix, then top up the difference from solver
  inventory". A rung whose interval could demand a tokenOut residual larger than
  available `Stock` is withheld, **and so is every rung above it**. With zero
  tokenOut the solver therefore publishes each pair's first rung and no more;
- `SOLVER_SUPPORTED_PAIRS` and `SOLVER_MIN_JOB_OUTPUT` bound publication as well
  as admission (they previously bounded admission only), and are re-applied on
  every reconnect;
- inventory readiness republishes immediately on both edges, so a failed or
  in-flight balance refresh withdraws residual-bounded rungs instead of
  advertising them for up to one push interval.

Withheld liquidity is reported once per change through the
`ladder-budget-limited` / `ladder-budget-cleared` operator events, so a shrunk
ladder is visible rather than silent.

> Earlier builds also capped published rung inputs by the tokenIn the solver
> could prove spendable — a solver holding no tokenIn published nothing for that
> pair — because fee sizing spent the job's full `amountIn` out of the solver's
> own wallet and reverted it. That cap is **gone**. Operators no longer need to
> fund both sides of a pair; deployments that provisioned the solver with tokenIn
> purely to make it quote can stop.

### Fee sizing: `SOLVER_FEE_SIZING_TAKER_INPUTS`

The solver never sees the taker's half — the relay merges it — so it cannot know
how many zswap inputs the taker's own coin selection produced. It therefore
models a fixed number, and that number is the one knob:

| | |
|---|---|
| `SOLVER_FEE_SIZING_TAKER_INPUTS` | Optional. Integer in `[1, 64]`, default **1**. Malformed values are a listed `start:solver` launch problem, never a silent default. |

**Coverage rule (measured).** A stand-in modelling `n` taker inputs funds a real
taker half of up to **`n + 2`** zswap inputs. The default of 1 therefore covers
takers paying from up to three coins, which is what the deployed E2E exercises,
and it reserves exactly the DUST the previous mirror-based design did.

**Raising it costs real DUST.** Each extra modelled input adds **12–14 %** to the
reserved fee, and the DUST intent *spends* the estimate rather than merely
holding it — so a higher value also consumes `SOLVER_DUST_MAX_PER_JOB` /
`SOLVER_DUST_MAX_PER_WINDOW` budget faster. Raise it only if settlements start
failing at submit time because a taker's balance is fragmented across many small
coins; that failure is an availability failure (the chain rejects the merged
transaction, the relay reports `submit-failed`, and the solver's contribution is
reverted), not a loss of funds. The startup banner prints the effective model and
its coverage.

## Mainnet environment

Mainnet uses a locally-running Celestia light node — start it yourself before launching the template:

```bash
celestia light init --p2p.network celestia
celestia light start --core.ip <consensus-rpc> --core.port 9090 --core.tls --p2p.network celestia
celestia light auth admin --p2p.network celestia   # paste into CELESTIA_AUTH_TOKEN
```

Fund the `celestia1...` address shown by `celestia state account-address` with TIA before submitting blobs.

| Env var | Required | Purpose |
|---------|----------|---------|
| `CELESTIA_NETWORK` | yes | Must be `mainnet`. |
| `CELESTIA_RPC_URL` | yes | Light node JSON-RPC, default `http://127.0.0.1:26658`. |
| `CELESTIA_AUTH_TOKEN` | yes | Admin JWT from `celestia light auth admin`. |
| `CELESTIA_NAMESPACE` | recommended | 10-byte hex (padded to 28). Default `000000000000deadbeef`. |
| `CELESTIA_START_HEIGHT` | optional | Pin Celestia sync start. Defaults to current chain head. |
| `CELESTIA_GAS_PRICE`, `CELESTIA_MAX_GAS_PRICE`, `CELESTIA_TX_PRIORITY`, `CELESTIA_GAS` | optional | Tx-config knobs that skip on-chain estimator calls (avoid rate-limit 429s). |
| `CELESTIA_POLLING_INTERVAL_MS` | optional | Sync cadence. Defaults: devnet 6 000 ms, mainnet 30 000 ms. |
| `MIDNIGHT_START_BLOCK` | yes | Numeric block height to start Midnight sync from. |
| `NTP_START_TIME` | optional | NTP reference timestamp; resumed from DB when unset. |
| `BATCHER_SUBMIT_TIMEOUT_MS` | optional | Absolute batcher fetch + receipt-body deadline; default 310 000 ms, bounded to 1 000–600 000 ms. |
| `API_SSE_MAX_CONNECTIONS` | optional | Per-node concurrent `/v1/offers/stream` cap; default 100. Excess clients receive `503 SSE_CAPACITY`. |
| `API_UPDATES_MAX_CONNECTIONS` | optional | Per-node concurrent `/v1/offers/updates` websocket cap; default 100. Excess clients are refused the connection (this endpoint's refusals are disconnects, not HTTP statuses — see API.md). |
| `OFFER_FILES_READ_TIMEOUT_MS` | optional | Exact-files read decision budget, default 15 000 ms and capped at 60 000 ms. Native synchronous proof work cannot be preempted; a retained concurrency slot bounds unfinished work. |
| `ZSWAP_API` / `SOLVER_SEED` / `MIDNIGHT_NETWORK_ID` | **required by `start:solver`** | Kernel API base, solver wallet seed, and the declared network. Each has a silent developer default (`http://127.0.0.1:9999`, the public dev seed, `undeployed`) that `start:solver` refuses to assume — see [Running the COW solver](#running-the-cow-solver). |
| `SOLVER_RELAY_WS_URL` / `SOLVER_RELAY_AUTH_TOKEN` | required for live solver mode (and by `start:solver` in every mode) | Outbound Midnight Intents solver WebSocket and its shared bearer (at least 32 characters). The backend exact-files read is unauthenticated. |
| `SOLVER_RELAY_HTTP_URL` | **required for relay job execution** | Explicit public relay HTTP base for durable `GET /jobs/:jobId` recovery. It is validated independently and is never derived by rewriting the websocket URL. |
| `SOLVER_JOURNAL_PATH` | **required for relay job execution** | Absolute path to the solver-local SQLite wallet-operation journal on a persistent mounted volume. Startup fails closed if it is missing, unwritable, corrupt, locked, full, or schema-incompatible. |
| `SOLVER_RELAY_MAX_PARALLEL_SWAPS` | optional | Advertised and enforced concurrent proof-build bound; default 8. |
| `SOLVER_RELAY_PUSH_INTERVAL_MS` / `SOLVER_RELAY_RECONNECT_DELAY_MS` | optional | Complete ladder replacement cadence (default 1 000 ms) and reconnect delay (default 2 000 ms). |
| `SOLVER_STATUS_POLL_MS` / `SOLVER_SETTLE_TTL_MINUTES` | optional | Backend-consumption backstop cadence and chain-TTL wallet rollback window. |
| `SOLVER_SUPPORTED_PAIRS` | optional (UNSET is OPEN + warning) | Strict JSON array of unique directed lowercase `64hex->64hex` pairs. SET is enforced in ladder publication (including after a reconnect) and in job admission. |
| `SOLVER_MIN_JOB_OUTPUT` | optional (UNSET is OPEN + warning) | Strict JSON object from lowercase output-token `64hex` to positive canonical integer strings. A SET map omits tokens without a minimum and sub-minimum rungs/jobs. |
| `SOLVER_DUST_MAX_PER_JOB` / `SOLVER_DUST_MAX_PER_WINDOW` / `SOLVER_DUST_WINDOW_MS` | optional as one group (UNSET is OPEN + warning) | All three must be SET together. Amounts are positive canonical decimal bigints; window is a positive safe integer in ms. Reservations are journal-durable and rolling-window bounded. |
| `SOLVER_ADMISSION_WARNING_INTERVAL_MS` | optional | Startup/periodic warning cadence for every UNSET admission group; positive safe integer, default 900000. |
| `SOLVER_DRY_RUN` / `SOLVER_MAINNET_LIVE_TRADING_ACK` | mainnet safety boundary | Mainnet defaults to dry-run, which now requires and syncs the real funded wallet and loads read-only Stock while starting no relay jobs. Live settlement additionally requires the exact `SOLVER_MAINNET_LIVE_TRADING_ACK=true` acknowledgement. |

A complete dev → mainnet env template lives at `.env.mainnet.example`.

> **BREAKING DEPLOYMENT REQUIREMENT (RF1/RF2):** relay job execution now requires
> both a durable `SOLVER_JOURNAL_PATH` and an explicit
> `SOLVER_RELAY_HTTP_URL`. Provision one persistent volume per solver
> instance and mount it at a stable absolute path (for example,
> `/var/lib/cow-solver/operations.sqlite`) before upgrading. Never share one
> journal file between instances. `:memory:` is rejected by production code;
> its explicit escape hatch exists only for isolated test harnesses. Configure
> the relay's public HTTP base directly; do not infer it from the websocket URL.

> **BREAKING DRY-RUN DEPLOYMENT CHANGE (RF3):** mainnet dry-run now refuses the
> repository dev seed, opens and syncs the configured real wallet, and loads a
> read-only inventory snapshot. It starts no relay socket/job executor and calls
> no mutating wallet method. Operators must therefore provision `SOLVER_SEED`
> and wallet/indexer/proof connectivity for dry-run as well as live mode.

Admission groups deliberately preserve the pre-RF3 OPEN default when wholly
UNSET, but log a contained `[ADMISSION]` warning at startup and every configured
warning interval. Malformed or partially-set groups fail startup; there is no
silent coercion. For real-funds rollout, SET all three policy groups explicitly.

## Effectstream whole-block fail-stop operations

This release accepts an availability limitation in the pinned Effectstream
0.103.1 runtime: one scheduled application input that throws after a write, or
one SQL statement that fails, rolls back the **entire L2 block** and leaves the
scheduled input retained. This preserves database integrity—no partial block,
pre-fault application write, or successful-input result commits—but progress
halts at that block until an operator resolves the poison input. It is not
per-input isolation and must be treated as an incident, not an automatic skip.

Use this operating sequence:

1. **Detect and contain.** Treat a repeatedly failing block, a stalled
   `effectstream.effectstream_blocks` height, or an application-transition
   failure followed by PostgreSQL `25P02` as a fail-stop incident. Stop the
   affected node and its restart loop. Stop solver job execution that depends
   on that backend and confirm it is no longer publishing routable ladders
   before touching state.
2. **Preserve evidence.** Record the deployed commit and Effectstream version,
   the last committed and failing heights, the exception/SQLSTATE, and the
   suspected scheduled-input identity and payload. Take a storage snapshot or
   backup before any state-changing remediation.
3. **Inspect read-only.** Against the stopped instance, use a read-only
   transaction to inspect the committed boundary and retained inputs, for
   example:

   ```sql
   BEGIN TRANSACTION READ ONLY;
   SELECT block_height
     FROM effectstream.effectstream_blocks
    ORDER BY block_height DESC
    LIMIT 5;
   SELECT id, input_data
     FROM effectstream.rollup_inputs
    ORDER BY id;
   ROLLBACK;
   ```

   Correlate the exact input with logs and inspect every application table the
   transition could have written. The failed block and its pre-fault writes
   must be absent, while the authoritative scheduled input remains.
4. **Remediate deliberately.** Prefer correcting the application, runtime, or
   configuration so the retained input can replay unchanged. If an invalid or
   hostile input can never succeed, its quarantine or removal requires an
   incident-specific, reviewed migration/tool that pins the exact input
   identity and expected payload, checks the backup, runs transactionally, and
   records the disposition. Do **not** run an ad-hoc `DELETE` against
   `effectstream.rollup_inputs`; the direct deletion in the regression test is
   test-only and is not a production procedure.
5. **Recover in isolation.** Apply the reviewed fix while all writers remain
   stopped. Start one node first, with solver execution still withdrawn, and
   let it replay from the last committed boundary. Restore replicas only after
   that node is current and stable; restore the solver only after its backend
   mirror re-establishes currentness and its normal journal reconciliation
   completes.
6. **Verify replay before closing the incident.** Confirm the blocked height
   commits exactly once and later heights advance; the retained input either
   completes normally or has the reviewed disposition; no pre-fault partial
   row or duplicate application event exists; and backend health, offer
   liveness, solver empty-to-current ladder recovery, and durable wallet-job
   reconciliation are all healthy. Archive the queries, logs, backup identity,
   remediation artifact, and verification results with the incident.

The long-term fix is upstream savepoint-based per-input database and rejected-
promise isolation. This branch deliberately does not fork Effectstream or
pretend the current whole-block mode provides that availability guarantee.

## Testing

```bash
bun run test
```

Boots the same undeployed stack as `bun run dev` (PGlite `:5432`, Midnight
node/indexer/proof-server, Celestia, sync `:9999`, batcher `:3334`) via
`packages/tests/start.test.ts`, then runs:

| Phase | Coverage |
|-------|----------|
| **A** | Celestia + Midnight readiness |
| **B** | Offer build → submit → index → settle, asserting **PGlite** deltas |

Phase B cases (`packages/tests/stm/`):

1. **zswap-flow** — shielded A↔B, wallet settle → `offer_file` → history `CONSUMED`, `nullifiers`↑, `known_roots` advanced
2. **api** — two opposing makers via `POST /v1/offers`, merge + batcher settle, balances; negatives `BAD_ENCODING` / `NULLIFIER_SPENT` never index
3. **multi-token** — multi-give `{T0,T1}` ↔ multi-want `T2`, batcher settle
4. **unshielded-only** — unshielded↔unshielded; spend shrinks `created_unshielded` (no `spent_*` table)
5. **root-unknown** — well-formed offer rejected with `ROOT_UNKNOWN`; `offer_file` unchanged

Shared DB helpers: `packages/tests/lib/db.ts` (`nullifiers`, `created_unshielded`, archive `CONSUMED`).

### Standalone swap e2e scripts

These expect a live `bun run dev` stack. Multi-token, unshielded-only, and
root-unknown are thin wrappers over the Phase B modules above. Shared helpers
live in `packages/tests/lib/`.

```bash
bun packages/tests/ring-swap-e2e.ts 2        # A↔B swap (2-cycle), batcher-settled
bun packages/tests/ring-swap-e2e.ts 3        # ring a→b→c→a (merge N proven offers)
bun packages/tests/multi-token-swap-e2e.ts   # multi-give {T0,T1} ↔ multi-want {T0,T1}
bun packages/tests/api-roundtrip-swap-e2e.ts # push → read /v1/offers → reconstruct → settle
                                             #   + negatives: corrupted (BAD_ENCODING) and
                                             #     consumed (NULLIFIER_SPENT) never reach Celestia
bun packages/tests/root-unknown-negative-e2e.ts  # well-formed offer rejected by past_roots gate
bun packages/tests/unshielded-only-swap-e2e.ts   # unshielded↔unshielded (taker-balanced + batcher dust)
bun packages/tests/unshielded-diagnose.ts        # diagnostic: shielded vs unshielded offer structure
```

Swap-shape support note: shielded-only and unshielded-only swaps work; **combined
shielded↔unshielded swaps are not supported by the wallet SDK yet** (the SDK's own
`facade/test/swap.test.ts` marks it `it.skip(… "Not supported yet")`).
`packages/tests/unshielded-swap-e2e.ts` documents this by attempting a mixed swap
and skipping safely when the offer comes out give-only.

## Project Structure

```
zswap-offerfile-kernel/
├── start.dev.ts                              # Local orchestrator config (no solver)
├── start.mainnet.ts                          # Mainnet orchestrator (+ light-node pre-flight; no solver)
├── start.solver.ts                           # COW solver component (bun run start:solver)
├── packages/
│   ├── node/                                 # @zswap-da/node
│   ├── database/                             # @zswap-da/database
│   ├── validator/                            # @zswap-da/validator (shared offer validation)
│   ├── batcher/                              # @zswap-da/batcher
│   ├── solver/                               # @zswap-da/solver (book mirror, ladders, swap-job settlement)
│   ├── solver-core/                          # @zswap-da/solver-core (shared clients, ladder derivation, contracts)
│   ├── offer-guard/                          # @zswap-da/offer-guard (checks node + batcher must agree on)
│   ├── price-feed/                           # @zswap-da/price-feed (daily CoinGecko refresh; optional process)
│   ├── contracts-midnight/                   # @zswap-da/contracts-midnight (+ contract-offer-files subworkspace)
│   ├── contracts-celestia/                   # @zswap-da/contracts-celestia (bridge + fund scripts)
│   └── tests/                                # @zswap-da/tests
```

The example frontend (React + Vite + Midnight wallet) lives in the effectstream
monorepo at
[`templates/zswap-da`](https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da).

## Key files

| Package | Files |
|---------|-------|
| `node/` | `main.{dev,mainnet}.ts`, `config.{dev,mainnet}.ts`, `env.ts` (env-derived constants), `grammar.ts`, `state-machine.ts`, `api.ts`, `prices.ts` (price resolution + `GET /v1/prices`), `docs.ts` (`GET /docs` serves Vite playground dist), `zk-assets.ts` (`/keys/*`, `/zkir/*` static ZK assets), `zswap-logic.ts`, `batcher-client.ts`, `event-bus.ts` |
| `database/` | `mod.ts` (re-exports), `migration-order.ts`, `migrations/000-init.sql` (THE schema — one file applied from zero; there is no numbered chain, and the 001/002 files this table used to list are gone), `migrations/local-migration.sql` (local-only additions), `price-map.ts` (token NAME → reference asset, per-base-unit conversion), `sql/queries.sql` (+ generated `queries.queries.ts`), `sql/queries.app.ts` |
| `validator/` | `validate.ts` (pipeline), `derive.ts`, `refstate.ts`, `types.ts`, `README.md`, `scripts/check-preview-indexer.ts` |
| `batcher/` | `batcher.{dev,mainnet}.ts`, `config.ts`, `midnight-balancing.ts`, `celestia.ts` (`ZswapCelestiaAdapter.validateInput` — pre-fee offer gate) |
| `contracts-midnight/` | `package.json` (scripts for `launchMidnight`), `deploy.ts`, `contract-offer-files/` (Compact source + compiled output) |
| `contracts-celestia/` | `package.json` (`celestia-{node,bridge,fund}:*` scripts), `fund-bridge.ts` |
| `solver/` | `solver.{dev,preview,mainnet}.ts` (per-network entrypoints), `env.ts`, `src/launch.ts` (the `start:solver` configuration contract), `src/run.ts` (`runSolver`), `src/book-sync.ts`, `src/ladder-source.ts`, `src/relay-client.ts`, `src/swap-job-executor.ts`, `src/stock.ts`, `src/operation-journal.ts` |
| `solver-core/` | `api-client.ts` (kernel REST/SSE + exact files), `ladder-derivation.ts`, `admission-policy.ts` (one typed policy for publication and admission), `relay-ws-contract.ts`, `receipt-client.ts`, `batcher.ts`, `wallet.ts` |
| `offer-guard/` | `mod.ts` (offer hash, guard ladder, dedup store), `sponsorship.ts` (`evaluateSponsorship()` — the ONE fee-sponsorship rule, shared by the quote, the node pre-check and the batcher) |
| `price-feed/` | `price-feed.{dev,preview,mainnet}.ts`, `src/config.ts`, `src/coingecko.ts` (one asset per request, key as a header), `src/cycle.ts` (spacing, 429 stop, status row), `src/run.ts` (`--once` vs loop, retry ladder, exit codes) |
| `tests/` | `run-tests.ts`, `start.test.ts` (test orchestrator), `helpers.ts`, `lib/db.ts`, `infra/{celestia,midnight}-ready.test.ts`, `stm/{zswap-flow,api,multi-token,unshielded-only,root-unknown}.test.ts` |

## Services & ports

| Service | Port |
|---------|------|
| Backend API | 9999 |
| Batcher | 3334 |
| Orchestrator | 4747 |
| PGLite | 5432 |
| Celestia consensus | 26657 |
| Celestia bridge RPC | 26658 |
| Midnight node | 9944 |
| Midnight indexer | 8088 |
| Midnight proof server | 6300 |
| COW solver | **none** — outbound only (kernel API + relay websocket); it listens on no port |
| Price feed | **none** — outbound only (CoinGecko) plus the database; it listens on no port |

## Grammar / state-machine inputs

| Key | Source | Purpose |
|-----|--------|---------|
| `celestia-zswap` | Celestia DA primitive | Validate a published offer blob (structure + ZK proofs + spent-set liveness), then index it (gives/wants, nullifiers, unshielded spends; schedule TTL cleanup) or drop + emit `offer_rejected`. |
| `midnight-zswap` | Midnight ledger primitive | Snapshot contract state. |
| `midnight-nullifier` | Midnight nullifier primitive | Record the nullifier in `spent_nullifiers` (liveness) and archive any offer whose shielded nullifier is consumed on chain. |
| `midnight-unshielded-spend` | Midnight unshielded-spend primitive | Record the UTXO in `spent_unshielded` (liveness) and archive any offer whose unshielded UTXO is spent. |
| `midnight-unshielded-create` | Midnight unshielded-create primitive | Record every created unshielded UTXO in `created_unshielded` (existence liveness). |
| `midnight-zswap-root` | Midnight zswap-root primitive | Record the coin-tree root in `known_roots` and prune to `ROOT_WINDOW_SECONDS` (root-known liveness). |
| `zswap-ttl-cleanup` | Scheduled timestamp data | Archive offers whose TTL elapsed without on-chain consumption. |

## API

**Interactive playground (try upload / settle / wallet mint live):**
`bun run docs:dev` → [http://localhost:10601/docs/](http://localhost:10601/docs/)
(Vite + React). After `bun run docs:build`, the node also serves it at
[http://localhost:9999/docs](http://localhost:9999/docs). Proof server URL comes
from `VITE_PROOF_SERVER_URL` (local default `http://localhost:6300`).
**Full request/response reference with curl examples: [API.md](API.md).**
The table below is a quick index; API.md documents every field, error code, the
batcher endpoints, and direct Celestia access.

There are **two ways** to post and read offers:

- **Via this backend (recommended for apps):** `POST /v1/offers` validates
  an offer (structure + ZK proofs + liveness) *before* any Celestia fee, then
  forwards it; `GET /v1/offers` returns validated, indexed, liveness-checked
  offers as MIP-0006 `OffchainOfferPayload`s. See API.md.
- **Directly on Celestia:** post with `blob.Submit` / read with `blob.GetAll`
  against the same Celestia node — the backend is a convenience layer, not a
  gatekeeper. Use for archival/mirroring or independent verification. See
  [API.md → Direct Celestia access](API.md#direct-celestia-access-bypassing-this-backend).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/offers?limit&token&direction&after_hash` | Open offers as MIP-0006 payloads (`offerId` + `computed.*`). Blob-free and cursor-paginated: `offerId` is the sha256 of the raw offer bytes — stable across nodes. |
| `GET` | `/v1/offers/:offerId` | One offer **including its `swapoffer1…` string** (`offerBech32`), by content hash. Resolves archived offers with their final status. |
| `GET` | `/v1/offers/:offerId/status` | Lightweight status probe by content hash. |
| `POST` | `/v1/offers/status` | Status by blob (`{offer}` or `{offers: […]}`, max 50) — POST body because real blobs are 16–25 KB. |
| `POST` | `/v1/offers/files` | Exact-files read: 1–8 content identities in, exact indexed bytes out for the live+valid ones and a stable verdict for the rest. Side-effect-free; current state is re-read after proof verification. |
| `GET` | `/v1/known-tokens` | Token color → name registry. |
| `POST` | `/v1/known-tokens` | Register a token name/color/kind (dev/e2e only; off in production). |
| `GET` | `/v1/midnight/config` | Public Midnight config the browser contract client needs. |
| `POST` | `/v1/offers` | Fully validate an offer (structure + ZK proofs + liveness); `400 {error, reason}` on failure, `409` on duplicate, else forward to the batcher → Celestia. Returns the offer's `offerId`. |
| `GET` | `/v1/offers/stream` | Server-Sent Events stream for offer lifecycle (indexed / consumed / expired). |
| `GET` | `/v1/offers/updates` | Websocket update stream carrying the same lifecycle events, plus a per-subscription sequence number so a consumer mirroring the book can prove it missed nothing. |

Beyond the above, the node also serves `GET /health`, `GET /v1/health/sync`,
`GET /v1/pairs`, `GET /v1/quote`, and
`GET /api/chart/{stats,history}` — all detailed in [API.md](API.md).

## Celestia data retention (read before relying on history)

Celestia prunes blob data after **~7 days** (CIP-36 sampling window; pruning
default-on since celestia-node v0.25.3; storage window = 7d + 1h). Celestia's
official position: *"rollups and applications are responsible for storing their
historical data"* — there is no native archival product (namespace pinning is a
long-open feature request).

What this means here:

- **Our Postgres already archives every valid offer permanently**
  (`offer_file.transaction_hex`, including `offer_file_history`) — historical
  analysis of offers is served by our own DB, not by Celestia.
- **A fresh node cannot sync the namespace from genesis once blobs are >7d
  old** via ordinary Celestia nodes. Bootstrap options: an archival endpoint
  (run `celestia ... --archival`, or providers — QuickNode; community archival
  RPCs), the free Arweave-backed **KYVE Trustless API** (`blob.Get`-compatible),
  **Celenium** API, or a DB snapshot / blob mirror we publish.
- **Mirroring recipe** (e.g. S3/R2 public good, requester-pays for readers):
  at ingestion (we see every namespace blob, including third-party posts) store
  `{height, namespace, commitment, blob, pfb_txhash, inclusion_proof}`. The
  share commitment is recomputable from the bytes (self-verifying integrity);
  the inclusion proof must be captured **within the 7-day window**
  (`blob.GetProof`) for provable on-chain history after pruning.
- Note the window asymmetry: with Midnight's next-release root window (~14d),
  an offer can still be **fillable after its Celestia blob is pruned** — takers
  depend on our API/mirror for the blob, not on Celestia.

## Stopping

```bash
curl -X POST http://localhost:4747/shutdown
# or Ctrl+C in the orchestrator terminal
```
