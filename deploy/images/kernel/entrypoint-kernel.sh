#!/usr/bin/env bash
# entrypoint-kernel.sh — the Offer Files kernel (sync node + :9999 REST/SSE API).
#
# `exec bun run <entry>` — a single process, PID 1, so Compose's SIGTERM
# reaches the real workload. It is NOT `bun run dev` — that is the
# orchestrator, which would kill the chain services on 9944/8088/6300.
#
# The entry is selected from MIDNIGHT_NETWORK_ID (00050 FR-004); the file name
# names the target NETWORK, not the maturity of the code:
#
#   undeployed  packages/node/main.dev.ts       local devnet — exactly as before
#   preview     packages/node/main.preview.ts
#   stagenet    packages/node/main.stagenet.ts  after a network-free config
#                                               preflight (stagenet-profile.ts)
#                                               that exits 78 naming every
#                                               missing variable
#
# Any other value exits 78. `main.mainnet.ts` is deliberately not selectable:
# it is keyed on Celestia mainnet with a launch-time NTP anchor, not on a
# Midnight network id (00050 plan, P1 "Mainnet selection").
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP \
            MIDNIGHT_INDEXER_WS MIDNIGHT_PROOF_SERVER_URL \
            CELESTIA_RPC_URL DB_HOST DB_PORT

case "${MIDNIGHT_NETWORK_ID}" in
  undeployed) KERNEL_ENTRY="packages/node/main.dev.ts" ;;
  preview)    KERNEL_ENTRY="packages/node/main.preview.ts" ;;
  stagenet)   KERNEL_ENTRY="packages/node/main.stagenet.ts" ;;
  *)
    log "no kernel entry for MIDNIGHT_NETWORK_ID='${MIDNIGHT_NETWORK_ID}' (supported: undeployed, preview, stagenet)"
    exit 78 # EX_CONFIG
    ;;
esac

if [ "${MIDNIGHT_NETWORK_ID}" != "undeployed" ]; then
  log "selected ${KERNEL_ENTRY} for network ${MIDNIGHT_NETWORK_ID}"
fi
if [ "${MIDNIGHT_NETWORK_ID}" = "stagenet" ]; then
  # Fail on configuration BEFORE the readiness waits, not ten minutes into
  # them: validates the stagenet contract and prints the resolved constants.
  (cd "${REPO_ROOT}" && bun run packages/node/stagenet-profile.ts) || exit $?
fi

wait_tcp "${DB_HOST}" "${DB_PORT}" "pglite" "${DB_WAIT_TIMEOUT_S:-300}"
wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
wait_http "${CELESTIA_RPC_URL}" "celestia bridge" "${CELESTIA_WAIT_TIMEOUT_S:-600}"

cd "${REPO_ROOT}"
log "starting kernel on :${EFFECTSTREAM_API_PORT:-9999} (network ${MIDNIGHT_NETWORK_ID})"
exec bun run "${KERNEL_ENTRY}"
