#!/usr/bin/env bash
# entrypoint-batcher.sh — the balancing batcher (Midnight + Celestia, :3334).
#
# `exec bun run <entry>`, single process, PID 1. The entry is selected from
# MIDNIGHT_NETWORK_ID, which is therefore required here rather than defaulted
# — a container that reached a wrong entry's own network check would
# restart-loop with the message buried in the middle of the log:
#
#   undeployed               packages/batcher/batcher.dev.ts     local devnet — exactly as before
#   preview|preprod|mainnet  packages/batcher/batcher.public.ts  after its network-free `--check`
#                                                                preflight, which exits 78 naming a
#                                                                missing or public-dev seed, storage,
#                                                                Celestia RPC or auth, a missing
#                                                                Blockfrost token or a retired
#                                                                endpoint host
#
# Any other value exits 78.
#
# On the public networks only the proof server (run by the operator, no token
# in its URL) is waited on: the hosted Midnight endpoints and the Celestia RPC
# may carry a token or a credential that a wait line would print, the batcher
# checks the Blockfrost token itself at startup, and its clients retry.
#
# BATCHER_STORAGE_DIR is the SDK's FileStorage root (in-flight batches and
# their retry state; on the public networks also the DUST-state cache). It is
# on a volume for the same reason the journal is: an input parked mid-retry
# that vanishes on restart is an unexplained gap.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID BATCHER_STORAGE_DIR

case "${MIDNIGHT_NETWORK_ID}" in
  undeployed)
    require_env MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP MIDNIGHT_INDEXER_WS \
                MIDNIGHT_PROOF_SERVER_URL CELESTIA_RPC_URL
    BATCHER_ENTRY="packages/batcher/batcher.dev.ts"
    ;;
  preview|preprod|mainnet)
    require_env MIDNIGHT_PROOF_SERVER_URL
    BATCHER_ENTRY="packages/batcher/batcher.public.ts"
    ;;
  *)
    echo "[batcher] no batcher entry for MIDNIGHT_NETWORK_ID='${MIDNIGHT_NETWORK_ID}' (supported: undeployed, preview, preprod, mainnet)" >&2
    exit 78
    ;;
esac

if [ "${MIDNIGHT_NETWORK_ID}" != "undeployed" ]; then
  log "selected ${BATCHER_ENTRY} for network ${MIDNIGHT_NETWORK_ID}"
  # Refuse a bad configuration before the readiness waits.
  (cd "${REPO_ROOT}" && bun run "${BATCHER_ENTRY}" --check) || exit $?
fi

mkdir -p "${BATCHER_STORAGE_DIR}"

if [ "${MIDNIGHT_NETWORK_ID}" = "undeployed" ]; then
  wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
  wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
fi
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
if [ "${MIDNIGHT_NETWORK_ID}" = "undeployed" ]; then
  wait_http "${CELESTIA_RPC_URL}" "celestia bridge" "${CELESTIA_WAIT_TIMEOUT_S:-600}"
fi

cd "${REPO_ROOT}"
log "starting batcher on :${BATCHER_PORT:-3334} (storage ${BATCHER_STORAGE_DIR})"
exec bun run "${BATCHER_ENTRY}"
