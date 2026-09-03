# `deploy/` — split-component Docker Compose stack

The whole system as **separate Compose services**, one process each: the Midnight
1.x / ledger-v8 chain, the Offer Files kernel, the batcher, the COW solver, and
the **unmodified** Midnight Intents reference relay.

Local/dev networks only. Every seed in `.env.example` is a public dev seed.

## Quick start

```bash
cd deploy
./bootstrap.sh                 # writes .env (gitignored) with generated secrets
docker compose up -d           # chain -> deploy one-shot -> kernel/batcher -> relay -> solver
docker compose ps
./down.sh                      # FULL teardown: containers + networks + volumes
```

Static gates only (no stack, safe on a shared host):

```bash
./gates.sh /path/to/transcripts
```

## Services

| Service | Image | Process | Internal | Host (default) |
|---|---|---|---|---|
| `midnight-node` | `images/midnight-node` (binaries 0.3.120, `1.0.0`) | `midnight-node --dev` | 9944 | `19944` |
| `proof-server` | `images/proof-server` (binaries 0.3.120, `ledger-8.1.0`) | `midnight-proof-server` | 6300 | `16300` |
| `indexer` | `images/indexer` (binaries 0.3.120, `v4.3.3`) | `indexer-standalone` | 8088 | `18088` |
| `celestia` | `images/celestia` (`celestia-appd v6.4.10` + `celestia-node v0.28.4`) | supervisor: consensus + bridge | 26657 / 26658 | `16657` / `16658` |
| `pglite` | kernel image | `@effectstream/db` pg-gateway server | 5432 | `15432` |
| `offerfiles-deploy` | kernel image | one-shot: deploy contract, then mint | — | — |
| `kernel` | kernel image | `bun run packages/node/main.dev.ts` | 9999 | `19999` |
| `batcher` | kernel image | `bun run packages/batcher/batcher.dev.ts` | 3334 | `13334` |
| `relay` | `images/relay` (reference @ `061f4d3`, unmodified) | `node packages/relay/dist/relay-main.js` | 3000 / 9001 | `13000` / `19001` |
| `solver` | kernel image | `bun run start.solver.ts` | — | — |
| `price-feed` | kernel image | `bun run packages/price-feed/price-feed.dev.ts` (profile `prices`) | — | — |
| `offer-poster` | kernel image | `bun run deploy/scripts/offer-poster.ts` (profile `poster`) | 9977 | `19977` |
| `scripts` | kernel image | E2E driver (profile `e2e`) | — | — |

## Why there is no orchestrator here

The repository has one (`bun run dev` → `start.dev.ts`), and it must never run
in a container. `launchMidnight()` and `launchCelestia()` begin by killing
whatever is listening on 9944 / 8088 / 6300 / 26657 / 26658 / 3334
(`stopProcessAtPort`) — which in this topology is the sibling services — and
their deploy step would mint a **second** contract identity while every volume
still referred to the first. So Compose spawns each process directly, and the
kernel image ships one entrypoint per component
(`images/kernel/entrypoint-*.sh`).

The one thing the orchestrator does that still has to happen somewhere is
sequencing. That is split between Compose (`depends_on` + healthchecks,
including `service_completed_successfully` on the deploy one-shot) and the
entrypoints' own readiness waits (`images/kernel/wait-for.sh`) for the
conditions Compose cannot express — most importantly **midnight-node having
produced block #1**, which is not the same as its RPC answering.

## Version provenance

