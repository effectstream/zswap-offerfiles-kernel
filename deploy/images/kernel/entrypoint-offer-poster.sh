#!/usr/bin/env bash
# entrypoint-offer-poster.sh — the long-running offer poster (00007 / FR-012).
#
# Every POST_INTERVAL_MS the poster either re-offers a coin its journal says came
# back, or mints GIVE_AMOUNT of GIVE_TOKEN from the faucet circuit and posts one
# ZSwap offer whose ONLY input is that exact coin. See deploy/README.md.
#
# ── Why there is no marker file ──────────────────────────────────────────────
# entrypoint-maker-offer.sh and entrypoint-solver-provision.sh write a marker
# and exit early on a restart, because they are ONE-SHOTS: re-running them would
# re-prove and re-post the same seeding artifact every time the stack bounced.
# This service is the opposite — a LOOP whose whole job is to keep posting, so a
# marker would make a restart a permanent no-op. Idempotence lives one level
# down instead, in the JOURNAL (POSTER_JOURNAL_FILE, on its own volume): it is
# written before the mint is submitted and after every state change, so a
# restart re-adopts the coins this poster already owns and re-offers the ones
# that came back rather than minting a fresh set. Deleting that volume is what
# "start over" means here; deleting a marker is not.
#
# ── One facade per seed, ever ────────────────────────────────────────────────
# Two wallet facades on one seed against one Midnight node force each other's
# connection down (the same rule solver-provision waits on). POSTER_SEED must
# therefore be a DEDICATED seed — distinct from MIDNIGHT_WALLET_SEED /
# MIDNIGHT_GENESIS_SEED, BATCHER_WALLET_SEED, SOLVER_SEED, MAKER_SEED /
# MAKER_OFFER_SEED and TAKER_SEED — and this service must never be scaled past
# one replica. `deploy/scripts/lib/poster-config.ts` refuses to start (exit 78,
# EX_CONFIG) if POSTER_SEED collides with any of those seven, which is also why
# compose spells the Midnight endpoints out here instead of merging the
# `*midnight-endpoints` anchor: that anchor carries MIDNIGHT_WALLET_SEED.
#
# `exec` matters: the poster installs SIGTERM/SIGINT handlers that flush the
# journal and stop the wallet within SHUTDOWN_GRACE_MS, and only PID 1 gets
# Compose's signal (FR-012 / US3 scenario 2).
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

# The two the container cannot sensibly default. The WALLET is deliberately not
# checked here: POSTER_SEED xor POSTER_MNEMONIC is an exclusive choice with a
# collision rule attached, and poster-config.ts reports all of it in one place
# with the same exit code this function uses.
require_env ZSWAP_API MIDNIGHT_NETWORK_ID

# The wallet, checked here and not by require_env, because it is an XOR and
# because the two sides have DIFFERENT NAMES on the two sides of compose: the
# process reads POSTER_SEED / POSTER_MNEMONIC, the operator sets
# OFFER_POSTER_SEED / OFFER_POSTER_MNEMONIC in deploy/.env. poster-config.ts
# reports the first pair (it cannot know the second), so this line bridges them
# — and it fails BEFORE the ten-minute contract wait and the kernel wait below,
# which is the whole point of doing it in the shell.
#
# Compose's own `${VAR:?message}` guard would have been the obvious place for
# this and is deliberately not used: Compose interpolates EVERY service before
# it filters by profile, so a `:?` on an opt-in service breaks plain
# `docker compose up` for every operator who never enabled the profile.
if [ -z "${POSTER_SEED:-}" ] && [ -z "${POSTER_MNEMONIC:-}" ]; then
  log "missing required environment: POSTER_SEED or POSTER_MNEMONIC"
  log "set OFFER_POSTER_SEED (or OFFER_POSTER_MNEMONIC) in deploy/.env — a"
  log "DEDICATED seed, not the genesis/batcher/solver/maker/taker one. Generate"
  log "one with: openssl rand -hex 32"
  exit 78 # EX_CONFIG, the same code poster-config.ts uses
