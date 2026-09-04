#!/usr/bin/env bash
# entrypoint-maker-offer.sh — seed the kernel order book with ONE real offer.
#
# The solver's ladder is derived from the mirrored Offer Files book
# (`deriveLadder(cache.book.all(), …)`), not from its ladder config file. An
# empty book therefore means an empty ladder no matter how well funded the
# solver is — the second half of the silent trap described in
# entrypoint-solver-provision.sh.
#
# So that a plain `docker compose up` produces the stack the deployment claims
# to produce — a solver quoting a real pair at the relay — this one-shot posts a
# single genuine offer. It is a DEVNET seeding step, exactly like the
# post-kernel mint one-shot; set MAKER_OFFER_ENABLED=false to skip it.
#
# It posts a REAL proven offer, not a database row: `bun run seed:market` writes
# rows whose blob is a placeholder and which its own header calls NOT
# settle-able, and a ladder built from those would let this smoke pass over a
# stack that can never fill anything.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env ZSWAP_API MIDNIGHT_NETWORK_ID

MARKER_DIR="${MAKER_OFFER_MARKER_DIR:-/var/lib/maker-offer}"
MARKER="${MARKER_DIR}/.posted"
mkdir -p "${MARKER_DIR}"

if [ "${MAKER_OFFER_ENABLED:-true}" != "true" ]; then
  log "MAKER_OFFER_ENABLED=${MAKER_OFFER_ENABLED:-} — not seeding the order book"
  exit 0
fi

# Idempotent for the same reason as the other one-shots: a restart should not
# re-prove and re-post an offer (~30 s of proving) or silently deepen the book
# every time the stack bounces.
if [ -f "${MARKER}" ]; then
  log "JOIN: ${MARKER} exists — a maker offer was already posted for this chain"
  log "$(cat "${MARKER}")"
  exit 0
fi

adopt_contract_address

wait_http "${ZSWAP_API}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-600}"

cd "${REPO_ROOT}"
log "posting one maker offer into the kernel book"
if bun run deploy/scripts/post-maker-offer.ts; then
  date -u +%FT%TZ > "${MARKER}"
  log "maker offer live; marker written to ${MARKER}"
  exit 0
fi

log "ERROR: could not post the maker offer — the solver will publish an EMPTY"
log "ERROR: ladder (nothing to quote). See the log above for the cause."
exit 1