Nothing here is a version we picked. The chain binaries are the ones this
repository's own pinned dependencies download for `bun run dev`, from
[`effectstream/binaries` 0.3.120](https://github.com/effectstream/binaries/releases/tag/0.3.120),
and every asset is sha256-verified at build time:

| Component | Version | Pinned by |
|---|---|---|
| midnight-node | `1.0.0` | `@effectstream/npm-midnight-node@0.103.1` |
| proof-server | `ledger-8.1.0` | `@effectstream/npm-midnight-proof-server@0.103.1` (matches the `@midnight-ntwrk/ledger-v8: 8.1.0` override) |
| indexer-standalone | `v4.3.3` | `@effectstream/npm-midnight-indexer@0.103.1` |
| celestia-appd / celestia-node | `v6.4.10` / `v0.28.4` | `@effectstream/celestia@0.103.1` |
| Compact CLI | `0.30.0` | `start.dev.ts` **and** `contract-offer-files/package.json` |
| bun | `1.3.11` | the runtime this clone is developed and tested on; 1.3.14 breaks `midnight-contract:deploy` via graphql-tag |

`0.3.120` is a rolling mirror release, not an immutable tag. The sha256 pins are
what make that safe: a re-uploaded asset fails the build instead of silently
changing the chain.

### Celestia runs `linux/amd64`

Release 0.3.120 has no `celestia-*-linux-arm64` asset — linux is amd64-only. On
an arm64 host that one service runs emulated (`CELESTIA_PLATFORM`). Building
celestia from upstream Go source for arm64 is the fallback, but it would run
*different* binaries than the ones this repo pins, so it is not the default.

## The solver

`bun run start.solver.ts` — its own service, its own process, never reachable
from `start:mainnet`. Seven variables are mandatory and all seven are stated
explicitly in `compose.yml`, even where the code has a default, because every
one of those defaults is a developer convenience that is wrong in a deployment
(an unset `MIDNIGHT_NETWORK_ID` silently means `undeployed`; an unset
`ZSWAP_API` means `127.0.0.1:9999`; an unset `SOLVER_SEED` means the
repository's public dev seed):

`MIDNIGHT_NETWORK_ID`, `ZSWAP_API`, `SOLVER_RELAY_WS_URL`,
`SOLVER_RELAY_HTTP_URL`, `SOLVER_RELAY_AUTH_TOKEN` (≥ 32 chars),
`SOLVER_JOURNAL_PATH` (absolute, on a volume), `SOLVER_SEED`.

Omitting any of them is a deterministic non-zero exit that lists **every**
problem at once, before any wallet, socket or journal is touched — so one
restart shows the whole list. `gates.sh` drives exactly that as a negative
control.

> **The solver needs NO swap-token inventory to quote whole-maker rungs.** Since
> 00006 the DUST fee is sized from a synthetic taker-half stand-in rather than by
> spending and reverting the job's full `amountIn` out of the solver's own
> wallet, and the tokenIn publication cap that mechanism forced (added in
> `c4ac2bb`, which made a solver holding no tokenIn publish nothing at all) is
> gone. What tokenOut inventory still buys is *interior* sizes: a rung whose
> interpolated interval could demand more residual tokenOut than the solver can
> move is withheld, so a solver holding no tokenOut publishes each pair's first
> rung and no more. See the boxed note in `.env.example`, and
> `SOLVER_FEE_SIZING_TAKER_INPUTS` beside it — the one fee knob, where raising
> the number spends more real DUST.

## The price feed

`price-feed` refreshes `asset_prices` — the USD reference prices behind
`GET /v1/prices`, `GET /v1/quote` and the sponsorship gate — from CoinGecko
once a day. It is **opt-in** (`profiles: ["prices"]`) and the stack is complete
without it: `000-init.sql` seeds real prices captured on 2026-09-02, so a fresh
database already quotes 1 WBTC ≈ 32 WETH rather than the colour-hash demo rate.
For the same reason a development stack never runs it at all (it is not in
`start.dev.ts`); here it is a deliberate opt-in, not a default.

```bash
# one refresh now, then exit (0 = every asset updated, 2 = something did not)
docker compose run --rm price-feed --once

# or leave it running, one cycle a day
docker compose --profile prices up -d price-feed
```

`COINGECKO_API_KEY` is the only secret in this stack. It lives in `.env`, is
passed as the `x-cg-demo-api-key` **header** (never a query parameter, which
would put it in every access log), and is never printed — the service's startup
line says `key=present` or `key=ABSENT`. With no key the service only **warns**:
`--once` prints the warning and exits 64, and loop mode prints it at start and on
every tick while doing nothing else. It deliberately does not exit in loop mode,
because a non-zero exit under `restart: unless-stopped` is a crash loop and the
stack is usable on the seeds meanwhile.

One cycle asks for up to `PRICE_FEED_BATCH_SIZE` ids (default 50) per
`simple/price` request, with at least `PRICE_FEED_REQUEST_SPACING_MS` between
requests — so today's five assets (`bitcoin`, `ethereum`, `usd-coin`,
`midnight-3`, `usdm-2`) are **one call a day**, and credits scale with
`ceil(assets / 50)`. Every asset is fetched: USD is the numeraire and nothing is
pinned to it, so the stablecoins are observed like the rest and a depeg shows up
in the quotes.

Failures are graded. One bad id inside an otherwise good response fails only that
id. A failed **request** is recorded against every id it carried — blaming one
would be a guess — and the next batch is still made. A `429` stops the cycle where
it stands, keeping what was already written. All of it is visible in
`GET /v1/prices.feed.last_error`.

## Offer poster

`offer-poster` keeps the book supplied with **individually takeable** offers.
Every `POST_INTERVAL_MS` (default 60 s) one tick does exactly one of two things:

* **re-offer** — a coin the journal already owns has come back (its last offer
  is `expired` or `cancelled` in the kernel *and* the nonce is visible again in
  the wallet's `availableCoins`), so the tick posts a fresh offer for that exact
  coin at today's quote; or
* **mint** — no coin is free, so the tick calls the faucet circuit
  `mint_shielded(domainSep(GIVE_TOKEN), GIVE_AMOUNT, freshNonce)` — paying the
  mint fee from its **own DUST** — waits for the coin to appear, and offers it.

Either way the offer **gives one whole coin**: no change output, so every offer
is a complete, independent swap rather than a slice of a shared balance. The
want leg is not a knob by default — it is `suggested_to_amount` from
`GET /v1/quote` for that coin's actual value, which lands the offer exactly on
the sponsorship threshold so the batcher pays its Celestia fee (`payFees:false`,
the taker balances).

```bash
docker compose --profile poster up -d offer-poster
docker compose logs -f offer-poster
```

It is **opt-in**: with the profile off it is absent from `docker compose ps`,
absent from `docker compose config --services`, and nothing else in the stack
changes. `./down.sh` names the profile, so the container and its
`offer-poster-state` volume go with everything else.

### The exact-coin guarantee, and how to check it

The wallet SDK's default coin selector is smallest-first and cannot be told
which coin to spend. The poster therefore builds its own facade with a **pinned
selector** (`deploy/scripts/lib/pinned-wallet.ts`): while a nonce is armed, the
selector returns that coin for the give colour or **nothing at all** — never a
substitute. After `finalizeTransaction` the tick asserts the built transaction's
input nullifiers equal `[the pinned coin's nullifier]` and that the fallible
section has no inputs; if they differ the recipe is **reverted** and nothing is
posted.

To verify it from outside, compare the kernel's view against the poster's own
record — one nullifier, the same on both sides:

```bash
# what the poster believes it did (read-only, no auth)
curl -s http://127.0.0.1:19977/journal | jq '.coins | to_entries[-1]'

# what the kernel says the offer actually spends
curl -s http://127.0.0.1:19999/v1/offers/<offerId> | jq '.computed.inputNullifiers'
```

`computed.inputNullifiers` must be a **single** entry, and it must equal the
`nullifier` of the coin that journal entry's newest `offers[]` element belongs
to. `<offerId>` is the offer's sha256 content hash — the same string the journal
records and the poster logs as `offerId=`.

### The journal

`POSTER_JOURNAL_FILE` (`/var/lib/offer-poster/journal.json`, on the
`offer-poster-state` volume) is one entry per coin the poster has ever minted:
the coin identity (`type`, `nonce`, `value`, `nullifier`), the mint transaction,
and the history of every offer built from it with its quote snapshot and last
known kernel status. It is written atomically (temp file + rename) on every
state change, and **before** a mint is submitted — so a poster killed between
minting and posting finds the orphan on restart and re-offers it instead of
leaking a coin.

Consequences worth knowing:

* It is **keyed by the contract address**. A journal from another deployment is
  refused at startup rather than merged — those coins do not exist on this
  chain. So is a corrupt file, which is moved aside and never overwritten. Both
  refusals are lifted by `OFFER_POSTER_JOURNAL_RESET=true`, deliberately once.
* `cancelled` does **not** mean the coin came back. Settlement is atomic, so a
  partial or split spend is also reported `cancelled`. Candidacy is therefore
  gated on the wallet's `availableCoins`, which is the only proof of release;
  the kernel status is a hint.
* Coins the poster did not mint are never touched, even if they sit in the same
  wallet in the same colour.
* `OFFER_POSTER_TTL_MINUTES` does **not** set how long a posted offer stays
  takeable. It is the `ttl` passed to `initSwap` — the wallet's own local
  deadline for that one build, governing only when an *unconfirmed* recipe is
  abandoned and its coin released back to `availableCoins`. For a shielded
  leg, once an offer is actually posted and live, the kernel tracks its
  expiry independently: `min(ROOT_WINDOW_SECONDS, OFFER_TTL_SECONDS)`, both
  process-wide kernel env vars (currently 1h on every network), and neither
  reads anything a client sends per offer. A re-offer candidate therefore
  needs BOTH windows to have passed — the wallet-side one (this knob) and the
  kernel-side one (not configurable from this service). Shortening only this
  knob will not by itself produce more re-offers; see Q8 in
  `plans/00007-offer-poster-service-questions.md` for the full trace
  (`packages/node/state-machine.ts`, `packages/node/env.ts`).

### Funding

The poster needs **unshielded NIGHT**, and nothing else — it registers that
NIGHT for DUST itself at startup and waits (bounded) for the dust to arrive. A
poster with no NIGHT still starts and reports `degraded: insufficient_dust` on
`/health`; it keeps servicing re-offers, which cost no dust, because restarting
it would not produce NIGHT.

* **`undeployed`** — transfer from the genesis wallet. The worked example in
  this repo is `deploy/scripts/provision-solver-fees.ts`, which sends the solver
  four UTXOs of `5_000_000_000_000` NIGHT each from `MIDNIGHT_GENESIS_SEED` and
  then registers them; `packages/solver/scripts/bootstrap-dev.ts` is the funded
  variant of the same path. A few **large** UTXOs, not many small ones: a dust
  coin's capacity is tied to the size of the NIGHT UTXO backing it.
* **`preprod`** — the Midnight preprod faucet, then wait for the dust to
  register. Nothing here deploys preprod; see below.

### One facade per seed

`OFFER_POSTER_SEED` must be a **dedicated** seed. Two wallet facades on one seed
against one Midnight node force each other's connection down, so the poster
refuses to start (exit 78) if its seed matches `MIDNIGHT_GENESIS_SEED` /
`MIDNIGHT_WALLET_SEED`, `BATCHER_WALLET_SEED`, `SOLVER_SEED`, `MAKER_SEED`,
`MAKER_OFFER_SEED` or `TAKER_SEED`. For the same reason this service must never
be scaled past one replica, and the compose block deliberately does **not**
inherit the `*midnight-endpoints` anchor — that anchor carries
`MIDNIGHT_WALLET_SEED`. Generate a seed with `openssl rand -hex 32`.

### Dry run

`DRY_RUN=true` does the whole of startup — build the wallet, sync, register
NIGHT for dust, join the contract, derive both colours offline, register the
token names, load the journal, read one quote — then prints a JSON report and
exits 0. It never mints and never posts. Run it as a one-off rather than setting
it in `.env`, because the service restarts unless stopped:

```bash
docker compose run --rm -e DRY_RUN=true offer-poster
```

### Endpoints

On `POSTER_HEALTH_PORT` (9977 in the container, `HOST_OFFER_POSTER_HEALTH_PORT`
= 19977 on the host, loopback):

| Route | What it answers |
|---|---|
| `GET /health` | `200 {state, ticks, mints, reoffers, lastTickAt, lastOfferId, lastError, dustBalance, liveOffers, freeCoins, p95TickMs}`. **`503` only after `HEALTH_STALE_TICKS` consecutive FAILED ticks** — `starting` and `degraded` are both `200`, on purpose: a poster waiting for its operator to send NIGHT is not a poster a restart would fix. This is the container healthcheck, which is why its `start_period` is 15 m: the server binds only after wallet sync, dust registration and the contract join. |
| `GET /metrics` | the same counters in Prometheus text format, including tick p50/p95 and the overrun count. |
| `GET /journal` | the journal as JSON, read-only. |

### Running it against preprod

This repo does **not** deploy preprod, and the poster is the only piece of it
that is preprod-ready. What is needed there is an `.env` pointing at the public
endpoints and a funded, dedicated seed:

```dotenv
MIDNIGHT_NETWORK_ID=preprod
MIDNIGHT_INDEXER_HTTP=https://indexer.preprod.midnight.network/api/v3/graphql
MIDNIGHT_INDEXER_WS=wss://indexer.preprod.midnight.network/api/v3/graphql/ws
MIDNIGHT_NODE_HTTP=https://rpc.preprod.midnight.network
# The proof server stays LOCAL — proving is the one step that must not leave
# the operator's machine, and it is the slowest (~30 s per transaction).
MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300
MIDNIGHT_CONTRACT_ADDRESS=6fc44c272d866574cefc14e25474fdfa144e6427f299a8222a8ad8a7b374bb7c
ZSWAP_API=https://preprod.api-zswap.zkdojo.com
OFFER_POSTER_SEED=<a dedicated seed, funded from the preprod faucet>
```

The contract address is what makes the colours right: `WBTC` derives offline to
`e7580bfc…a912` and `WETH` to `fda14e2e…a0a5` under that address, and a
`DRY_RUN` prints both, so a wrong address is visible before anything is minted.
Actually **rolling this out** — adding the `poster` profile to whatever deploys
preprod, and funding the wallet there — belongs to that deployment, not to this
repository.

## Observing the relay

The reference relay has **no `/health` route**. What it does have:

- `GET /tokens` — public; the union of token ids advertised by connected
  solvers. Empty array when none. This is the container healthcheck, and the
  cross-container check for "the solver published a non-empty capabilities
  frame".
- `GET /state` — connected solver count, advertised tokens and price levels, but
  **loopback-only** (`localhostOnly` 403s anything else), so read it from inside
  the container:

  ```bash
  docker compose exec relay wget -qO- http://127.0.0.1:3000/state
  ```

- `POST /quote`, `GET /jobs/:jobId` — the taker flow the E2E driver uses.

Neither observation needs any change to the reference.

## Shared-host rules

Baked in, not conventions to remember: every published port comes from `.env`,
defaults to ≥ 10000, and binds `${BIND_ADDR}` (127.0.0.1). `COMPOSE_PROJECT_NAME`
namespaces everything. `./down.sh` removes containers, networks **and volumes**
and prints the proof.

Volumes always go together. Each one is chain-keyed: a kernel ledger mirror, an
indexer database or a solver journal that outlives its genesis describes
nullifiers, offers and a contract address that no longer exist, and every
symptom of that surfaces somewhere else entirely.

## Known open points (D2 resolves)

- **Indexer GraphQL API path.** This repo's `undeployed` defaults say
  `/api/v3/graphql`; the reference relay's devnet mode assumes
  `/api/v4/graphql`. Both are parameterised (`MIDNIGHT_INDEXER_API_PATH`,
  `RELAY_INDEXER_API_PATH`) so whichever `indexer-standalone v4.3.3` actually
  serves can be selected without touching either codebase.
- **Celestia under emulation** — throughput on an arm64 host is unmeasured.