fi

# ── "" is not "unset", part two ──────────────────────────────────────────────
# entrypoint-common.sh unsets the blank knobs the OTHER services share; these
# are the poster's own. `readEnv` in poster-config.ts already treats a blank (or
# whitespace-only) value as absent, so this loop is belt-and-braces rather than
# load-bearing — but it keeps the container's environment honest, so that
# `docker compose exec offer-poster env` shows what the process actually used
# and a future reader of `${WANT_AMOUNT:-}` in compose.yml is not misled into
# thinking an empty string forces a want amount of zero.
#
# POSTER_SEED / POSTER_MNEMONIC are NOT in the list: leaving one blank must
# reach the config parser and be reported as the missing wallet it is.
for _poster_env in \
  GIVE_TOKEN \
  GIVE_AMOUNT \
  GIVE_MIN \
  GIVE_MAX \
  GIVE_SIZE_SEED \
  WANT_TOKEN \
  WANT_AMOUNT \
  POST_INTERVAL_MS \
  OFFER_TTL_MINUTES \
  COIN_VISIBLE_TIMEOUT_MS \
  RECONCILE_INTERVAL_MS \
  POSTER_MAX_REOFFERS_PER_TICK \
  SHUTDOWN_GRACE_MS \
  HEALTH_STALE_TICKS \
  POSTER_HEALTH_PORT \
  DRY_RUN \
  POSTER_JOURNAL_FILE \
  POSTER_JOURNAL_RESET \
  POSTER_MIN_DUST \
  POSTER_SYNC_TIMEOUT_MS \
  POSTER_DUST_WAIT_TIMEOUT_MS \
  POSTER_POST_RETRIES \
  POSTER_POST_RETRY_MS \
  POSTER_LIVE_TRIES \
  POSTER_LIVE_INTERVAL_MS
do
  if [ -z "${!_poster_env:-}" ]; then unset "${_poster_env}"; fi
done
unset _poster_env

# The contract address, from the shared offerfiles-deploy volume. The poster
# resolves it itself in the same priority order (MIDNIGHT_CONTRACT_ADDRESS →
# ${CONTRACT_SHARE_DIR}/contract-offer-files.<network>.json → the copy in
# packages/contracts-midnight), so this call is what makes the first branch
# true — and the journal is KEYED by that address: a mismatch refuses to start
# rather than mixing coins from two deployments.
adopt_contract_address

wait_http "${ZSWAP_API}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-600}"

# The journal's own volume. openJournal() mkdir -p's this too; doing it here as
# well means a wrong POSTER_JOURNAL_FILE (a path outside the mount, a typo)
# fails as a plain mkdir error before the wallet spends three minutes syncing.
POSTER_JOURNAL_DIR="$(dirname "${POSTER_JOURNAL_FILE:-/var/lib/offer-poster/journal.json}")"
mkdir -p "${POSTER_JOURNAL_DIR}"

cd "${REPO_ROOT}"
log "starting the offer poster (deploy/scripts/offer-poster.ts)"
log "  kernel=${ZSWAP_API} network=${MIDNIGHT_NETWORK_ID} journal=${POSTER_JOURNAL_FILE:-/var/lib/offer-poster/journal.json}"
if [ -n "${GIVE_MIN:-}" ] || [ -n "${GIVE_MAX:-}" ]; then
  # A range: the size is drawn per fresh mint, so there is no single number to
  # print here. The poster's own banner prints the resolved base units.
  log "  give=${GIVE_TOKEN:-WBTC}/${GIVE_MIN:-<unset>}..${GIVE_MAX:-<unset>} coins (log-uniform per mint, seed=${GIVE_SIZE_SEED:-<random>})"
else
  log "  give=${GIVE_TOKEN:-WBTC}/${GIVE_AMOUNT:-1000000}"
fi
log "  want=${WANT_TOKEN:-WETH}/${WANT_AMOUNT:-<quoted>} interval=${POST_INTERVAL_MS:-60000}ms"
exec bun run deploy/scripts/offer-poster.ts
