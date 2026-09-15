#!/usr/bin/env bash
# Validate externally prefunded solver fee inventory and write a receipt.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP \
            MIDNIGHT_INDEXER_WS MIDNIGHT_PROOF_SERVER_URL SOLVER_SEED \
            SOLVER_PROVISION_RECEIPT

PROVISION_DIR="$(dirname "${SOLVER_PROVISION_RECEIPT}")"
MARKER="${PROVISION_DIR}/.provisioned"
mkdir -p "${PROVISION_DIR}"

if [ "${SOLVER_PROVISION_ENABLED:-false}" != "true" ]; then
  log "SOLVER_PROVISION_ENABLED=${SOLVER_PROVISION_ENABLED:-false} — external prefunding check disabled"
  exit 0
fi

wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"

cd "${REPO_ROOT}"
log "checking externally prefunded solver NIGHT/DUST"
if bun run deploy/scripts/provision-solver-fees.ts; then
  printf '%s mode=external-prefunded pricing=live-offer-files-book\n' \
    "$(date -u +%FT%TZ)" > "${MARKER}"
  log "prefunding verified; marker written to ${MARKER}"
  exit 0
fi

log "ERROR: solver prefunding check failed. Fund SOLVER_SEED with NIGHT through"
log "ERROR: the selected network's supported funding path, then retry. This"
log "ERROR: deployment does not deploy an issuer or mint/transfer swap tokens."
exit 1
