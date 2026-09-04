#!/usr/bin/env bash
# entrypoint-deploy.sh — the contract-only one-shot that gives the stack its
# identity. Minting runs later, after the kernel API is healthy.
#
# `restart: no`; the kernel waits on `service_completed_successfully`. Two
# properties matter more than anything else here:
#
#   IDEMPOTENCE. If the shared volume already holds an address file, this
#   container JOINS the existing deployment and exits 0 without deploying.
#   Re-deploying would mint a NEW contract identity while the chain volume, the
#   kernel's ledger mirror and any solver journal still refer to the old one.
#
#   ATOMIC PUBLICATION. The address is written to a temp file and moved into
#   place. A reader therefore never sees a half-written file.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_STORAGE_PASSWORD \
            MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP MIDNIGHT_INDEXER_WS \
            MIDNIGHT_PROOF_SERVER_URL

PUBLISHED="${CONTRACT_SHARE_DIR}/${CONTRACT_FILE_NAME}"
PKG_DIR="${REPO_ROOT}/packages/contracts-midnight"

mkdir -p "${CONTRACT_SHARE_DIR}"

if [ -f "${PUBLISHED}" ]; then
  log "JOIN: ${PUBLISHED} already exists — not deploying a second contract"
  log "$(cat "${PUBLISHED}")"
  exit 0
fi

# The deploy proves and submits a real transaction, so all three chain services
# must be up AND the chain must have produced a block.
wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"

log "deploying contract-offer-files to ${MIDNIGHT_NETWORK_ID}"
cd "${PKG_DIR}"
bun run midnight-contract:deploy

LOCAL_FILE="${PKG_DIR}/${CONTRACT_FILE_NAME}"
if [ ! -f "${LOCAL_FILE}" ]; then
  log "deploy reported success but ${LOCAL_FILE} was not written"
  exit 1
fi

TMP="${CONTRACT_SHARE_DIR}/.${CONTRACT_FILE_NAME}.$$"
cp "${LOCAL_FILE}" "${TMP}"
mv -f "${TMP}" "${PUBLISHED}"
log "published ${PUBLISHED}: $(cat "${PUBLISHED}")"

exit 0
