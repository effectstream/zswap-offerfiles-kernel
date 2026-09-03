# `deploy/` — split-component Docker Compose stack

The whole system as **separate Compose services**, one process each: the Midnight
2.x / ledger-v9 chain, the Offer Files kernel, the batcher, the COW solver, and
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
| `midnight-node` | `images/midnight-node` (binaries 0.3.120, `2.0.0-rc.4`) | `midnight-node --dev` | 9944 | `19944` |
| `proof-server` | `images/proof-server` (official `midnightntwrk/proof-server:9.0.0-rc.5`, digest-pinned) | `midnight-proof-server` | 6300 | `16300` |
| `indexer` | `images/indexer` (binaries 0.3.120, `v4.4.0-rc.3`) | `indexer-standalone` | 8088 | `18088` |
| `celestia` | `images/celestia` (`celestia-appd v6.4.10` + `celestia-node v0.28.4`) | supervisor: consensus + bridge | 26657 / 26658 | `16657` / `16658` |
| `pglite` | kernel image | `@effectstream/db` pg-gateway server | 5432 | `15432` |
| `offerfiles-deploy` | kernel image | one-shot: deploy contract, then mint | — | — |
| `kernel` | kernel image | `bun run packages/node/main.dev.ts` | 9999 | `19999` |
| `batcher` | kernel image | `bun run packages/batcher/batcher.dev.ts` | 3334 | `13334` |
| `relay` | `images/relay` (reference @ `061f4d3`, unmodified) | `node packages/relay/dist/relay-main.js` | 3000 / 9001 | `13000` / `19001` |
| `solver` | kernel image | `bun run start.solver.ts` (+ status listener on 9100, bearer-gated, **not published**) | 9100 | — |
| `solver-frontend` | kernel image | `bun run start.solver-frontend.ts` — the read-only monitor site | 8080 | `18080` |
| `register-minted-tokens` | kernel image | one-shot: name the minted colours in `known_tokens` | — | — |
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
| midnight-node | `2.0.0-rc.4` | `@effectstream/npm-midnight-node@0.200.2` |
| proof-server | `9.0.0-rc.5` (plain build) | `@effectstream/npm-midnight-proof-server@0.200.2` (matches the `@midnightntwrk/ledger-v9: 1.0.0-rc.3` override). Release 0.3.120 has no linux-arm64 binary, so this one runs the official multi-arch image the same package falls back to, pinned by digest |
| indexer-standalone | `v4.4.0-rc.3` | `@effectstream/npm-midnight-indexer@0.200.2` pins the 4.4.0 line (rc.1); rc.3 is the one published for both linux arches and fixes rc.1's SQLite starvation — see `images/indexer/Dockerfile` |
| celestia-appd / celestia-node | `v6.4.10` / `v0.28.4` | `@effectstream/celestia@0.200.2` |
| compactc | `0.33.0-rc.2` | `infra/compact-version.txt`, run through `infra/compact.sh` (the `compact` version manager does not publish the 0.33 line) |
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

## Observing the solver

The **monitor site** is the intended way: <http://127.0.0.1:18080> (`HOST_SOLVER_FRONTEND_PORT`,
bound to `BIND_ADDR`). One screen answers "is the solver quoting, and if not, why": a
status pill (QUOTING / WITHDRAWN / DISCONNECTED / STARTING / DRY-RUN / SOLVER UNREACHABLE),
a six-stage health strip (kernel sync → book cache → inventory → journal & DUST → relay
socket → published ladder), the published ladders with the maker offer that closes each
rung, every book offer the solver did **not** publish with the solver's own reason, the
kernel book beside the solver's mirror, inventory, the journal tail, DUST admission, and an
event log. Every block carries a `?` that says what the number means and where it comes
from. The site is read-only and outlives the solver: stop the `solver` container and the
page says SOLVER UNREACHABLE with the time it was last seen, while the kernel and relay
panels stay live. It also has **no authentication of its own** — keep it on the loopback
port, or put the host's reverse proxy in front of it (response buffering off and a read
timeout above five minutes for the SSE feed; see `packages/solver-frontend/README.md`).

Under it, the solver runs a **bearer-gated status listener** on `:9100` — `GET /health`
(open, no internal data), `GET /status/snapshot` and `GET /status/stream` (both require
`Authorization: Bearer $SOLVER_STATUS_AUTH_TOKEN`). The snapshot is the solver's whole
internal state, so the port is **deliberately not published** to the host; the site reads
it across the Compose network with the same `.env` token. To read the raw JSON by hand,
stay inside the network:

