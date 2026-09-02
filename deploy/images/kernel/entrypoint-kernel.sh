#!/usr/bin/env bash
# entrypoint-kernel.sh — the Offer Files kernel (sync node + :9999 REST/SSE API).
#
# `exec bun run packages/node/main.dev.ts` — a single process, PID 1, so
# Compose's SIGTERM reaches the real workload. The `.dev.ts` variant is the
# correct one for a local devnet: the `dev`/`mainnet` split names the target
# NETWORK, not the maturity of the code, and `main.mainnet.ts` resolves mainnet
# endpoints. It is NOT `bun run dev` — that is the orchestrator, which would
# kill the chain services on 9944/8088/6300 and re-deploy the contract.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP \
            MIDNIGHT_INDEXER_WS MIDNIGHT_PROOF_SERVER_URL \
            CELESTIA_RPC_URL DB_HOST DB_PORT

adopt_contract_address

wait_tcp "${DB_HOST}" "${DB_PORT}" "pglite" "${DB_WAIT_TIMEOUT_S:-300}"
wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
wait_http "${CELESTIA_RPC_URL}" "celestia bridge" "${CELESTIA_WAIT_TIMEOUT_S:-600}"

cd "${REPO_ROOT}"
log "starting kernel on :${EFFECTSTREAM_API_PORT:-9999} (network ${MIDNIGHT_NETWORK_ID})"
exec bun run packages/node/main.dev.ts
