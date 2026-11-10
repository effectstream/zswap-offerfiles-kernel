# Local multi-service deployment

This Compose stack runs the Midnight node, indexer and proof server, Celestia,
the kernel, batcher, and optional offer and price tools. It does not deploy an
asset issuer, mint tokens, or register deployment-generated token IDs. Asset
inventory must already exist on the selected network. The COW solver, its relay
and its monitor site have their own stack in
[effectstream/cow-solver](https://github.com/effectstream/cow-solver).

The stack is the local `undeployed` devnet on Midnight 2.x / ledger 9
(`MIDNIGHT_NETWORK_ID=undeployed`). The kernel image it builds also runs the
public networks (`preview`, `preprod`, `mainnet`) as separate processes with
their own env contract (`.env.<network>.example` at the repository root;
Blockfrost endpoints through `MIDNIGHT_BLOCKFROST_PROJECT_ID`, Celestia mocha or
mainnet on the MIP-0006 namespace `mn-swap-v1`); this directory deploys none of
them. A mainnet kernel does not start yet: its ledger-9 reference parameters
are not pinned. Real funds stay NO-GO. See the repository README, "Running on
preview, preprod and mainnet". `GATES_ONLY=public ./gates.sh` runs the offline
public-network gates (G8) against the kernel image.

## Chain images

The Midnight services run the same binaries as the `@effectstream/npm-midnight-*`
0.300.3 wrappers that `bun run dev` launches, fetched at build time from the
[effectstream/binaries 0.3.120](https://github.com/effectstream/binaries/releases/tag/0.3.120)
release and checked against these sha256 sums (a mismatch fails the build).

| Image | Binary | linux/amd64 sha256 | linux/arm64 sha256 | Checked at build |
|---|---|---|---|---|
| `images/midnight-node` | midnight-node `2.1.0-806ff70-ledger9final` | `355c5095ab291cde048b41100ee76e5834a1440f2e8b5522b295c46e775670a1` | `b33d6f7ae5feb9a535540bcc5a24d05503e38095f9e004b988201a86ebe49353` | links, `--version` = `midnight-node 2.1.0`, `res/` tree |
| `images/indexer` | indexer-standalone `v4.4.0-rc.6-ledger9final` | `fa83a5397d42d2c9bd43de1e8fdc8011af3920abff3429bba109490d11a1b01b` | `0667eee4bc85dadc58e03f5a0de5487296a349b5b89ed69512b4d6c300d4a9ba` | links; `config.yaml` is `npm-midnight-indexer@0.300.3`'s (`cache_max_nodes`, `contract_state_cache`) |
| `images/proof-server` | midnight-proof-server `9.0.1` | `1f8e75ff08c5535da7242768c7aafc3f2e64f57add50ce54c8e1701db46cdbc2` | `66e52887dea95912b434a123d9520abcbc164e4201f10aaeb8a51a05773628ec` | links, starts (`--help`); `GET /version` answers `9.0.1` |

Only these `-ledger9final` builds work with the stable ledger-9 client stack:
node and indexer builds that carry the release-candidate ledger crates reject
state-writing calls (Custom error 104) and then fail DUST spends (error 170).
On first start the proof server downloads its ZK parameters from
`srs.midnight.network`, which takes minutes and needs network access.

The Compact compiler pin (not used by the kernel image, which ships no
contract) is `infra/compact-version.txt` = 0.36.0, built by
`infra/compact-toolchain.Dockerfile` from the LFDT-Minokawa release archives
checked against `infra/compact-checksums.sha256`.

## Start the core stack

```bash
cd deploy
./bootstrap.sh
docker compose config
docker compose up -d
docker compose ps
```

`bootstrap.sh` creates the gitignored `.env` and generates the indexer's
secret. Review that file before startup. `./down.sh` tears down containers,
networks and named volumes; those volumes hold chain, database, wallet and
journal state.

The core stack keeps the existing chain and offer flow:

- `midnight-node`, `indexer`, and `proof-server` provide Midnight access.
- `celestia` provides the local DA chain used by the kernel and batcher.
- `pglite`, `kernel`, and `batcher` provide the offer API and settlement path.
  The `pglite` container runs the PGlite server on its loopback interface and
  a forwarder on port 5432 that other containers and `HOST_PGLITE_PORT`
  reach; it has no password (`BIND_ADDR` keeps that port on loopback).
- `maker-offer` is a disabled-by-default one-shot that posts one offer from an
  already funded maker wallet.

## External inventory prerequisites

Before enabling maker seeding or the poster, obtain the 64-hex token IDs from
the selected network registry and fund the relevant wallets through that
network's supported issuer or funding process. The deployment has no fallback
issuer.

For the maker one-shot set `MAKER_OFFER_ENABLED=true`,
`MAKER_OFFER_GIVE_TOKEN`, and `MAKER_OFFER_WANT_TOKEN`. The maker wallet must
already hold a spendable give-token coin of at least `MAKER_OFFER_GIVE_AMOUNT`
and enough fee currency. `MAKER_OFFER_TTL_MINUTES` (default 120) is an
**intent** TTL: see "Offer TTL knobs" below.

## Offer poster

The `poster` profile keeps a durable journal and posts offers from externally
prefunded inventory:

```dotenv
OFFER_POSTER_SEED=<dedicated-wallet-seed>
OFFER_POSTER_GIVE_TOKEN=<64-hex-token-id>
OFFER_POSTER_WANT_TOKEN=<different-64-hex-token-id>
OFFER_POSTER_GIVE_AMOUNT=1000000
```

Start it with:

```bash
docker compose --profile poster up -d offer-poster
```

The poster selects one unjournaled spendable coin with the exact configured
token ID and base-unit amount. `OFFER_POSTER_GIVE_MIN` plus
`OFFER_POSTER_GIVE_MAX` may replace the fixed amount to accept an inclusive
base-unit range. A released journal coin is re-offered before new inventory.
Every built offer must contain exactly the chosen shielded nullifier and no
fallible input. The poster preserves the existing quote, sponsorship, bounded
retry, liveness, reconciliation and kernel nullifier checks.

When no coin matches, the tick reports `degraded` with
`insufficient_inventory` and explains which wallet, token ID and base-unit size
must be funded. It does not attempt to create inventory. The journal is keyed by
network ID and give-token ID; corrupt or mismatched journals are preserved and
refused unless `OFFER_POSTER_JOURNAL_RESET=true` is set deliberately.

The poster exposes `/health`, `/metrics`, and read-only `/journal` on
`HOST_OFFER_POSTER_HEALTH_PORT` (default `19977`). Use a one-off dry run to
inspect configuration and wallet inventory without posting:

```bash
docker compose --profile poster run --rm -e DRY_RUN=true offer-poster
```

### Offer TTL knobs apply to intents only

`OFFER_POSTER_TTL_MINUTES` (the poster's `OFFER_TTL_MINUTES`, default 60) and
`MAKER_OFFER_TTL_MINUTES` (the maker's `TTL_MINUTES`, default 120) are the `ttl`
the tools pass to the wallet's `initSwap`. On the ledger that value exists only
in an **intent**: an unshielded leg's intent, or a DUST fee intent when
`payFees: true`. It must lie within `tblock ≤ ttl ≤ tblock + global_ttl`
(14 days), which the kernel checks with the network's reference ledger
parameters (`INTENT_TTL_EXPIRED` / `INTENT_TTL_TOO_FAR`).

Both tools build **shielded-only** offers with `payFees: false`. For those,
wallet-sdk-facade 5.0.0 writes no intent, so the knob changes neither the
offer bytes nor its expiry: a shielded (zswap) offer has **no TTL**. The kernel
lists it until its proof root leaves the chain's `past_roots`, root last-seen
+ `ROOT_WINDOW_SECONDS` (14 days on ledger 9). The poster also records the value
in its journal (`ttlSec`); re-offers follow the kernel's reported status, not
this value.

## Validation

`./gates.sh` renders every profile, builds images, validates the startup edges
and rejects removed services (the local funding services and the COW solver
services). Focused poster unit tests run in the pinned `oven/bun:1.3.11`
container. See `scripts/README.md` for script ownership.
