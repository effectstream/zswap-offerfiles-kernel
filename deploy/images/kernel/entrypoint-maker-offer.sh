#!/usr/bin/env bash
# entrypoint-maker-offer.sh — seed the kernel order book with ONE real offer.
#
# A client that mirrors the Offer Files book (a taker, a quoting service such as
# the COW solver in https://github.com/effectstream/cow-solver) finds nothing
# to fill or quote in an empty book. This one-shot posts a single genuine offer
# from externally prefunded inventory so a fresh devnet book is not empty. It
# is off unless MAKER_OFFER_ENABLED=true.
#
# It posts a REAL proven offer, not a database row: `bun run seed:market` writes
# rows whose blob is a placeholder and which its own header calls NOT
# settle-able, and a book built from those would let a smoke test pass over a
# stack that can never fill anything.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env ZSWAP_API MIDNIGHT_NETWORK_ID

MARKER_DIR="${MAKER_OFFER_MARKER_DIR:-/var/lib/maker-offer}"
MARKER="${MARKER_DIR}/.posted"
mkdir -p "${MARKER_DIR}"

if [ "${MAKER_OFFER_ENABLED:-false}" != "true" ]; then
  log "MAKER_OFFER_ENABLED=${MAKER_OFFER_ENABLED:-} — not seeding the order book"
  exit 0
fi

require_env MAKER_SEED GIVE_TOKEN WANT_TOKEN

# Idempotent, like the other one-shots: a restart should not
# re-prove and re-post an offer (~30 s of proving) or silently deepen the book
# every time the stack bounces.
if [ -f "${MARKER}" ]; then
  log "JOIN: ${MARKER} exists — a maker offer was already posted for this chain"
  log "$(cat "${MARKER}")"
  exit 0
fi

wait_http "${ZSWAP_API}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-600}"

cd "${REPO_ROOT}"
log "posting one maker offer into the kernel book"
if bun run deploy/scripts/post-maker-offer.ts; then
  date -u +%FT%TZ > "${MARKER}"
  log "maker offer live; marker written to ${MARKER}"
  exit 0
fi

log "ERROR: could not post the maker offer — the book stays empty. Fund"
log "ERROR: MAKER_SEED with GIVE_TOKEN through the external issuer, verify both"
log "ERROR: explicit token IDs, and retry."
exit 1
