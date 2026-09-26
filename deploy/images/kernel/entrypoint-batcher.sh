#!/usr/bin/env bash
# entrypoint-batcher.sh — the balancing batcher (Midnight + Celestia, :3334).
#
# `exec bun run <entry>`, single process, PID 1. The entry is selected from
# MIDNIGHT_NETWORK_ID (00050 FR-004), which is therefore required here rather
# than defaulted — a container that reached a wrong entry's own network check
# would restart-loop with the message buried in the middle of the log:
#
#   undeployed  packages/batcher/batcher.dev.ts       local devnet — exactly as before
#   preview     packages/batcher/batcher.preview.ts   BATCHER_WALLET_SEED required
#                                                     here: the shared loader would
#                                                     otherwise fall back to the
#                                                     public dev seed
#   stagenet    packages/batcher/batcher.stagenet.ts  after its network-free
#                                                     `--check` preflight, which
#                                                     exits 78 naming a missing or
#                                                     public-dev seed, storage,
#                                                     Celestia RPC or auth
#
# Any other value exits 78; `batcher.mainnet.ts` is not selectable (it is keyed
# on Celestia mainnet, not on a Midnight network id).
#
# BATCHER_STORAGE_DIR is the SDK's FileStorage root (in-flight batches and
# their retry state; on stagenet also the DUST-state cache). It is on a volume
# for the same reason the journal is: an input parked mid-retry that vanishes
# on restart is an unexplained gap.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP \
            MIDNIGHT_INDEXER_WS MIDNIGHT_PROOF_SERVER_URL \
            CELESTIA_RPC_URL BATCHER_STORAGE_DIR

case "${MIDNIGHT_NETWORK_ID}" in
  undeployed) BATCHER_ENTRY="packages/batcher/batcher.dev.ts" ;;
  preview)
    require_env BATCHER_WALLET_SEED
    BATCHER_ENTRY="packages/batcher/batcher.preview.ts"
    ;;
  stagenet)   BATCHER_ENTRY="packages/batcher/batcher.stagenet.ts" ;;
  *)
    echo "[batcher] no batcher entry for MIDNIGHT_NETWORK_ID='${MIDNIGHT_NETWORK_ID}' (supported: undeployed, preview, stagenet)" >&2
    exit 78
    ;;
esac

if [ "${MIDNIGHT_NETWORK_ID}" != "undeployed" ]; then
  log "selected ${BATCHER_ENTRY} for network ${MIDNIGHT_NETWORK_ID}"
fi
if [ "${MIDNIGHT_NETWORK_ID}" = "stagenet" ]; then
  # Refuse a bad configuration before the readiness waits.
  (cd "${REPO_ROOT}" && bun run "${BATCHER_ENTRY}" --check) || exit $?
fi

mkdir -p "${BATCHER_STORAGE_DIR}"

wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
wait_http "${CELESTIA_RPC_URL}" "celestia bridge" "${CELESTIA_WAIT_TIMEOUT_S:-600}"

cd "${REPO_ROOT}"
log "starting batcher on :${BATCHER_PORT:-3334} (storage ${BATCHER_STORAGE_DIR})"
exec bun run "${BATCHER_ENTRY}"
