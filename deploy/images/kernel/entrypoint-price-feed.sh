#!/usr/bin/env bash
# entrypoint-price-feed.sh — the daily reference-price updater as its OWN
# component (00005 / D1).
#
# It is the only process in the stack that talks to the internet on purpose,
# and the only one that holds COINGECKO_API_KEY. It needs neither Midnight nor
# Celestia: it reads CoinGecko and writes `asset_prices` over the Postgres
# wire. That is why this script waits on the DATABASE and not on the kernel.
#
# THIS SCRIPT MUST NOT VALIDATE THE SERVICE'S OWN CONFIGURATION.
# `packages/price-feed/src/run.ts` decides what a missing key means, and the
# two modes differ: `--once` exits 64 with a message, loop mode logs once and
# IDLES. That second behaviour is deliberate — a compose service that exited
# non-zero on a missing key would crash-loop forever, printing the same line,
# while the stack is perfectly usable on the seeded prices. A pre-check here
# would turn that considered choice into a restart loop.
#
# Arguments are forwarded, so `docker compose run --rm price-feed --once`
# performs a single cycle and exits with the run's own code.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

# What this WRAPPER dials while waiting — not part of the service's contract.
require_env DB_HOST DB_PORT

# The schema this service writes into is applied by the kernel at startup, so
# waiting for the database socket is not enough: on a first boot the tables
# may not exist yet for a few seconds. `run.ts` checks for them explicitly and
# reports a clear message, and in loop mode the retry ladder covers the gap.
wait_tcp "${DB_HOST}" "${DB_PORT}" "database" "${DB_WAIT_TIMEOUT_S:-600}"

cd "${REPO_ROOT}"
# The .dev entrypoint, like every other service in this stack: the compose
# devnet runs MIDNIGHT_NETWORK_ID=undeployed, and for this process the network
# only ever reaches a log line — DB_* decides where it writes.
log "starting price-feed (packages/price-feed/price-feed.dev.ts) args: ${*:-<loop>}"
exec bun run packages/price-feed/price-feed.dev.ts "$@"
