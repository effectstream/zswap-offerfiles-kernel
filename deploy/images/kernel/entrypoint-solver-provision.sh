#!/usr/bin/env bash
# Validate externally prefunded solver fee inventory and write an explicit pair.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP \
            MIDNIGHT_INDEXER_WS MIDNIGHT_PROOF_SERVER_URL SOLVER_SEED \
            SOLVER_LADDER_CONFIG

LADDER_DIR="$(dirname "${SOLVER_LADDER_CONFIG}")"
MARKER="${LADDER_DIR}/.provisioned"
IN_REPO_LADDER="${REPO_ROOT}/packages/solver/config/ladders.dev.json"
mkdir -p "${LADDER_DIR}"

if [ "${SOLVER_PROVISION_ENABLED:-false}" != "true" ]; then
  log "SOLVER_PROVISION_ENABLED=${SOLVER_PROVISION_ENABLED:-false} — external prefunding check disabled"
  if [ ! -f "${SOLVER_LADDER_CONFIG}" ]; then
    install -m 0644 "${IN_REPO_LADDER}" "${SOLVER_LADDER_CONFIG}"
    log "installed the in-repo ladder at ${SOLVER_LADDER_CONFIG}"
  fi
  exit 0
fi

require_env SOLVER_PROVISION_TOKEN_IN SOLVER_PROVISION_TOKEN_OUT

wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"

cd "${REPO_ROOT}"
log "checking externally prefunded solver wallet and explicit token IDs"
if bun run deploy/scripts/provision-solver-fees.ts; then
  printf '%s mode=external-prefunded tokenIn=%s tokenOut=%s\n' \
    "$(date -u +%FT%TZ)" "${SOLVER_PROVISION_TOKEN_IN}" "${SOLVER_PROVISION_TOKEN_OUT}" > "${MARKER}"
  log "prefunding verified; marker written to ${MARKER}"
  exit 0
fi

log "ERROR: solver prefunding check failed. Fund SOLVER_SEED with NIGHT through"
log "ERROR: the selected network's supported funding path, then retry. This"
log "ERROR: deployment does not deploy an issuer or mint/transfer swap tokens."
exit 1
