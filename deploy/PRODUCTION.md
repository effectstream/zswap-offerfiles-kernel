# Running the kernel in production (native, no orchestrator)

This is the single guide for running the kernel on a public network as native
processes: one systemd unit per program, Postgres with `pg_ivm`, a proof
server, a Celestia light node and nginx in front. It uses **no orchestrator
and no Compose**: `bun run dev` (the orchestrator) and `deploy/compose.yml`
start local dev chains and PGlite, which a public deployment must not run.

The commands are written for preprod on Debian 13. Preview differs only in
its network id and its Blockfrost project; mainnet does not start yet (its
ledger-9 reference parameters are not pinned).

Real funds stay NO-GO for this backend until its first ledger-9 version is
ready for review; the repository owner then reviews the NO-GO.

Contents:

1. [What runs](#1-what-runs)
2. [Host](#2-host)
3. [Bun and the code](#3-bun-and-the-code)
4. [Postgres with pg_ivm](#4-postgres-with-pg_ivm)
5. [Proof server 9.0.1](#5-proof-server-901)
6. [Celestia light node](#6-celestia-light-node)
7. [The environment file](#7-the-environment-file)
8. [First start on a fresh database](#8-first-start-on-a-fresh-database)
9. [systemd units](#9-systemd-units)
10. [Reverse proxy](#10-reverse-proxy)
11. [Funding and DUST](#11-funding-and-dust)
12. [Health and monitoring](#12-health-and-monitoring)
13. [Recovery runbooks](#13-recovery-runbooks)
14. [Upgrades](#14-upgrades)

## 1. What runs

| Unit | Program | Port | Role |
|---|---|---|---|
| `postgresql@17-main` | Postgres 17 with the `pg_ivm` extension | 5432 (loopback) | The kernel's database |
| `midnight-proof-server` | `midnight-proof-server` 9.0.1 | 6300 | Proves the batcher's and the wallet tools' transactions |
| `celestia-light` | `celestia light` (mocha) | 26658 (loopback) | Celestia RPC: reads offers, posts the batcher's blobs |
| `zswap-kernel` | `bun run packages/node/main.public.ts` | 9999 | Sync node and REST / SSE / websocket API |
| `zswap-batcher` | `bun run packages/batcher/batcher.public.ts` | 3334 | Sponsors and posts offers to Celestia |
| `zswap-price-feed` (optional) | `bun run packages/price-feed/price-feed.preview.ts` | — | Refreshes reference prices once a day |
| `zswap-token-registry` (one-shot) | `bun run packages/database/import-token-registry.ts --required` | — | Imports the network's token names, once per database |
| — (by hand) | `bun run deploy/scripts/provision-solver-fees.ts` | — | Registers the batcher's NIGHT for DUST, batcher stopped |
| `nginx` | nginx | 443 | TLS, the only public port |

The kernel and the batcher listen on every interface (the runtime has no bind
address setting): keep 9999, 3334 and 6300 closed in the host firewall and
publish only nginx. The offer poster (`deploy/scripts/offer-poster.ts`) is an
optional extra service with the same env contract; see the
[README's "Services" table](../README.md#services).

## 2. Host

- Debian 13 (trixie), x86-64 or arm64. 16 GB of memory is enough with one
  proof-server worker (section 5).
- **Time must be synchronised.** The health verdict compares chain-tip block
  times with this host's clock (section 12), and the NTP chain is
  wall-clock based. Check with `timedatectl` (`System clock synchronized:
  yes`); Debian's `systemd-timesyncd` is enough.
- One unprivileged user and its directories:

  ```bash
  sudo useradd --system --create-home --home-dir /var/lib/zswap --shell /usr/sbin/nologin zswap
  sudo install -d -o zswap -g zswap -m 0750 /opt/zswap-kernel /var/lib/zswap-batcher
  sudo install -d -o root -g zswap -m 0750 /etc/zswap-kernel
  ```

## 3. Bun and the code

The kernel runs on Bun 1.3.11 (CI pins it; older Bun cannot load the
`@effectstream/*` 0.300.x runtime). Install the release binary and check it
against the release's checksum file:

```bash
sudo apt-get install -y --no-install-recommends ca-certificates curl unzip git
arch=$(uname -m); case "$arch" in x86_64) a=x64;; aarch64) a=aarch64;; esac
cd /tmp
curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-${a}.zip"
curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/SHASUMS256.txt" | grep " bun-linux-${a}.zip\$" | sha256sum -c -
unzip -q "bun-linux-${a}.zip" && sudo install -m 0755 "bun-linux-${a}/bun" /usr/local/bin/bun
bun --version   # 1.3.11
```

Check out the commit you deploy and install the locked dependencies:

```bash
sudo -u zswap git clone https://github.com/effectstream/zswap-offerfiles-kernel.git /opt/zswap-kernel
cd /opt/zswap-kernel
sudo -u zswap git checkout <commit-or-tag>
sudo -u zswap bun install --frozen-lockfile
```

## 4. Postgres with pg_ivm

The effectstream runtime builds its materialized views with
[`pg_ivm`](https://github.com/sraoss/pg_ivm). Without it the node exits at
startup with `Effectstream startup aborted: the pg_ivm PostgreSQL extension is
not available …` (`ALLOW_NO_PG_IVM=true` selects a dev/test-only fallback;
do not use it here). Debian's own archive has no `pg_ivm`; the PostgreSQL
project's apt repository (PGDG) has it:

```bash
sudo apt-get install -y --no-install-recommends postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get install -y --no-install-recommends postgresql-17 postgresql-17-pg-ivm
```

Create the database and its user (choose the password; it goes only into the
environment file):

```bash
sudo -u postgres psql -c "CREATE ROLE zswap LOGIN PASSWORD '<db-password>'"
sudo -u postgres psql -c "CREATE DATABASE zswap OWNER zswap"
sudo -u postgres psql -d zswap -c "CREATE EXTENSION IF NOT EXISTS pg_ivm"
```

**Start on an empty database.** Data written by a ledger-8 kernel does not
deserialize under ledger 9, and no migration exists: a host that ran the
ledger-8 kernel gets a new database. The kernel applies its own migrations
when it processes its first block.

## 5. Proof server 9.0.1

Use `midnight-proof-server` 9.0.1 from the
[effectstream/binaries 0.3.120](https://github.com/effectstream/binaries/releases/tag/0.3.120)
release, the ledger-9 prover this stack pins (`deploy/images/proof-server/Dockerfile`
has the same steps and the sha256 of both assets). It runs on stock
Debian 13; the older 9.0.0-rc.6 asset needed a dynamic-loader wrapper. A link
check and a smoke start catch a host that cannot run it:

```bash
arch=$(dpkg --print-architecture)   # amd64 or arm64
case "$arch" in
  amd64) sha=1f8e75ff08c5535da7242768c7aafc3f2e64f57add50ce54c8e1701db46cdbc2 ;;
  arm64) sha=66e52887dea95912b434a123d9520abcbc164e4201f10aaeb8a51a05773628ec ;;
esac
cd /tmp
curl -fsSL -o ps.zip "https://github.com/effectstream/binaries/releases/download/0.3.120/midnight-proof-server-linux-${arch}-9.0.1.zip"
echo "${sha}  ps.zip" | sha256sum -c -
unzip -q ps.zip -d ps
sudo install -m 0755 "ps/midnight-proof-server-linux-${arch}-9.0.1" /usr/local/bin/midnight-proof-server
ldd /usr/local/bin/midnight-proof-server | grep "not found" && echo "MISSING LIBRARIES" || echo "links OK"
/usr/local/bin/midnight-proof-server --help > /dev/null && echo "starts OK"
```

On its first start it downloads its ZK parameters from `srs.midnight.network`
and opens its port only once they are in place.

**Memory.** Each worker holds its own proving keys in memory. On a host with
16 GB or less run one worker (`MIDNIGHT_PROOF_SERVER_NUM_WORKERS=1` in its
unit, section 9): with two, a large proof was killed for memory on a 16 GB
host. A killed worker leaves its caller waiting for an answer that never
comes; the kernel's wallet tools stop waiting after
`MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS` (default 600000 ms) and name the proof
server. The batcher's own proofs have no deadline yet (`TODO.md`, "Upstream").

## 6. Celestia light node

Preview and preprod read and post offers on Celestia **mocha**, in the
MIP-0006 shared namespace `mn-swap-v1`. Run a `celestia-node` light node on
mocha (follow Celestia's own install guide for the binary), then:

```bash
celestia light init --p2p.network mocha
celestia light start --p2p.network mocha --core.ip <mocha-consensus-host> --core.port 9090
celestia light auth admin --p2p.network mocha   # the bearer token: CELESTIA_AUTH_TOKEN
celestia state account-address --p2p.network mocha   # fund it with mocha TIA (section 11)
```

- **Auth.** The kernel and the batcher send `CELESTIA_AUTH_TOKEN` as a bearer
  token. A light node started with `--rpc.skip-auth` needs none: then set
  `CELESTIA_AUTH_IN_URL=true` and leave `CELESTIA_AUTH_TOKEN` empty (the
  setting means "the URL carries whatever credential is needed", which here is
  none).
- **Slow reads.** A light node can stall a read for about a minute. The
  sync's Celestia client gives each request `CELESTIA_RPC_TIMEOUT_MS`
  (default 15000) and retries; on a light node set
  `CELESTIA_RPC_TIMEOUT_MS=90000` and `CELESTIA_FETCH_CONCURRENCY=6` so that a
  stalled read finishes instead of piling up timeouts.
- **Pruning.** A light node keeps only a recent window of Celestia history.
  Pick `CELESTIA_START_HEIGHT` inside it (section 8); section 13 says what
  happens and what to do when the node needs heights the light node no longer
  has.

## 7. The environment file

All units read one file, the repository's env contract for the network.
Start from [`.env.preprod.example`](../.env.preprod.example) (preview:
[`.env.preview.example`](../.env.preview.example)): every variable there is
tagged with the services that read it, secrets are empty, and optional knobs
are shown with their defaults. Keep the filled-in file outside the checkout,
readable by the service user only:

```bash
sudo install -o root -g zswap -m 0640 /opt/zswap-kernel/.env.preprod.example /etc/zswap-kernel/preprod.env
sudoedit /etc/zswap-kernel/preprod.env
```

Set at least:

| Variable | Value on this host |
|---|---|
| `MIDNIGHT_NETWORK_ID` | `preprod` |
| `MIDNIGHT_BLOCKFROST_PROJECT_ID` | the preprod Blockfrost project token (secret) |
| `MIDNIGHT_PROOF_SERVER_URL` | `http://127.0.0.1:6300` |
| `CELESTIA_RPC_URL` | `http://127.0.0.1:26658` |
| `CELESTIA_AUTH_TOKEN` | the light node's admin token (secret), or `CELESTIA_AUTH_IN_URL=true` |
| `CELESTIA_START_HEIGHT`, `MIDNIGHT_START_BLOCK`, `NTP_START_TIME` | section 8 |
| `PGLITE` | `false` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PW`, `DB_NAME` | `127.0.0.1`, `5432`, `zswap`, the password (secret), `zswap` |
| `BATCHER_SUBMIT_URL` | `http://127.0.0.1:3334` |
| `BATCHER_NODE_API_URL` | `http://127.0.0.1:9999` |
| `BATCHER_WALLET_SEED` | the batcher's own funded seed (secret, never a repository dev seed) |
| `BATCHER_STORAGE_DIR` | `/var/lib/zswap-batcher` |
| `EFFECTSTREAM_TRUST_PROXY` | `127.0.0.1` behind the nginx of section 10 |
| `TOKEN_REGISTRY_NETWORK` | `preprod` |
| `MIDNIGHT_WALLET_SYNC_TIMEOUT_MS` | `3600000`: a first wallet sync on preprod takes 10 to 55 minutes |

Optional knobs this guide uses: `CELESTIA_RPC_TIMEOUT_MS`,
`CELESTIA_FETCH_CONCURRENCY` (section 6), `MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS`
(section 5) and the `SYNC_HEALTH_*` thresholds (section 12).

Never put a secret on a command line or in the checkout. `check-env.ts` reads
`.env` at the root of the checkout; link the file there to check it (the link
is git-ignored and holds no copy of the secrets):

```bash
cd /opt/zswap-kernel
sudo -u zswap ln -sf /etc/zswap-kernel/preprod.env .env
sudo -u zswap bun check-env.ts
sudo -u zswap bun run packages/node/public-network-profile.ts   # the node's own preflight
```

Both name every problem at once; the services refuse the same problems with
exit 78 (`EX_CONFIG`).

## 8. First start on a fresh database

The runtime records the start heights, the NTP anchor and the NTP block time
in the database on its first boot, and refuses a different value later
(unless `USE_DB_STARTHEIGHT` is set, and then the database wins). Choose them
once, before the first start.

**Where to start.** `MIDNIGHT_START_BLOCK` defaults to 1 and `NTP_START_TIME`
to the network's block 1: a node indexes the whole Midnight history, millions
of indexer requests through Blockfrost and many hours. To start near the
tips instead, read the current Midnight tip (height and block time in ms) and
the light node's head. The token reaches `curl` through its standard input,
never through its arguments:

```bash
set -a; . /etc/zswap-kernel/preprod.env; set +a
printf 'url = "https://midnight-preprod.blockfrost.io/api/v0?project_id=%s"\n' "$MIDNIGHT_BLOCKFROST_PROJECT_ID" |
  curl -fsS -K - -H 'content-type: application/json' --data '{"query":"{ block { height timestamp } }"}'
printf 'header = "Authorization: Bearer %s"\n' "$CELESTIA_AUTH_TOKEN" |
  curl -fsS -K - -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"header.NetworkHead","params":[]}' "$CELESTIA_RPC_URL" |
  grep -o '"height":"[0-9]*"' | head -1
```

Set `MIDNIGHT_START_BLOCK` a few blocks below the Midnight tip,
`NTP_START_TIME` to **that block's** `timestamp` (the startup log then warns
that it overrides the block-1 anchor; that is expected), and
`CELESTIA_START_HEIGHT` a little below the light node's head. A start near the
tip has a cost: the kernel judges an offer's inputs against what it indexed,
so a coin spent before `MIDNIGHT_START_BLOCK` is not in its nullifier set
(settlement of such an offer then fails on chain), and an offer proven against
a Merkle root older than the start is refused as `ROOT_UNKNOWN`. Starting at
block 1 avoids both.

**`BLOCK_TIME_MS`** (default 600000, ten minutes) is the NTP chain's block
time. The node merges the Midnight and Celestia blocks it fetched into one NTP
block per `BLOCK_TIME_MS`, so a new offer shows up in the book within about
one NTP block, and the health verdict allows an NTP lag of
`SYNC_HEALTH_MAX_NTP_LAG_BLOCKS` × `BLOCK_TIME_MS`. It is recorded in the
database on the first boot and the NTP heights already stored were computed
with it: changing it needs a fresh database. The Midnight fetch step and
poll (`packages/node/config.preview.ts`: 500 blocks every second, one indexer
request per block) are not settable yet (`TODO.md`); they keep well ahead of
Midnight's ~6 s blocks, but a catch-up step is 500 parallel requests to
Blockfrost, so a start far below the tip spends the plan's request quota
quickly.

Start the units in this order: Postgres, proof server, light node, kernel,
batcher; then run the token-registry one-shot once (section 9). The kernel
reaches `/v1/health` `ok` once its first NTP block has finalized, up to one
`BLOCK_TIME_MS` plus a few minutes after the start.

## 9. systemd units

One unit per program. Each runs as `zswap` from `/opt/zswap-kernel` with the
environment file; secrets stay in that file.

`/etc/systemd/system/midnight-proof-server.service`:

```ini
[Unit]
Description=Midnight proof server 9.0.1
After=network-online.target
Wants=network-online.target

[Service]
User=zswap
Environment=MIDNIGHT_PROOF_SERVER_NUM_WORKERS=1
Environment=RUST_BACKTRACE=full
ExecStart=/usr/local/bin/midnight-proof-server --port 6300
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/zswap-kernel.service`:

```ini
[Unit]
Description=Offer Files kernel (sync node + API)
After=network-online.target postgresql@17-main.service celestia-light.service
Wants=network-online.target
Requires=postgresql@17-main.service

[Service]
User=zswap
WorkingDirectory=/opt/zswap-kernel
EnvironmentFile=/etc/zswap-kernel/preprod.env
ExecStartPre=/usr/local/bin/bun run packages/node/public-network-profile.ts
ExecStart=/usr/local/bin/bun run packages/node/main.public.ts
Restart=always
RestartSec=10
# A configuration refusal (exit 78) does not get better by restarting.
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/zswap-batcher.service`:

```ini
[Unit]
Description=Offer Files batcher
After=network-online.target zswap-kernel.service midnight-proof-server.service celestia-light.service
Wants=network-online.target

[Service]
User=zswap
WorkingDirectory=/opt/zswap-kernel
EnvironmentFile=/etc/zswap-kernel/preprod.env
ExecStartPre=/usr/local/bin/bun run packages/batcher/batcher.public.ts --check
ExecStart=/usr/local/bin/bun run packages/batcher/batcher.public.ts
Restart=always
RestartSec=10
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/zswap-token-registry.service` (one-shot; exit 3 means
"nothing to import" for this network, which is not a failure):

```ini
[Unit]
Description=Offer Files token-registry import (once per database)
After=zswap-kernel.service

[Service]
Type=oneshot
User=zswap
WorkingDirectory=/opt/zswap-kernel
EnvironmentFile=/etc/zswap-kernel/preprod.env
ExecStart=/usr/local/bin/bun run packages/database/import-token-registry.ts --required
SuccessExitStatus=3
```

`/etc/systemd/system/zswap-price-feed.service` (optional; needs
`COINGECKO_API_KEY` in the environment file):

```ini
[Unit]
Description=Offer Files reference-price feed
After=zswap-kernel.service

[Service]
User=zswap
WorkingDirectory=/opt/zswap-kernel
EnvironmentFile=/etc/zswap-kernel/preprod.env
ExecStart=/usr/local/bin/bun run packages/price-feed/price-feed.preview.ts
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
```

The light node gets a unit of the same shape around the `celestia light
start` command of section 6. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now midnight-proof-server celestia-light zswap-kernel zswap-batcher
sudo systemctl start zswap-token-registry
```

The token-registry import runs after the kernel's first start (the schema
must exist; it retries meanwhile). On preprod it currently imports nothing:
the published registry file is still labelled 1.x, and the import accepts
ledger-9 (`midnight-2.x`) files only.

## 10. Reverse proxy

nginx terminates TLS and forwards to the kernel on loopback. Three things
matter:

- **Long requests.** `POST /v1/offers` waits for the batcher's receipt, up to
  `BATCHER_SUBMIT_TIMEOUT_MS` (default 310000 ms, at most 600000 ms), so its
  `proxy_read_timeout` must be longer than that, or nginx answers 504 while
  the offer is still being posted. If you also publish the batcher's
  `/send-input`, its `wait-receipt` mode holds the request for at least the
  batcher's receipt wait (300 s per transaction hash); give it the same 660 s.
- **Streams.** `GET /v1/offers/stream` (Server-Sent Events, a heartbeat every
  30 s) needs buffering off and `Connection ""`; `GET /v1/offers/updates`
  (websocket, a ping every 30 s) needs the upgrade headers. Both need a long
  read timeout.
- **Client addresses.** The kernel rate-limits per client address
  (`API_RATE_LIMIT_MAX` per minute). Behind a proxy every request comes from
  127.0.0.1, so all clients share one bucket, unless
  `EFFECTSTREAM_TRUST_PROXY` names the proxy (here `127.0.0.1`) and the proxy
  sends `X-Forwarded-For`.

```nginx
server {
    listen 443 ssl;
    server_name preprod.api.example.org;
    # ssl_certificate / ssl_certificate_key ...

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location = /v1/offers {
        proxy_pass http://127.0.0.1:9999;
        proxy_read_timeout 660s;
        proxy_send_timeout 660s;
    }
    location = /v1/offers/stream {
        proxy_pass http://127.0.0.1:9999;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
    location = /v1/offers/updates {
        proxy_pass http://127.0.0.1:9999;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
    location / {
        proxy_pass http://127.0.0.1:9999;
    }
}
```

## 11. Funding and DUST

Done by hand, once, before offers are posted (the
[README's "Funding runbook"](../README.md#funding-runbook) has the details):

1. **Batcher DUST.** Send NIGHT to the unshielded address of
   `BATCHER_WALLET_SEED`, then register it for DUST **with the batcher
   stopped** (one wallet facade per seed):

   ```bash
   sudo systemctl stop zswap-batcher
   cd /opt/zswap-kernel
   sudo -u zswap sh -c 'set -a; . /etc/zswap-kernel/preprod.env; set +a;
     SOLVER_SEED="$BATCHER_WALLET_SEED" SOLVER_PROVISION_RECEIPT=/var/lib/zswap-batcher/dust-receipt.json \
     bun run deploy/scripts/provision-solver-fees.ts'
   sudo systemctl start zswap-batcher
   ```

   Each registered NIGHT UTXO is one concurrent fee slot
   (`BATCHER_MAX_SLOTS_PER_WALLET`, default 1).
2. **Celestia signer.** Fund the light node's account with mocha TIA; the
   batcher pays one blob fee per sponsored offer.

## 12. Health and monitoring

`GET /v1/health` is the verdict to watch:

- `status` / `synced`: the verdict **damped by hysteresis**. It changes only
  after `SYNC_HEALTH_HYSTERESIS_SAMPLES` (default 3) consecutive samples
  disagree with it; a sample is one read of the chain tips, which are cached
  60 s. One slow light-node read therefore does not flip it, and a real outage
  shows after about three minutes.
- `raw_status` and `reasons[]`: the latest sample's own verdict and why it is
  not `ok` (`source`: `ntp`, `midnight`, `celestia`; `rule`: `lag`, `stale`,
  `tip_unknown`, `position_unknown`, …, with the numbers).
- `freshness.midnight` / `freshness.celestia`: the tip's block time against
  this host's clock. A source whose tip is older than
  `SYNC_HEALTH_MAX_MIDNIGHT_TIP_AGE_SECONDS` /
  `SYNC_HEALTH_MAX_CELESTIA_TIP_AGE_SECONDS` (default 180) is `stale`, and the
  verdict is not `ok` even when heights look caught up: a frozen indexer or
  light node.

`GET /v1/health/sync` keeps its detailed per-protocol positions, and its
`status` is the undamped per-sample verdict, which offer validation also
uses. [API.md, `GET /v1/health`](../API.md#get-v1health) has every field.

Sizing the thresholds: Midnight and mocha both make a block about every 6 s.
The defaults (`SYNC_HEALTH_MAX_MIDNIGHT_LAG_BLOCKS` 12,
`SYNC_HEALTH_MAX_CELESTIA_LAG_BLOCKS` 4, `SYNC_HEALTH_MAX_NTP_LAG_BLOCKS` 2)
are today's values. Raise a lag limit only if the source lags by design (a
light node that is always a few blocks behind); prefer raising the hysteresis
over the lag limits, because the lag limits also gate offer validation. Each
value must be a positive integer; a malformed one stops the node with exit 78
naming it.

**Watch the light node from outside.** The sync retries a failing Celestia
read for ever (section 13), so the node does not stop on its own. Alert when
`/v1/health` has not been `ok` for longer than you accept, and when
`reasons` names `celestia` with `stale` or `tip_unknown`; a timer that runs
`curl -fsS http://127.0.0.1:9999/v1/health` is enough. Also alert on the
light node's own head (`celestia header network-head`) standing still.

## 13. Recovery runbooks

**Celestia "below Tail".** The node's log repeats `requested header … is
below Tail` (or another "pruned" answer) for the same height, and
`/v1/health` stays `syncing` with a growing Celestia lag. The light node no
longer has the heights the node still needs; effectstream's Celestia client
retries that for ever (`TODO.md`, "Upstream"). Two ways out:

- **Re-anchor on a fresh database.** Stop the kernel and the batcher, drop and
  recreate the database (section 4), pick new start heights near the tips
  (section 8, with `CELESTIA_START_HEIGHT` near the light node's current head),
  start again and re-run the token-registry import. Offers posted before the
  new start are not in the book.
- **Point at an archival endpoint.** Set `CELESTIA_RPC_URL` (and its auth) to a
  Celestia node that still serves those heights (a bridge or full node), keep
  the database, and restart the kernel; it continues where it stopped.

**Frozen light node.** `freshness.celestia.state` is `stale`, or `reasons`
names `celestia` with `tip_unknown` on every sample. Restart the light node
unit, check its peers and its head; if it freezes again, re-initialise it. A
light node restarted after a long stop may have pruned what the kernel needs:
then follow "below Tail".

**Stale Midnight tip.** `freshness.midnight.state` is `stale`: the indexer
answers but does not advance. Check Blockfrost's status and the project's
request quota; a token of another network is refused at startup instead.

## 14. Upgrades

- **Same ledger, new commit:** check out the new commit, run
  `bun install --frozen-lockfile`, restart the kernel and the batcher.
- **A ledger change or a different `BLOCK_TIME_MS`** needs a fresh database
  (section 8): stored data does not deserialize across ledgers, and NTP
  heights depend on the block time.
- **Real funds:** Real funds stay NO-GO for this backend until its first
  ledger-9 version is ready for review; the repository owner then reviews the
  NO-GO.
