# ZSwap Offerfile Kernel: Atomic Token Swaps on Midnight + Celestia DA

A decentralized token swap platform that combines **Midnight Network** (privacy-preserving ZK contracts) with **Celestia** (data availability layer). Users create atomic swap offers that are published to Celestia, indexed by the sync node, and completed on Midnight.

This repo is the **backend**: sync node, batcher, contracts, database, validator, and e2e tests. It is frontend-agnostic — an example browser frontend lives in the [effectstream monorepo](https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da) (see [Frontend](#frontend)).

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
| `SOLVER_RELAY_WS_URL` / `SOLVER_RELAY_AUTH_TOKEN` | required for live solver mode | Outbound Midnight Intents solver WebSocket and its shared bearer. The backend exact-files read is unauthenticated. |
| `SOLVER_RELAY_MAX_PARALLEL_SWAPS` | optional | Advertised and enforced concurrent proof-build bound; default 8. |
| `SOLVER_RELAY_PUSH_INTERVAL_MS` / `SOLVER_RELAY_RECONNECT_DELAY_MS` | optional | Complete ladder replacement cadence (default 1 000 ms) and reconnect delay (default 2 000 ms). |
| `SOLVER_STATUS_POLL_MS` / `SOLVER_SETTLE_TTL_MINUTES` | optional | Backend-consumption backstop cadence and chain-TTL wallet rollback window. |
| `SOLVER_DRY_RUN` / `SOLVER_MAINNET_LIVE_TRADING_ACK` | mainnet safety boundary | The mainnet solver defaults to dry-run. Live settlement requires `SOLVER_DRY_RUN=false` **and** the separate exact `SOLVER_MAINNET_LIVE_TRADING_ACK=true` acknowledgement. |

A complete dev → mainnet env template lives at `.env.mainnet.example`.

> **Dry-run limitation:** the current dry-run mirrors the offer book but does not
> load wallet inventory, so it cannot prove which Path-A fills a funded solver
> would admit. Treat it as a no-submit synchronization check, not live-decision
> parity; real-funds readiness remains blocked by the project plan.

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
├── start.dev.ts                              # Local orchestrator config
├── start.mainnet.ts                          # Mainnet orchestrator (+ light-node pre-flight)
├── packages/
│   ├── node/                                 # @zswap-da/node
│   ├── database/                             # @zswap-da/database
│   ├── validator/                            # @zswap-da/validator (shared offer validation)
│   ├── batcher/                              # @zswap-da/batcher
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
| `node/` | `main.{dev,mainnet}.ts`, `config.{dev,mainnet}.ts`, `env.ts` (env-derived constants), `grammar.ts`, `state-machine.ts`, `api.ts`, `docs.ts` (`GET /docs` serves Vite playground dist), `zk-assets.ts` (`/keys/*`, `/zkir/*` static ZK assets), `zswap-logic.ts`, `batcher-client.ts`, `event-bus.ts` |
| `database/` | `mod.ts` (re-exports), `migration-order.ts`, `migrations/000-init.sql`, `migrations/001-spent-sets.sql` (`spent_*` liveness sets), `migrations/002-liveness-sets.sql` (`created_unshielded` + windowed `known_roots`), `sql/queries.sql` (+ generated `queries.queries.ts`) |
| `validator/` | `validate.ts` (pipeline), `derive.ts`, `refstate.ts`, `types.ts`, `README.md`, `scripts/check-preview-indexer.ts` |
| `batcher/` | `batcher.{dev,mainnet}.ts`, `config.ts`, `midnight-balancing.ts`, `celestia.ts` (`ZswapCelestiaAdapter.validateInput` — pre-fee offer gate) |
| `contracts-midnight/` | `package.json` (scripts for `launchMidnight`), `deploy.ts`, `contract-offer-files/` (Compact source + compiled output) |
| `contracts-celestia/` | `package.json` (`celestia-{node,bridge,fund}:*` scripts), `fund-bridge.ts` |
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
