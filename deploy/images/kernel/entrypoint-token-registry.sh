#!/usr/bin/env bash
# entrypoint-token-registry.sh — ONE-SHOT: import the selected network's
# canonical mint-test-tokens registry into the kernel database (00050 FR-004).
#
# A fresh kernel database is seeded with the PREPROD token colours and the
# Preprod SNIGHT (packages/database/migrations/000-init.sql). On any other
# public network those rows name tokens that do not exist there, and the
# kernel quotes the real network's tokens as unknown ($1 demo fallback). This
# one-shot replaces them from
# `${TOKEN_REGISTRY_BASE_URL:-https://mint-test-tokens.pages.dev/}metadata.<network>.json`
# (on stagenet it also removes the Preprod SNIGHT), in one transaction.
#
# Unlike the dev orchestrator's optional step (start.dev.ts, `critical: false`)
# a failure here is LOUD: the import runs with `--required`, so an unreachable
# registry, an invalid document or a database error exits non-zero instead of
# being reported as a skip. It retries a bounded number of times first,
# because on a fresh database the kernel creates the schema only when it
# processes its first block, a little after its API starts answering.
#
#   TOKEN_REGISTRY_NETWORK          required: preview | preprod | stagenet
#   DB_HOST DB_PORT                 required (DB_USER / DB_PW / DB_NAME optional)
#   ZSWAP_API                       optional: wait for the kernel API first
#   TOKEN_REGISTRY_ATTEMPTS         optional, default 12
#   TOKEN_REGISTRY_RETRY_DELAY_S    optional, default 10
#   TOKEN_REGISTRY_BASE_URL / _TIMEOUT_MS  optional, see import-token-registry.ts
#
# Run it once per database, after the kernel has started; re-running is
# idempotent (same revision → no change).
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env TOKEN_REGISTRY_NETWORK DB_HOST DB_PORT

case "${TOKEN_REGISTRY_NETWORK}" in
  preview|preprod|stagenet) ;;
  *)
    log "TOKEN_REGISTRY_NETWORK must be preview, preprod or stagenet, got '${TOKEN_REGISTRY_NETWORK}' (undeployed has no public registry)"
    exit 78 # EX_CONFIG
    ;;
esac

ATTEMPTS="${TOKEN_REGISTRY_ATTEMPTS:-12}"
DELAY="${TOKEN_REGISTRY_RETRY_DELAY_S:-10}"
case "${ATTEMPTS}" in ''|*[!0-9]*|0) log "TOKEN_REGISTRY_ATTEMPTS must be a positive integer, got '${ATTEMPTS}'"; exit 78 ;; esac
case "${DELAY}" in ''|*[!0-9]*) log "TOKEN_REGISTRY_RETRY_DELAY_S must be a non-negative integer, got '${DELAY}'"; exit 78 ;; esac

wait_tcp "${DB_HOST}" "${DB_PORT}" "database" "${DB_WAIT_TIMEOUT_S:-300}"
if [ -n "${ZSWAP_API:-}" ]; then
  wait_http "${ZSWAP_API}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-600}"
fi

cd "${REPO_ROOT}"
attempt=1
while :; do
  log "importing the ${TOKEN_REGISTRY_NETWORK} token registry (attempt ${attempt}/${ATTEMPTS})"
  if bun run packages/database/import-token-registry.ts --required; then
    log "token registry import applied"
    exit 0
  fi
  if [ "${attempt}" -ge "${ATTEMPTS}" ]; then
    log "token registry import FAILED after ${ATTEMPTS} attempt(s); the database still holds the previous (seeded Preprod) rows"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "${DELAY}"
done
