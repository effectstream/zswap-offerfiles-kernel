#!/usr/bin/env bash
# midnight-node entrypoint — dev preset, single process, PID 1.
#
# The flag set is copied verbatim from this repo's own
# `packages/contracts-midnight/package.json` `midnight-node:start` (what
# `bun run dev` runs), so the Compose chain and the dev-stack chain are
# configured identically. Exactly one flag is added:
#
#   --base-path   the dev preset otherwise keeps chain data under a temporary
#                 directory, so nothing would survive a container restart while
#                 the kernel's ledger mirror and the indexer's SQLite did.
#
# `--unsafe-rpc-external` is kept as upstream has it. It is the proven
# configuration for this exact binary, and the exposure is bounded elsewhere:
# the RPC port is published only on 127.0.0.1 of the host (BIND_ADDR) and the
# chain is a throwaway `--dev` devnet with a public genesis seed. Set
# MIDNIGHT_NODE_UNSAFE_RPC=false to fall back to `--rpc-external` (safe method
# namespace) if a deployment ever wants it.
set -euo pipefail

DATA_DIR="${MIDNIGHT_NODE_BASE_PATH:-/data/midnight-node}"
RPC_PORT="${MIDNIGHT_NODE_RPC_PORT:-9944}"
P2P_PORT="${MIDNIGHT_NODE_P2P_PORT:-30333}"

mkdir -p "${DATA_DIR}"

if [ "${MIDNIGHT_NODE_UNSAFE_RPC:-true}" = "true" ]; then
  EXTERNAL_FLAG=--unsafe-rpc-external
else
  EXTERNAL_FLAG=--rpc-external
fi

echo "[midnight-node] data   : ${DATA_DIR}" >&2
echo "[midnight-node] rpc    : 0.0.0.0:${RPC_PORT} (${EXTERNAL_FLAG})" >&2
echo "[midnight-node] preset : ${CFG_PRESET:-dev}" >&2

exec /usr/local/bin/midnight-node \
  --dev \
  --base-path "${DATA_DIR}" \
  --rpc-port "${RPC_PORT}" \
  --port "${P2P_PORT}" \
  --state-pruning archive \
  --blocks-pruning archive \
  --public-addr "/ip4/127.0.0.1" \
  --rpc-cors all \
  "${EXTERNAL_FLAG}" \
  "$@"
