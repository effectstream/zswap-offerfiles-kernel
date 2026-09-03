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
| `solver` | kernel image | `bun run start.solver.ts` (+ status listener on 9100, bearer-gated, **not published**) | 9100 | — |
| `solver-frontend` | kernel image | `bun run start.solver-frontend.ts` — the read-only monitor site | 8080 | `18080` |
| `register-minted-tokens` | kernel image | one-shot: name the minted colours in `known_tokens` | — | — |
| `price-feed` | kernel image | `bun run packages/price-feed/price-feed.dev.ts` (profile `prices`) | — | — |
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
