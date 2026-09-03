#!/usr/bin/env bash
# entrypoint-batcher.sh — the balancing batcher (Midnight + Celestia, :3334).
#
# `exec bun run packages/batcher/batcher.dev.ts`, single process, PID 1.
# `batcher.dev.ts` itself throws unless MIDNIGHT_NETWORK_ID=undeployed, so the
# variable is required here rather than defaulted — a container that reached
# the throw would restart-loop with a message buried in the middle of the log.
#
# BATCHER_STORAGE_DIR is the SDK's FileStorage root (in-flight batches and
# their retry state). It is on a volume for the same reason the journal is: an
# input parked mid-retry that vanishes on restart is an unexplained gap.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP \
            MIDNIGHT_INDEXER_WS MIDNIGHT_PROOF_SERVER_URL \
            CELESTIA_RPC_URL BATCHER_STORAGE_DIR

if [ "${MIDNIGHT_NETWORK_ID}" != "undeployed" ]; then
  echo "[batcher] batcher.dev.ts requires MIDNIGHT_NETWORK_ID=undeployed, got '${MIDNIGHT_NETWORK_ID}'" >&2
  exit 78
fi

mkdir -p "${BATCHER_STORAGE_DIR}"

adopt_contract_address

wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
wait_http "${CELESTIA_RPC_URL}" "celestia bridge" "${CELESTIA_WAIT_TIMEOUT_S:-600}"

cd "${REPO_ROOT}"
log "starting batcher on :${BATCHER_PORT:-3334} (storage ${BATCHER_STORAGE_DIR})"
exec bun run packages/batcher/batcher.dev.ts