```bash
docker compose exec solver bun -e 'const r = await fetch("http://127.0.0.1:9100/status/snapshot",
  { headers: { authorization: `Bearer ${process.env.SOLVER_STATUS_AUTH_TOKEN}` } });
  console.log(r.status); console.log(await r.text());'
```

A request without the bearer is `401` and is counted in the snapshot. Publishing the port
(the commented `ports:` block on the `solver` service, `HOST_SOLVER_STATUS_PORT`) is for a
debugging session on a loopback `BIND_ADDR` only.

**Token names.** The site labels colours from the kernel's `GET /v1/known-tokens` and falls
back to short hex. On a fresh stack the faucet-minted test tokens have no names, because the
mint script's own registration posts to a route the node does not serve
(`issues/00008-mint-test-tokens-registers-stale-path.md`); the `register-minted-tokens`
one-shot repairs that once the kernel is healthy, registering `TESTTOKENA/B/U` from
`minted-tokens.json` — the spellings preprod uses. `REGISTER_MINTED_TOKENS_ENABLED=false`
skips it.

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
  `GIVE_AMOUNT` is base units and defaults to `1000000`, i.e. **one whole coin**
  at the 6 decimals every token in this stack carries.

Either way the offer **spends its coin whole**: no change output, so every offer
is a complete, independent swap rather than a slice of a shared balance. The
want leg is not a knob by default — it is `suggested_to_amount` from
`GET /v1/quote` for that coin's actual value, which lands the offer exactly on
the sponsorship threshold so the batcher pays its Celestia fee (`payFees:false`,
the taker balances).

### A spread of sizes instead of one (`OFFER_POSTER_GIVE_MIN` / `_GIVE_MAX`)

A book of N identical offers gives a taker no choice, and one faucet mint of the
want token may cover some of them and not others. Set a **range in whole coins**
and every *fresh mint* draws its own size:

```bash
OFFER_POSTER_GIVE_AMOUNT=            # blank it — a fixed size and a range are
OFFER_POSTER_GIVE_MIN=0.1            # mutually exclusive (startup error, exit 78)
OFFER_POSTER_GIVE_MAX=10
OFFER_POSTER_SIZE_SEED=              # optional; set it to replay the same sizes
```

| | |
|---|---|
| Unit | **whole coins**, at most 6 decimal places (`0.1`, `1.5`, `10`) — not base units, unlike `GIVE_AMOUNT` |
| Distribution | **log-uniform**: 0.1–1 is as likely as 1–10, so most offers are small with the occasional large one. A uniform draw would put ~90 % of the book above 1 coin |
| Rounding | to the nearest base unit (6 decimals); both ends inclusive |
| Scope | **fresh mints only**. A re-offer posts the coin it already has, at the value that coin was minted with |
| Want leg | quoted per offer for that coin's own give, exactly as before, so sponsorship holds at every size |
| Refusals | `GIVE_MIN` without `GIVE_MAX` (or the reverse), `min > max`, `min <= 0`, more than 6 decimal places, a non-number, or both a fixed amount and a range — each names the offending variable and exits 78 |
| Unset | nothing changes: the poster mints `GIVE_AMOUNT` every tick, as it always has |

`/health` and the `DRY_RUN` report gain `giveRange` and `lastGiveAmount` (base
units) while a range is configured, `/metrics` gains
`offer_poster_last_give_amount`, and the mint log line carries `give=` — so what
the poster asked the faucet for is visible without reading the journal:

```bash
curl -s http://127.0.0.1:19977/health | jq '{giveRange, lastGiveAmount}'
curl -s http://127.0.0.1:19999/v1/offers | jq '[.offers[].computed.gives[0].amount] | unique'
```

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
MIDNIGHT_INDEXER_HTTP=https://indexer.preprod.midnight.network/api/v4/graphql
MIDNIGHT_INDEXER_WS=wss://indexer.preprod.midnight.network/api/v4/graphql/ws
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

- **Indexer GraphQL API path.** Resolved on the ledger-v9 line: the kernel
  (`@effectstream/midnight-contracts@0.200.x`) and the reference relay both use
  `/api/v4/graphql`, the canonical mount of the 4.x indexer. Both stay
  parameterised (`MIDNIGHT_INDEXER_API_PATH`, `RELAY_INDEXER_API_PATH`).
- **Celestia under emulation** — throughput on an arm64 host is unmeasured.
