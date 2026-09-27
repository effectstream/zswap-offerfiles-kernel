# Local multi-service deployment

This Compose stack runs the Midnight node, indexer and proof server, Celestia,
the kernel, batcher, reference relay, solver, and optional offer tools. It does
not deploy an asset issuer, mint tokens, or register deployment-generated token
IDs. Asset inventory must already exist on the selected network.

## Start the core stack

```bash
cd deploy
./bootstrap.sh
docker compose config
docker compose up -d
docker compose ps
```

`bootstrap.sh` creates the gitignored `.env` and generates local bearer tokens.
Review that file before startup. `./down.sh` tears down containers, networks and
named volumes; those volumes hold chain, database, wallet and journal state.

The core stack keeps the existing chain and offer flow:

- `midnight-node`, `indexer`, and `proof-server` provide Midnight access.
- `celestia` provides the local DA chain used by the kernel and batcher.
- `pglite`, `kernel`, and `batcher` provide the offer API and settlement path.
- `relay`, `solver`, and `solver-frontend` provide intent intake, solving and
  monitoring.
- `solver-provision` is a one-shot external-inventory check. It never funds a
  wallet or writes prices. It verifies prefunded NIGHT can produce usable DUST
  and writes a factual balance receipt.
- `maker-offer` is a disabled-by-default one-shot that posts one offer from an
  already funded maker wallet.

## External inventory prerequisites

Before enabling solver provisioning, maker seeding, the poster, or E2E, obtain
the 64-hex token IDs from the selected network registry and fund the relevant
wallets through that network's supported issuer or funding process. The
deployment has no fallback issuer.

For solver provisioning set:

```dotenv
SOLVER_PROVISION_ENABLED=true
```

`SOLVER_SEED` must already hold unshielded NIGHT. Provisioning fails unless its
NIGHT is registered, or already registered, and the wallet reports usable DUST.
The receipt records `inventorySource: "external"`, `dustReady: true`, measured
balances, and `pricingSource: "live-offer-files-book"`. When provisioning is
disabled, the service exits successfully without creating a pricing artifact.

For the maker one-shot set `MAKER_OFFER_ENABLED=true`,
`MAKER_OFFER_GIVE_TOKEN`, and `MAKER_OFFER_WANT_TOKEN`. The maker wallet must
already hold a spendable give-token coin of at least `MAKER_OFFER_GIVE_AMOUNT`
and enough fee currency. `MAKER_OFFER_TTL_MINUTES` follows the same rule as the
poster's offer TTL (see [Offer TTL](#offer-ttl)): blank means 20,100 minutes,
and a larger value is refused.

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

### Offer TTL

The poster (`OFFER_POSTER_TTL_MINUTES`) and the maker one-shot
(`MAKER_OFFER_TTL_MINUTES`) choose the `ttl` their wallet passes to `initSwap`.
Both default to **20,100 minutes**: the kernel's root window, which is the
ledger's `global_ttl` of 1,209,600 s (14 days), minus a **1-hour safety
margin**. Ledger 9 rejects an intent whose `ttl` is later than block time plus
`global_ttl`, and the chain's block clock can lag the wall clock the tool
computes `now + ttl` from. With the margin, a block clock up to one hour behind
is still accepted. 20,100 minutes is also the **upper bound**: a larger value
stops the tool at startup with an error that names the variable and the bound.
Leave both knobs blank to follow the default. `.env.example` leaves them blank,
and compose passes a blank value through.

A long TTL keeps the offered coin locked for as long as the offer lives. The
poster re-offers a coin only after the kernel reports its offer `expired`,
`cancelled` or `rejected`. With about 14-day offers, the inventory the poster
can offer runs out sooner, so fund the wallet with enough coins of the
configured size.

The kernel's own listed expiry of a **shielded** offer does not come from this
value. It is the proof root's anchor plus `ROOT_WINDOW_SECONDS`, capped by
`OFFER_TTL_SECONDS`, both 14 days by default. With the pinned wallet SDK
(`wallet-sdk-facade` 5.0.0-beta.2), a shielded-only swap built with
`payFees: false` carries no intent, so the TTL does not appear in the offer's
bytes. The poster records it in its journal. The bound starts to matter once
the TTL lands in an intent, for example with an unshielded leg, fee payment,
or a newer SDK.

## E2E profile

The E2E driver performs real local chain and Celestia settlement. Configure
`E2E_TOKEN_IN` and `E2E_TOKEN_OUT` with explicit IDs and prefund the maker and
taker wallets before running it. No E2E command should target a public network
unless an operator has deliberately supplied that network's endpoints and
funding.

## Validation

`./gates.sh` renders every profile, builds images, validates retained startup
edges and rejects the removed local funding services. Focused poster and
provisioning unit tests run in the pinned `oven/bun:1.3.11` container. See
`scripts/README.md` for script ownership and receipts.
