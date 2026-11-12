# ZSwap Offerfile Kernel: Atomic Token Swaps on Midnight + Celestia DA

A decentralized token swap platform that combines **Midnight Network** (privacy-preserving ZK contracts) with **Celestia** (data availability layer). Users create atomic swap offers that are published to Celestia, indexed by the sync node, and completed on Midnight.

This repo is the **backend**: sync node, batcher, offer poster, price feed, chain launchers,
database, validator, the API wire-contract and client packages, and e2e tests. The COW solver
lives in [effectstream/cow-solver](https://github.com/effectstream/cow-solver) (see
[The COW solver](#the-cow-solver)). It is frontend-agnostic — an example browser frontend lives in the [effectstream monorepo](https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da) (see [Frontend](#frontend)).

- **Backend (this repo):** https://github.com/effectstream/zswap-offerfiles-kernel
- **Example frontend:** https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da

Deployed app (preview network): https://zswap.zkdojo.com
Check deployed API playground: https://api-zswap.zkdojo.com/docs

## Quick Start

```bash
bun install
bun run dev   # PGLite + Midnight + Celestia + sync + batcher
```

Use Bun 1.3.11, the version CI and the kernel image run. The effectstream
0.300.x runtime uses standard decorators, and Bun 1.3.3 fails to load it
(`context.addInitializer is not a function`).

**Supported domain: Midnight 2.x / ledger 9** on `mainnet`, `preview`,
`preprod` and the local `undeployed` devnet, on the stable stack
(`@effectstream/*` 0.300.x, `@midnightntwrk/ledger-v9` 1.0.0, midnight-js 5,
the ledger9final node / indexer / proof-server builds). Ledger-8 (Midnight 1.x)
networks, transactions and databases are not supported; the last ledger-8
state of this repository is `main` @ `3b76604`. The matching example frontend is effectstream's `v-next` branch. **Mainnet does
not start yet**: its ledger-9 reference parameters are not pinned (see
[Running on preview, preprod and mainnet](#running-on-preview-preprod-and-mainnet)).

After the database initializes, `start.dev.ts` runs the optional
`canonical-token-registry` one-shot. The network is `TOKEN_REGISTRY_NETWORK`,
else `MIDNIGHT_NETWORK_ID`, else `undeployed`, which has no registry source
and skips. Preview and preprod import their published `mint-test-tokens` file
only when it is labelled for ledger 9 (`network.protocolFamily` =
`midnight-2.x`); a 1.x-labelled or missing file is skipped with one warning
naming the network and the file, and imports nothing. Mainnet has no token
source yet: nothing is imported and NIGHT is its only token. A timeout,
HTTP/metadata error or database rejection logs a skip and the rest of the
stack continues with the database's existing rows.

A fresh database lists **NIGHT only**. Every other token comes from the
network's registry import or from `POST /v1/known-tokens`.

The one-shot runs only in orchestration, after migrations. It does not add a
server import endpoint or refresh job. A successful run upserts only the six
canonical names; unrelated tokens, offer history and manual prices retain their
existing colors. If the import fails, the existing database is left exactly as
it was. This repository contains no faucet contract or local mint fallback.

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

Check out the effectstream monorepo as a **sibling** of this repo. Start this
repo's dev stack, provide same-chain wallet inventory, then start the frontend:

```bash
git clone git@github.com:effectstream/effectstream.git     # if not already checked out
cd effectstream/templates/zswap-da
bun install
bun run dev   # vite on :10600
```

The frontend fetches the API's public network configuration and offer data,
then constructs native Midnight offer transactions through its wallet. Test
tokens for supported public test networks are obtained from
[`mint-test-tokens`](https://mint-test-tokens.pages.dev/?network=preprod).
Fresh local chains require a separately provisioned same-chain fixture.

## Environments

| Layer | Dev (`bun run dev`, `MIDNIGHT_NETWORK_ID=undeployed`) | Public networks (`MIDNIGHT_NETWORK_ID=preview` \| `preprod` \| `mainnet`) |
|-------|---------------------|------------------------------------|
| DA | Local Celestia devnet (`packages/contracts-celestia`) | Celestia **mocha** (preview, preprod) or Celestia **mainnet** (mainnet), on the MIP-0006 shared namespace `mn-swap-v1` (`6d6e2d737761702d7631`) |
| Privacy chain | Local Midnight devnet (`packages/midnight-infra`, ledger9final binaries) | Midnight preview / preprod / mainnet through the Blockfrost-hosted indexer and node (`MIDNIGHT_BLOCKFROST_PROJECT_ID`) |
| Database | PGLite (in-memory) | Your Postgres (`PGLITE=false`), empty on first start |
| Node entry | `packages/node/main.dev.ts` | `packages/node/main.public.ts` (`bun run start:public`) |
| Batcher entry | `packages/batcher/batcher.dev.ts` | `packages/batcher/batcher.public.ts` (`bun run start:batcher:public`) |
| Orchestrator | `start.dev.ts` | none: one process per service (the kernel image, or systemd units) |
| Price feed | **separate process, optional** — `bun run --filter @zswap-da/price-feed start` (or `… once` for a single refresh) | same, plus the `price-feed` compose service (`--profile prices`) |

The public networks are described in
[Running on preview, preprod and mainnet](#running-on-preview-preprod-and-mainnet).

`start.dev.ts` brings up chain, database, node and batcher only.

**The price feed is optional.** `start.dev.ts` registers it only when
`COINGECKO_API_KEY` is set, and never as a system-dependency, because
`packages/database/migrations/000-init.sql` **seeds** real reference prices
(captured 2026-09-02): a stack that never runs it still quotes 1 WBTC ≈ 32 WETH
rather than a colour-hash rate. See [Reference prices](#reference-prices).

## Reference prices

`GET /v1/prices?tokens=<color>[,<color>…]` serves the USD prices behind
`GET /v1/quote` and behind the batcher's fee sponsorship. USD is the numeraire:
every price is a USD price and no asset — stablecoins included — is assumed to be
worth one dollar. `tokens` is **required** (1-50 colours) and there is no
unfiltered form: callers ask about the colours in front of them, so the endpoint's
cost does not grow with the registry. Three tables back it:

| Table | Holds |
|---|---|
| `asset_prices` | USD **per coin** for a tradable asset, keyed by its CoinGecko id. Seeded in `000-init.sql` with values captured 2026-09-02 |
| `known_tokens` | a colour's `decimals` (base units per coin) and optional `asset_id`. Prices are served **per base unit**, i.e. the asset price ÷ `10^decimals` |
| `token_prices` | only operator overrides (`manual`) and the deterministic demo rows (`fallback`) for tokens with no asset behind them |

Tokens without an explicit asset ID map to assets **by normalized name** —
`WBTC`/`WSBTC`/`BTC` → `bitcoin`, `WETH`/`WSETH`/`ETH` → `ethereum`, `USDC` →
`usd-coin`, `USDM` → `usdm-2`, `NIGHT` → `midnight-3`, `SNIGHT` → `midnight-3`.
Token colors are opaque, network-specific external IDs, so the name map is only
a fallback for manually registered rows. `known_tokens.asset_id` overrides it;
canonical `TWBTC`, `TWETH`, `TWUSDC`, `TWUSDM`, `UTWUSDC` and `UTWBTC` records
carry explicit asset IDs when the network's registry import writes them. `PRICE_FEED_MAP`
(`NAME_OR_COLOR=<asset_id>[:decimals],…`) overrides the defaults.

`SNIGHT` is the [shielded-night](https://github.com/effectstream/shielded-night)
wrapper — NIGHT held as a shielded (Zswap) token, locked 1:1, so it prices off
`midnight-3` like NIGHT. It is **not seeded**: its colour derives from the
wrapper contract's address and differs per network. Register it with NIGHT's
`decimals` (6) where a deployment exists; the name maps it to `midnight-3`
without an asset id.

`decimals` here always means **base units per priced coin** — a token's asset
price is divided by `10^decimals` to get the per-base-unit price this API
serves — never the colour's own display decimals. NIGHT is seeded with
`decimals: 6`: 1 NIGHT = 10⁶ Stars (its base unit; `STARS_PER_NIGHT` in
`midnight-ledger/ledger/src/structure.rs`).

The external canonical records state their real scales: BTC variants use 8,
ETH uses 18, and stablecoins use 6 decimals. Legacy/local registrations still
default to 6 when a caller omits the field; canonical import always supplies it.
`coinsToBaseUnits` / `baseUnitsToCoins` in `packages/api-contracts/amount.ts` are
the one place the conversion lives; amounts on the wire and on chain stay
integer base units.

`packages/price-feed` refreshes `asset_prices` from CoinGecko. It is a process of
its own — the node never makes an outbound price call:

```bash
bun run --filter @zswap-da/price-feed once    # one refresh, exit 0 (all) / 2 (partial)
bun run --filter @zswap-da/price-feed start   # loop, one cycle a day
docker compose run --rm price-feed --once     # the same, in deploy/
```

One cycle asks for up to `PRICE_FEED_BATCH_SIZE` ids per request, with at least
`PRICE_FEED_REQUEST_SPACING_MS` between requests, stopping at the first `429`.
Today's five assets (`bitcoin`, `ethereum`, `usd-coin`, `midnight-3`, `usdm-2`)
are **one request a day**; credits scale with `ceil(assets / 50)`, not with the
number of tokens.

**It is not part of `bun run dev`.** Development runs on the seeded prices — real
BTC/ETH ratios with no key, no network and no extra process — so the feed is never
registered in `start.dev.ts`. Run it deliberately with `--once`, or with the
opt-in compose service in `deploy/`.

| Variable | Default | Meaning |
|---|---|---|
| `COINGECKO_API_KEY` | — | Required to fetch. Sent as the `x-cg-demo-api-key` header, never in a query string. Without it the service only WARNS: `--once` exits 64, loop mode warns on every tick and does nothing |
| `COINGECKO_BASE_URL` | `https://api.coingecko.com/api/v3` | Point at a stub in tests; blank and whitespace-only select the default |
| `PRICE_FEED_INTERVAL_MS` | `86400000` | Loop period |
| `PRICE_FEED_REQUEST_SPACING_MS` | `1000` | Minimum gap between two requests |
| `PRICE_FEED_BATCH_SIZE` | `50` | Asset ids per `simple/price` request |
| `PRICE_FEED_ASSETS` | the five seeded ids | Comma-separated CoinGecko ids |
| `PRICE_FEED_MAP` | — | Node + feed: `NAME_OR_COLOR=<asset_id>[:decimals],…`. A malformed entry is a startup error, never a silent skip |
| `SPONSOR_DISCOUNT_BPS` | `250` | How far below reference an offer must be priced to earn fee sponsorship. Published in `/v1/prices.sponsor_discount` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PW` / `DB_NAME` | `127.0.0.1` / `5432` / `postgres` / `postgres` / `postgres` | Database used by the feed and optional token-registry import |
| `TOKEN_REGISTRY_BASE_URL` | `https://mint-test-tokens.pages.dev/` | Base URL for the optional orchestrator-owned metadata import |
| `TOKEN_REGISTRY_NETWORK` | explicit `MIDNIGHT_NETWORK_ID`, otherwise `undeployed` (skip) | Registry selected after initialization: `preview`, `preprod` (each imports only a `midnight-2.x`-labelled file), `mainnet` (no source yet: NIGHT only), or local `undeployed` (skip) |
| `TOKEN_REGISTRY_TIMEOUT_MS` | `5000` | Fetch, DB connection and DB statement bound; maximum 30000 ms |

### Fee sponsorship

Reference prices exist so the batcher can decide **which offers are worth a
Celestia fee**. The rule (`evaluateSponsorship` in `@zswap-da/offer-guard`) is the
one `GET /v1/quote` already shows the maker as `sponsored`, and it is applied in
two places: the batcher's `validateInput` (authoritative — it holds the wallet,
and anyone can POST to its `/send-input` directly) and `POST /v1/offers`, which
answers `422 NOT_SPONSORED` with the numbers before forwarding.

It is **not** applied at STM ingestion: the MIP-0006 namespace is permissionless,
so an offer posted straight to Celestia is still indexed. The gate decides who
rides the batcher's wallet for free, not what is a valid offer.

The node and the batcher read the **same variable names**, so they cannot drift.
An invalid value throws at startup rather than defaulting.

| Variable | Default | Read by | Meaning |
|---|---|---|---|
| `BATCHER_SPONSOR_POLICY` | `warn` | node + batcher | `enforce` refuses; `warn` logs what `enforce` would have refused and lets it through; `off` skips the check |
| `BATCHER_SPONSOR_UNPRICED` | `allow` | node + batcher | What to do when a leg's token has no market price (every test token). `allow` keeps them flowing |
| `BATCHER_NODE_API_URL` | `http://127.0.0.1:9999` | batcher | Where it asks `/v1/prices?tokens=` for each offer's leg colours (compose: `http://kernel:9999`) — it has no database |
| `BATCHER_PRICE_TTL_MS` | `600000` | batcher | How long a per-colour answer counts as current |
| `BATCHER_PRICE_MAX_AGE_MS` | `172800000` | batcher | How old an answer may be and still be used when a re-ask fails. Must be ≥ the TTL |
| `SPONSOR_DISCOUNT_BPS` | `250` | node + batcher | The threshold. On the batcher a bootstrap only: once the node answers, the node's `sponsor_discount` wins |

Roll out with the defaults (`warn` + `allow`), read a day of
`would refuse (policy=warn) — NOT_SPONSORED: …` lines from both processes, then
switch `BATCHER_SPONSOR_POLICY=enforce`.

## The COW solver

The COW solver (the process that mirrors this backend's Offer Files book,
publishes price ladders to a Midnight Intents relay and settles the relay's
swap jobs), its relay image, its monitor site, its Compose services and its
end-to-end runners live in
[effectstream/cow-solver](https://github.com/effectstream/cow-solver), with
their history. It consumes this backend through `@zswap-da/api-contracts` (the
API wire contracts) and `@zswap-da/kernel-client` (the API client, the offer
merging and balance checks, and the wallet helpers). This repository ships no
solver.

## Running on preview, preprod and mainnet

The public networks run the kernel's API node, batcher and offer poster as
separate processes (the kernel image's entrypoints, or one systemd unit per
program), plus a one-shot that imports the network's token registry into the
kernel database. **[`deploy/PRODUCTION.md`](deploy/PRODUCTION.md) is the
step-by-step guide for a native production host** (systemd, Postgres with
`pg_ivm`, proof server, Celestia light node, nginx; no orchestrator, no
Compose). This repository does not deploy them: there is no compose
file and no database service for a public network. You run the processes, a
proof server (9.0.1) and the Postgres.

Every network runs **Midnight 2.x / ledger 9**. `MIDNIGHT_NETWORK_ID` selects
the network; the supported ids are `undeployed`, `preview`, `preprod` and
`mainnet`. Any other id is refused at startup naming those four.

> **Mainnet does not start yet.** Its ledger-9 reference parameters are not
> pinned in `packages/validator/reference-parameters.ts` (they exist only on
> the live chain; the node runtime API `MidnightRuntimeApi_get_ledger_parameters`
> returns them at a block hash). Until a snapshot with its block hash, height,
> date and sha256 is added, the node and the batcher refuse
> `MIDNIGHT_NETWORK_ID=mainnet` with exit 78 (and `check-env.ts` fails on it):
> `MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ledger-9 reference parameters are not pinned yet …`.
> The mainnet profile below (endpoints, Celestia, seeds) is complete and
> checked; only the parameters are missing.

The env contract is one file per network, for all four services:
[`.env.preview.example`](.env.preview.example),
[`.env.preprod.example`](.env.preprod.example) and
[`.env.mainnet.example`](.env.mainnet.example). Every variable is tagged with
the services that read it, and secrets are left empty. Check a filled-in copy
with:

```bash
cp .env.preprod.example .env   # fill in the secrets, never commit it
bun check-env.ts                # static checks plus a live Celestia probe
```

### Per-network contract

| What | preview | preprod | mainnet |
|------|---------|---------|---------|
| Midnight endpoints (defaults) | `https://midnight-preview.blockfrost.io/api/v0` (WS `…/api/v0/ws`), `https://rpc.midnight-preview.blockfrost.io` | `https://midnight-preprod.blockfrost.io/api/v0` (WS `…/api/v0/ws`), `https://rpc.midnight-preprod.blockfrost.io` | `https://midnight-mainnet.blockfrost.io/api/v0` (WS `…/api/v0/ws`), `https://rpc.midnight-mainnet.blockfrost.io` |
| Token | `MIDNIGHT_BLOCKFROST_PROJECT_ID` (the network's own Blockfrost project) | same | same |
| NTP anchor (default) | `1784214468491` = block 1, 2026-07-16T15:07:48.491Z | `1774031004000` = block 1, 2026-03-20T18:23:24Z | `1773843582000` = block 1, 2026-03-18T14:19:42Z |
| Celestia | **mocha** | **mocha** | **Celestia mainnet** |
| Celestia namespace | MIP-0006 shared namespace `mn-swap-v1` = `6d6e2d737761702d7631` (leave `CELESTIA_NAMESPACE` unset) | same | same |
| Root window | `1209600` s (14 days) = the ledger-9 `global_ttl` | same | same |
| Offer validator parameters | pinned: indexer block 40,171 (2026-11-09), sha256 `a6e7a319…` | pinned: indexer block 3,352,707 (2026-11-09), sha256 `2d96bd99…` | **not pinned yet**: the kernel does not start |
| Token registry | `mint-test-tokens` `metadata.preview.json`, imported only when labelled `midnight-2.x` | `metadata.preprod.json`, same rule | no source yet: NIGHT only |

- **Endpoints.** The defaults are effectstream's `defaultMidnightNetworkConfig`
  (`@effectstream/midnight-contracts` 0.300.3): the Blockfrost-hosted indexer
  and node, each with `?project_id=<MIDNIGHT_BLOCKFROST_PROJECT_ID>`. Without
  the token every service refuses to start, naming the variable.
  `MIDNIGHT_INDEXER_HTTP`, `MIDNIGHT_INDEXER_WS` and `MIDNIGHT_NODE_HTTP` stay
  available as full overrides (all three set means no token is needed). The
  Midnight-hosted preprod and mainnet hosts (`indexer.<net>.midnight.network`,
  `rpc.<net>.midnight.network`) were retired on 2026-10-09: an override that
  names one is refused at startup, naming `MIDNIGHT_BLOCKFROST_PROJECT_ID`.
- **Wrong-network token.** Blockfrost project tokens are per network. A token
  of another network gets HTTP 403 `Network token mismatch`; the node and the
  batcher probe the indexer once at startup and stop (exit 78) naming
  `MIDNIGHT_BLOCKFROST_PROJECT_ID` instead of retrying forever.
- **Redaction.** Every endpoint the kernel logs or serves (startup lines, the
  configuration preflights, `/v1/health`, `GET /v1/midnight/config`, error
  messages) goes through effectstream's `redactBlockfrostProjectId` and shows
  `project_id=<redacted>`. Browser clients that read `GET /v1/midnight/config`
  bring their own Blockfrost token.
- **The shared namespace.** Preview and preprod kernels share
  `mn-swap-v1` on mocha. Each kernel ingests the other networks' blobs (and
  any ledger-8 era blob) and drops them in validation: the offer's proof root
  is unknown to its own chain, or its proofs fail against its network id.
  Rejected blobs are scrubbed and counted in `offer_rejections`; the sync does
  not stall.
- **Validator parameters.** The offer validator checks offers with
  `Transaction.wellFormed` against a reference state that carries the
  network's real ledger-9 `LedgerParameters`, pinned per network with sha256
  and provenance in `packages/validator/reference-parameters.ts` (`undeployed`,
  `preview`, `preprod`). Each has `global_ttl` 1,209,600 s, so intent TTLs up
  to 14 days are accepted, and a DUST grace period of 10,800 s. A network
  without a pinned snapshot fails at startup; it never validates against
  blank one-hour defaults.

### Services

The image entrypoints pick the entry from `MIDNIGHT_NETWORK_ID`:
`undeployed` → the `*.dev.ts` entries (unchanged), `preview` / `preprod` /
`mainnet` → the public-network entries; any other value exits 78. The kernel
and the batcher run a network-free configuration preflight before their
readiness waits. Every service refuses a missing required variable, or a
repository dev seed, with exit 78 and names it, listing every problem at once.

| Service | Image entrypoint → entry | Required | Secrets |
|---------|--------------------------|----------|---------|
| Kernel (sync node + API, `:9999`) | `entrypoint-kernel.sh` → `packages/node/main.public.ts` (preflight `packages/node/public-network-profile.ts`) | `MIDNIGHT_BLOCKFROST_PROJECT_ID` (or the three endpoint overrides), `CELESTIA_RPC_URL`, `CELESTIA_START_HEIGHT`, Celestia auth, `DB_HOST`, `DB_PORT` (+ `DB_USER`, `DB_NAME`, `PGLITE=false`), `BATCHER_SUBMIT_URL` | `MIDNIGHT_BLOCKFROST_PROJECT_ID`, `CELESTIA_AUTH_TOKEN`, `DB_PW` |
| Batcher (`:3334`) | `entrypoint-batcher.sh` → `packages/batcher/batcher.public.ts` (preflight `--check`) | `MIDNIGHT_BLOCKFROST_PROJECT_ID` (or the overrides), `MIDNIGHT_PROOF_SERVER_URL`, `CELESTIA_RPC_URL`, Celestia auth, `BATCHER_WALLET_SEED`, `BATCHER_STORAGE_DIR` (absolute, on a volume) (+ `BATCHER_NODE_API_URL`) | `MIDNIGHT_BLOCKFROST_PROJECT_ID`, `BATCHER_WALLET_SEED`, `CELESTIA_AUTH_TOKEN` |
| Offer poster | `entrypoint-offer-poster.sh` → `deploy/scripts/offer-poster.ts` | `ZSWAP_API`, `GIVE_TOKEN`, `WANT_TOKEN`, `POSTER_SEED` or `POSTER_MNEMONIC`, `MIDNIGHT_PROOF_SERVER_URL`, `MIDNIGHT_BLOCKFROST_PROJECT_ID` (endpoints default as above) | `POSTER_SEED` / `POSTER_MNEMONIC`, `MIDNIGHT_BLOCKFROST_PROJECT_ID` |
| Token registry (one-shot) | `entrypoint-token-registry.sh` → `import-token-registry.ts --required` | `TOKEN_REGISTRY_NETWORK` (`preview`, `preprod` or `mainnet`), `DB_HOST`, `DB_PORT` (+ `ZSWAP_API` to wait for the kernel) | `DB_PW` |

- **Celestia auth** means `CELESTIA_AUTH_TOKEN`, the RPC bearer token. If the
  RPC URL embeds its own credential (the QuickNode pattern), set
  `CELESTIA_AUTH_IN_URL=true` instead. The logs show only the URL's origin.
- **Dev seeds.** The wallet seeds committed in this repository (`…01`,
  `…02`, `…03`, `…21`, `…31`, `…32`, and any 32-byte seed whose first 31 bytes
  are zero) are accepted only on `undeployed`. On every public network the
  poster, the batcher and `check-env.ts` refuse them by name, and the batcher
  has no fallback seed: an unset `BATCHER_WALLET_SEED` is a startup error.
- **Without the image**, from a checkout: `bun run start:public` (node),
  `bun run start:batcher:public` (batcher), and the preflights
  `bun run packages/node/public-network-profile.ts` and
  `bun run packages/batcher/batcher.public.ts --check`.
- **The batcher's DUST-state cache** lives in
  `${BATCHER_STORAGE_DIR}/dust-state`. Put `BATCHER_STORAGE_DIR` on a volume,
  so a restart resumes the DUST sync instead of rescanning.

### Start heights: pin them

- `CELESTIA_START_HEIGHT` is **required**; there is no fallback to 1. Use the
  Celestia height (mocha, or Celestia mainnet for mainnet) at, or a little
  before, the first offer you care about. For a fresh deployment with no
  history, that is the current head (`header.NetworkHead` on your RPC).
- `MIDNIGHT_START_BLOCK` defaults to 1, which matches the NTP anchor, so the
  node indexes the network from genesis on its first start.
- The runtime snapshots these start values and the NTP anchor on the first
  boot. A later change is refused unless `USE_DB_STARTHEIGHT` is set, and
  then the database's snapshot wins. Choose the start heights once.

### Database: your Postgres

The kernel talks to Postgres through `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PW`
and `DB_NAME`. **Set `PGLITE=false`.** The runtime defaults `PGLITE` to
true, which means single-connection PGlite mode and never sending `DB_PW`;
the public node logs a warning while it is unset. **Start on an empty
database**: data written by a ledger-8 kernel does not deserialize under
ledger 9, and no migration is offered. The kernel applies its own migrations
when it processes its first block, and a fresh database lists NIGHT only.
**Install the [`pg_ivm`](https://github.com/sraoss/pg_ivm) extension** in that
Postgres: the effectstream runtime builds its materialized views with it.
Without it the node does not start: it exits non-zero with `Effectstream
startup aborted: the pg_ivm PostgreSQL extension is not available …`, and
Postgres logs `extension "pg_ivm" is not available`.
`ALLOW_NO_PG_IVM=true` selects the engine's plain-view fallback instead, which
effectstream marks as dev/test only (reads slow down as the tables grow).
This repository's tests and CI run on PGlite; no gate here exercises a real
Postgres.

### Token registry

Run the `entrypoint-token-registry.sh` one-shot once per database, after the
kernel's first start, with `TOKEN_REGISTRY_NETWORK=<network>`:

- `preview` / `preprod`: it imports the network's published `mint-test-tokens`
  file when the file is labelled for ledger 9 (`midnight-2.x`, profile `v2`),
  in one transaction. A 1.x-labelled or missing file is skipped with one
  warning naming the network and the file, and nothing is imported.
- `mainnet`: there is no source yet (a token API is planned); nothing is
  imported and NIGHT stays the only token.

The one-shot exits 0 when the import applied or when there is nothing to
import, and 1 (loudly) after its retries when a source exists but cannot be
read or applied. It retries while a fresh database has no schema yet.
Re-running it is idempotent.

Extra tokens are registered with `POST /v1/known-tokens`. The route is off
unless `ENABLE_TOKEN_REGISTRY=true`, and it has **no authentication**. Enable
it only if you accept that, or insert the rows in your Postgres instead.

### Funding runbook

Every step below is done by hand; none of it is automated here.

1. **Batcher DUST.** Send NIGHT to the unshielded address of
   `BATCHER_WALLET_SEED`, then register it for DUST **with the batcher
   stopped**, because only one wallet facade may run per seed. This
   repository's provision script, `deploy/scripts/provision-solver-fees.ts`,
   does it from the root of a checkout (after `bun install`), reading the seed
   from `SOLVER_SEED` and writing its receipt to `SOLVER_PROVISION_RECEIPT`
   (the Blockfrost token comes from the environment, never the command line):

   ```bash
   MIDNIGHT_NETWORK_ID=preprod \
   MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:6300 \
   SOLVER_SEED="$BATCHER_WALLET_SEED" SOLVER_PROVISION_RECEIPT=/tmp/batcher-dust.json \
   bun run deploy/scripts/provision-solver-fees.ts
   ```

   It fails if the wallet holds no NIGHT, and it waits until the DUST is
   usable. Each registered NIGHT UTXO is one concurrent fee slot. The default
   off `undeployed` is `BATCHER_MAX_SLOTS_PER_WALLET=1`; split the NIGHT into
   several UTXOs before raising it.
2. **Celestia signer.** Fund the account behind `CELESTIA_RPC_URL` /
   `CELESTIA_AUTH_TOKEN` with TIA (testnet TIA from the mocha faucet for
   preview and preprod). On a light node, `state.AccountAddress` prints the
   address. The batcher pays one blob fee per sponsored offer.
3. **Poster coins.** Send the poster's shielded address coins of `GIVE_TOKEN`
   in the configured size (`GIVE_AMOUNT`, or `GIVE_MIN`..`GIVE_MAX`). The
   address is printed at startup, and `DRY_RUN=true` prints it without
   posting. The poster pays no fees: the batcher sponsors them.

### Real funds: NO-GO

Real funds stay NO-GO for this backend until its first ledger-9 version is
ready for review; the repository owner then reviews the NO-GO.
The mainnet profile ships, proven read-only only (offline profile tests and
refusals; a mainnet kernel does not start until its reference parameters are
pinned).
This repository ships no solver; the COW solver's own real-funds status and
mainnet guards are documented in
[effectstream/cow-solver](https://github.com/effectstream/cow-solver).

### Not covered here

- No live public-network test runs in this repository's gates. The profiles
  are proven offline (configuration preflights and refusals) and end to end on
  `undeployed`.

## Mainnet environment

The mainnet profile is the public-network contract above with Celestia
mainnet; [`.env.mainnet.example`](.env.mainnet.example) is the complete
template. **A mainnet kernel does not start yet** (its ledger-9 reference
parameters are not pinned).
Real funds stay NO-GO for this backend until its first ledger-9 version is
ready for review; the repository owner then reviews the NO-GO.
See [Real funds: NO-GO](#real-funds-no-go).

The Celestia RPC can be a light node you run yourself:

```bash
celestia light init --p2p.network celestia
celestia light start --core.ip <consensus-rpc> --core.port 9090 --core.tls --p2p.network celestia
celestia light auth admin --p2p.network celestia   # paste into CELESTIA_AUTH_TOKEN
```

Fund the `celestia1...` address shown by `celestia state account-address` with TIA before submitting blobs.

| Env var | Required | Purpose |
|---------|----------|---------|
| `MIDNIGHT_NETWORK_ID` | yes | `mainnet`. |
| `MIDNIGHT_BLOCKFROST_PROJECT_ID` | yes (secret) | The mainnet Blockfrost project token; the default endpoints are `https://midnight-mainnet.blockfrost.io/api/v0` and `https://rpc.midnight-mainnet.blockfrost.io`. Not needed only when `MIDNIGHT_INDEXER_HTTP`, `MIDNIGHT_INDEXER_WS` and `MIDNIGHT_NODE_HTTP` are all set; an override on the retired `*.mainnet.midnight.network` hosts is refused. |
| `CELESTIA_NETWORK` | default | `mainnet` (the default on mainnet; any other value is refused). |
| `CELESTIA_RPC_URL` | yes | Celestia mainnet JSON-RPC (no loopback default). |
| `CELESTIA_AUTH_TOKEN` | yes (secret) | RPC bearer, e.g. the admin JWT from `celestia light auth admin`; or `CELESTIA_AUTH_IN_URL=true` when the URL carries the credential. |
| `CELESTIA_NAMESPACE` | leave unset | The MIP-0006 shared namespace `mn-swap-v1` (`6d6e2d737761702d7631`) is the default; an override is warned about because kernels on the shared namespace will not see those offers. |
| `CELESTIA_START_HEIGHT` | yes | The Celestia mainnet height to start reading offers at; no fallback, frozen after the first boot. |
| `CELESTIA_GAS_PRICE`, `CELESTIA_MAX_GAS_PRICE`, `CELESTIA_TX_PRIORITY`, `CELESTIA_GAS` | optional | Tx-config knobs that skip on-chain estimator calls (avoid rate-limit 429s). |
| `CELESTIA_POLLING_INTERVAL_MS` | optional | Sync cadence. Defaults: devnet 6 000 ms, mainnet 30 000 ms. |
| `MIDNIGHT_START_BLOCK` | default | `1`, which matches the NTP anchor; the nullifier set must be complete. |
| `NTP_START_TIME` | default | `1773843582000`, mainnet block 1 (2026-03-18T14:19:42Z); an override is warned about. |
| `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_ALLOWLIST` | optional | Per-client-IP budget for `/v1/*` per minute (default 600; `/v1/health*` exempt) and comma-separated IPs exempt from it. Size it for the co-located automated clients on one address (a book mirror such as the COW solver plus its console: ~450/min worst case); `deploy/` sets 6000. |
| `BATCHER_SUBMIT_TIMEOUT_MS` | optional | Absolute batcher fetch + receipt-body deadline; default 310 000 ms, bounded to 1 000–600 000 ms. |
| `API_SSE_MAX_CONNECTIONS` | optional | Per-node concurrent `/v1/offers/stream` cap; default 100. Excess clients receive `503 SSE_CAPACITY`. |
| `API_UPDATES_MAX_CONNECTIONS` | optional | Per-node concurrent `/v1/offers/updates` websocket cap; default 100. Excess clients are refused the connection (this endpoint's refusals are disconnects, not HTTP statuses — see API.md). |
| `OFFER_FILES_READ_TIMEOUT_MS` | optional | Exact-files read decision budget, default 15 000 ms and capped at 60 000 ms. Native synchronous proof work cannot be preempted; a retained concurrency slot bounds unfinished work. |

A complete mainnet env template lives at `.env.mainnet.example`.

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
   affected node and its restart loop. Stop the clients that act on that
   backend's book (for example a COW solver's job execution) and confirm they
   no longer publish or settle against it before touching state.
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
   stopped. Start one node first, with dependent clients still withdrawn, and
   let it replay from the last committed boundary. Restore replicas only after
   that node is current and stable; restore the dependent clients only after
   their book mirrors are current again.
6. **Verify replay before closing the incident.** Confirm the blocked height
   commits exactly once and later heights advance; the retained input either
   completes normally or has the reviewed disposition; no pre-fault partial
   row or duplicate application event exists; and backend health and offer
   liveness are healthy, as are the dependent clients' own recovery checks. Archive the queries, logs, backup identity,
   remediation artifact, and verification results with the incident.

The long-term fix is upstream savepoint-based per-input database and rejected-
promise isolation. This branch deliberately does not fork Effectstream or
pretend the current whole-block mode provides that availability guarantee.

## Testing

```bash
bun run test
```

The live Phase B suite no longer creates token identities. Before running it,
provision the deterministic wallets with same-chain externally issued
inventory and set the token-color variables used by each case:
`E2E_SHIELDED_TOKEN_A/B`, `E2E_TOKEN_0/1`, `E2E_MULTI_TOKEN_0/1/2`,
`E2E_UNSHIELDED_TOKEN_0/1`, and `E2E_ROOT_GIVE_TOKEN/E2E_ROOT_ADVANCE_TOKEN`.
A freshly reset local chain has no such issuer, so this live gate cannot pass
until an external same-chain fixture has funded it. The public faucet supports
Preview and Preprod; it does not fund the local `undeployed` chain.

The runner boots the undeployed stack (PGLite `:5432`, Midnight
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
├── packages/
│   ├── node/                                 # @zswap-da/node
│   ├── database/                             # @zswap-da/database
│   ├── validator/                            # @zswap-da/validator (shared offer validation)
│   ├── api-contracts/                        # @zswap-da/api-contracts (wire contracts of the kernel API)
│   ├── kernel-client/                        # @zswap-da/kernel-client (API client, offer merging, wallet helpers)
│   ├── batcher/                              # @zswap-da/batcher
│   ├── offer-guard/                          # @zswap-da/offer-guard (checks node + batcher must agree on)
│   ├── price-feed/                           # @zswap-da/price-feed (daily CoinGecko refresh; optional process)
│   ├── midnight-infra/                       # Midnight node/indexer/proof-server launch scripts
│   ├── contracts-celestia/                   # @zswap-da/contracts-celestia (bridge + fund scripts)
│   └── tests/                                # @zswap-da/tests
```

The example frontend (React + Vite + Midnight wallet) lives in the effectstream
monorepo at
[`templates/zswap-da`](https://github.com/effectstream/effectstream/tree/v-next/templates/zswap-da).

## Key files

| Package | Files |
|---------|-------|
| `node/` | `main.{dev,public}.ts`, `config.{dev,preview}.ts` (the public entry's env-driven config), `public-network-profile.ts` (public-network checks + preflight), `env.ts` (env-derived constants), `grammar.ts`, `state-machine.ts`, `api.ts`, `prices.ts` (price resolution + `GET /v1/prices`), `docs.ts` (`GET /docs` serves Vite playground dist), `batcher-client.ts`, `event-bus.ts` |
| `database/` | `mod.ts` (re-exports), `migration-order.ts`, `migrations/000-init.sql` (THE schema — one file applied from zero; there is no numbered chain, and the 001/002 files this table used to list are gone), `migrations/local-migration.sql` (local-only additions), `price-map.ts` (token NAME → reference asset, per-base-unit conversion), `sql/queries.sql` (+ generated `queries.queries.ts`), `sql/queries.app.ts` |
| `validator/` | `validate.ts` (pipeline), `derive.ts`, `refstate.ts`, `reference-parameters.ts` (pinned ledger-9 parameters per network), `types.ts`, `README.md`, `scripts/check-preview-indexer.ts` |
| `batcher/` | `batcher.{dev,public}.ts`, `public-network.ts` (public-network checks), `config.ts`, `midnight-balancing.ts`, `celestia.ts` (`ZswapCelestiaAdapter.validateInput` — pre-fee offer gate) |
| `midnight-infra/` | `package.json` (Midnight node, indexer and proof-server process scripts) |
| `contracts-celestia/` | `package.json` (`celestia-{node,bridge,fund}:*` scripts), `fund-bridge.ts` |
| `api-contracts/` | the versioned wire contracts the node serves and its clients parse: `amount.ts` (whole coins ⇄ base units), `receipt-client.ts` (bounded relay and backend receipt reads), `exact-files-contract.ts` (`POST /v1/offers/files`), `offer-updates-contract.ts` (`GET /v1/offers/updates`), `validation-contract.ts` (offer validation verdicts) |
| `kernel-client/` | `api-client.ts` (the kernel REST, update-stream and exact-files client), `batcher.ts` (offer merging and token-balance checks), `wallet.ts` (wallet facade for a seed, sync, balances, shielded transfer) |
| `offer-guard/` | `mod.ts` (offer hash, guard ladder, dedup store), `public-networks.ts` (supported networks, endpoint / dev-seed / reference-parameter rules, log redaction), `sponsorship.ts` (`evaluateSponsorship()` — the ONE fee-sponsorship rule, shared by the quote, the node pre-check and the batcher) |
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
| Price feed | **none** — outbound only (CoinGecko) plus the database; it listens on no port |

## Grammar / state-machine inputs

| Key | Source | Purpose |
|-----|--------|---------|
| `celestia-zswap` | Celestia DA primitive | Validate a published offer blob (structure + ZK proofs + spent-set liveness), then index it (gives/wants, nullifiers, unshielded spends; schedule TTL cleanup) or drop + emit `offer_rejected`. |
| `midnight-nullifier` | Midnight nullifier primitive | Record the nullifier in `spent_nullifiers` (liveness) and archive any offer whose shielded nullifier is consumed on chain. |
| `midnight-unshielded-spend` | Midnight unshielded-spend primitive | Record the UTXO in `spent_unshielded` (liveness) and archive any offer whose unshielded UTXO is spent. |
| `midnight-unshielded-create` | Midnight unshielded-create primitive | Record every created unshielded UTXO in `created_unshielded` (existence liveness). |
| `midnight-zswap-root` | Midnight zswap-root primitive | Record the coin-tree root in `known_roots` and prune to `ROOT_WINDOW_SECONDS` (root-known liveness). |
| `zswap-ttl-cleanup` | Scheduled timestamp data | Archive offers whose derived expiry passed without on-chain consumption (root deadline for shielded inputs, intent TTL for intents; see API.md "Offer expiry"). |

## API

**Interactive playground (try upload / settle / wallet balances live):**
`bun run docs:dev` → [http://localhost:10601/docs/](http://localhost:10601/docs/)
(Vite + React). After `bun run docs:build`, the node also serves it at
[http://localhost:9999/docs](http://localhost:9999/docs). Proof server URL comes
from `VITE_PROOF_SERVER_URL` (local default `http://localhost:6300`).
The Wallet panel links to the external faucet. `VITE_FAUCET_URL` overrides its
base and `VITE_FAUCET_NETWORK` overrides the selected network; otherwise an
explicit `VITE_MIDNIGHT_NETWORK_ID` is preserved and Preprod is the default.
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
| `GET` | `/v1/midnight/config` | Public Midnight network config the browser wallet needs. |
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
- Note the window asymmetry: the kernel's root window is the ledger's
  `global_ttl`, 14 days on every network (`ROOT_WINDOW_SECONDS`, default
  1209600), about twice mocha's ~7-day blob retention. An offer can still be
  **fillable after its Celestia blob is pruned** — takers depend on our
  API/mirror for the blob, not on Celestia, and a kernel syncing from scratch
  cannot re-read offers older than the retention window.

## Stopping

```bash
curl -X POST http://localhost:4747/shutdown
# or Ctrl+C in the orchestrator terminal
```
