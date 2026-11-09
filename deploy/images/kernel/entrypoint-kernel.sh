#!/usr/bin/env bash
# entrypoint-kernel.sh — the Offer Files kernel (sync node + :9999 REST/SSE API).
#
# `exec bun run <entry>` — a single process, PID 1, so Compose's SIGTERM
# reaches the real workload. It is NOT `bun run dev` — that is the
# orchestrator, which would kill the chain services on 9944/8088/6300.
#
# The entry is selected from MIDNIGHT_NETWORK_ID:
#
#   undeployed               packages/node/main.dev.ts     local devnet — exactly as before
#   preview|preprod|mainnet  packages/node/main.public.ts  after a network-free config
#                                                          preflight (public-network-profile.ts)
#                                                          that exits 78 naming every problem
#
# Any other value exits 78.
#
# On the public networks the hosted Midnight endpoints (Blockfrost by default)
# and the Celestia RPC are not waited on here: their URLs may carry a token or
# a credential that a wait line would print, the node checks the Blockfrost
# token itself at startup, and the sync retries an unreachable endpoint.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID DB_HOST DB_PORT

case "${MIDNIGHT_NETWORK_ID}" in
  undeployed)
    require_env MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP MIDNIGHT_INDEXER_WS \
                MIDNIGHT_PROOF_SERVER_URL CELESTIA_RPC_URL
    KERNEL_ENTRY="packages/node/main.dev.ts"
    ;;
  preview|preprod|mainnet) KERNEL_ENTRY="packages/node/main.public.ts" ;;
  *)
    log "no kernel entry for MIDNIGHT_NETWORK_ID='${MIDNIGHT_NETWORK_ID}' (supported: undeployed, preview, preprod, mainnet)"
    exit 78 # EX_CONFIG
    ;;
esac

if [ "${MIDNIGHT_NETWORK_ID}" != "undeployed" ]; then
  log "selected ${KERNEL_ENTRY} for network ${MIDNIGHT_NETWORK_ID}"
  # Fail on configuration BEFORE the readiness waits, not ten minutes into
  # them: validates the network contract and prints the resolved constants.
  (cd "${REPO_ROOT}" && bun run packages/node/public-network-profile.ts) || exit $?
fi

wait_tcp "${DB_HOST}" "${DB_PORT}" "pglite" "${DB_WAIT_TIMEOUT_S:-300}"
if [ "${MIDNIGHT_NETWORK_ID}" = "undeployed" ]; then
  wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
  wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
  wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
  wait_http "${CELESTIA_RPC_URL}" "celestia bridge" "${CELESTIA_WAIT_TIMEOUT_S:-600}"
fi

cd "${REPO_ROOT}"
log "starting kernel on :${EFFECTSTREAM_API_PORT:-9999} (network ${MIDNIGHT_NETWORK_ID})"
exec bun run "${KERNEL_ENTRY}"
