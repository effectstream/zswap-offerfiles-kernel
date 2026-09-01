#!/usr/bin/env bash
# indexer-standalone entrypoint.
#
# Two things the raw binary needs that its npm wrapper normally does for it:
#
# 1. A STARTUP GATE ON BLOCK #1. v4.3.3 bundles an spo-indexer that, on a fresh
#    database, reads block #1 to anchor the first epoch and `exit(1)`s — taking
#    the whole indexer with it — if that block does not exist yet. That is why
#    `@effectstream/npm-midnight-indexer`'s `waitForNodeBlock()` exists, and the
#    same gate is reproduced here. Without it the indexer crash-loops for as
#    long as the node takes to author its first block.
# 2. The data directory. `config.yaml` puts the SQLite files at `data/…`
#    relative to the working directory, which must be on a volume — an indexer
#    that silently re-syncs from genesis on every restart looks like a hang.
set -euo pipefail

WORKDIR="${INDEXER_WORKDIR:-/var/lib/indexer}"
DATA_DIR="${WORKDIR}/data"
NODE_WS="${APP__INFRA__NODE__URL:-${SUBSTRATE_NODE_WS_URL:-ws://midnight-node:9944}}"
NODE_HTTP="${NODE_WS/#ws:/http:}"
NODE_HTTP="${NODE_HTTP/#wss:/https:}"
MIN_BLOCK="${INDEXER_MIN_BLOCK:-1}"
TIMEOUT_S="${INDEXER_NODE_WAIT_TIMEOUT_S:-600}"

mkdir -p "${DATA_DIR}"
cd "${WORKDIR}"

if [ -z "${APP__INFRA__SECRET:-}" ]; then
  echo "[indexer] APP__INFRA__SECRET is required (32 bytes hex, uppercase)" >&2
  exit 78
fi

echo "[indexer] workdir : ${WORKDIR}" >&2
echo "[indexer] node    : ${NODE_WS}" >&2
echo "[indexer] waiting for block #${MIN_BLOCK} at ${NODE_HTTP} (spo-indexer startup guard)" >&2

waited=0
until curl -sf -m 5 -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"chain_getBlockHash\",\"params\":[${MIN_BLOCK}]}" \
        "${NODE_HTTP}" 2>/dev/null | grep -q '"result":"0x'; do
  waited=$((waited + 2))
  if [ "${waited}" -ge "${TIMEOUT_S}" ]; then
    echo "[indexer] TIMEOUT after ${TIMEOUT_S}s waiting for block #${MIN_BLOCK}" >&2
    exit 1
  fi
  sleep 2
done

echo "[indexer] node has block #${MIN_BLOCK}; starting indexer-standalone" >&2
exec /usr/local/bin/indexer-standalone "$@"
