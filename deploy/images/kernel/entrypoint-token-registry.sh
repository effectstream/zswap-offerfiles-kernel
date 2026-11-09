#!/usr/bin/env bash
# entrypoint-token-registry.sh — ONE-SHOT: import the selected network's
# canonical token registry into the kernel database.
#
# A fresh kernel database lists only NIGHT (packages/database/migrations/
# 000-init.sql). This one-shot adds the network's canonical tokens from its
# source (packages/database/import-token-registry.ts, `registrySourceFor`):
#   preview, preprod  the published registry file
#                     `${TOKEN_REGISTRY_BASE_URL:-https://mint-test-tokens.pages.dev/}metadata.<network>.json`,
#                     imported only when it is labelled `midnight-2.x`;
#   mainnet           no source yet: nothing is imported, NIGHT stays the only token.
# One transaction; re-running is idempotent (same revision → no change).
#
# Exit status of the import (`--required`):
#   0  applied                                → exit 0
#   3  nothing to import by policy: no source, → exit 0 after the import's one
#      a missing file, or a file not labelled    warning line, no retry
#      for ledger 9
#   *  failed (unreachable registry, invalid   → retried, then exit 1 (LOUD)
#      document, database error)
# It retries a bounded number of times because on a fresh database the kernel
# creates the schema only when it processes its first block, a little after
# its API starts answering.
#
#   TOKEN_REGISTRY_NETWORK          required: preview | preprod | mainnet
#   DB_HOST DB_PORT                 required (DB_USER / DB_PW / DB_NAME optional)
#   ZSWAP_API                       optional: wait for the kernel API first
#   TOKEN_REGISTRY_ATTEMPTS         optional, default 12
#   TOKEN_REGISTRY_RETRY_DELAY_S    optional, default 10
#   TOKEN_REGISTRY_BASE_URL / _TIMEOUT_MS  optional, see import-token-registry.ts
#
# Run it once per database, after the kernel has started.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env TOKEN_REGISTRY_NETWORK DB_HOST DB_PORT

case "${TOKEN_REGISTRY_NETWORK}" in
  preview|preprod|mainnet) ;;
  *)
    log "TOKEN_REGISTRY_NETWORK must be preview, preprod or mainnet, got '${TOKEN_REGISTRY_NETWORK}' (undeployed has no public registry)"
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

# Keep in step with EXIT_NOTHING_TO_IMPORT in import-token-registry.ts.
nothing_to_import=3

cd "${REPO_ROOT}"
attempt=1
while :; do
  log "importing the ${TOKEN_REGISTRY_NETWORK} token registry (attempt ${attempt}/${ATTEMPTS})"
  status=0
  bun run packages/database/import-token-registry.ts --required || status=$?
  if [ "${status}" -eq 0 ]; then
    log "token registry import applied"
    exit 0
  fi
  if [ "${status}" -eq "${nothing_to_import}" ]; then
    log "token registry import skipped: nothing to import for ${TOKEN_REGISTRY_NETWORK} (see the warning above); the database lists only its seeded tokens"
    exit 0
  fi
  if [ "${attempt}" -ge "${ATTEMPTS}" ]; then
    log "token registry import FAILED after ${ATTEMPTS} attempt(s); the database still holds its previous rows"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "${DELAY}"
done
