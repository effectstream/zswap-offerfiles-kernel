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

# ── cwd is load-bearing ──────────────────────────────────────────────────────
# The node resolves its configuration as `current_dir()/res/cfg/` (the release
# zip's own `res/src/lib.rs`: CFG_ROOT is only ever set programmatically, so the
# fallback is the process working directory). Launched from anywhere else it
# panics before opening a socket:
#   failed reading default.toml at path /res/cfg/default.toml
# `@effectstream/npm-midnight-node` hides this by spawning the binary with `cwd`
# set to its extracted directory; nothing in the flag set hints at it. We do the
# same, and check rather than assume.
RES_HOME="${MIDNIGHT_NODE_RES_HOME:-/opt/midnight-node}"
if [ ! -f "${RES_HOME}/res/cfg/default.toml" ]; then
  echo "[midnight-node] ${RES_HOME}/res/cfg/default.toml is missing." >&2
  echo "[midnight-node] The binary reads res/cfg/ relative to its working" >&2
  echo "[midnight-node] directory; without that tree it panics at startup." >&2
  exit 78 # EX_CONFIG
fi
cd "${RES_HOME}"

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
echo "[midnight-node] res    : ${RES_HOME}/res (cwd $(pwd))" >&2

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
