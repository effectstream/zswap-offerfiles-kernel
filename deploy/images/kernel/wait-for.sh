#!/usr/bin/env bash
# wait-for.sh — minimal readiness waits for the kernel-image entrypoints.
#
# This repository has NO `packages/node/preflight-external.ts` (the sibling v9
# stack does; this lineage does not — verified at D1.1), so the external-stack
# probe lives here instead of being borrowed from the source tree. Keeping it in
# `deploy/` also keeps D1 out of source scope.
#
# Everything is done with `bun -e`: the bun base image ships no curl, and adding
# one only for a probe would grow every service's image for nothing.
set -euo pipefail

_log() { echo "[wait-for] $*" >&2; }

# wait_http <url> <label> [timeout_s] — any HTTP response counts as "listening";
# we are waiting for a socket to answer, not for a particular status.
wait_http() {
  local url="$1" label="$2" timeout="${3:-180}" waited=0
  _log "waiting for ${label} at ${url} (timeout ${timeout}s)"
  until bun -e "
    const r = await fetch(process.argv[1], { signal: AbortSignal.timeout(4000) }).catch(() => null);
    process.exit(r ? 0 : 1);
  " "${url}" >/dev/null 2>&1; do
    waited=$((waited + 2))
    if [ "${waited}" -ge "${timeout}" ]; then
      _log "TIMEOUT after ${timeout}s waiting for ${label} at ${url}"
      return 1
    fi
    sleep 2
  done
  _log "${label} is up"
}

# wait_tcp <host> <port> <label> [timeout_s]
wait_tcp() {
  local host="$1" port="$2" label="$3" timeout="${4:-180}" waited=0
  _log "waiting for ${label} at tcp://${host}:${port} (timeout ${timeout}s)"
  until bun -e "
    const [host, port] = [process.argv[1], Number(process.argv[2])];
    try {
      const socket = await Bun.connect({ hostname: host, port, socket: { data() {} } });
      socket.end();
      process.exit(0);
    } catch { process.exit(1); }
  " "${host}" "${port}" >/dev/null 2>&1; do
    waited=$((waited + 2))
    if [ "${waited}" -ge "${timeout}" ]; then
      _log "TIMEOUT after ${timeout}s waiting for ${label} at tcp://${host}:${port}"
      return 1
    fi
    sleep 2
  done
  _log "${label} is up"
}

# wait_node_block <http-rpc-url> [min-block] [timeout_s]
#
# Compose health alone is not readiness for a Substrate chain: a node answers
# RPC long before it has produced anything. Two consumers need a real block —
# the indexer's bundled spo-indexer reads block #1 on a fresh DB and exits(1) if
# it is missing (the reason `@effectstream/npm-midnight-indexer` gates its own
# start the same way), and no transaction can be built against an empty chain.
wait_node_block() {
  local url="$1" min_block="${2:-1}" timeout="${3:-300}" waited=0
  _log "waiting for midnight-node block #${min_block} at ${url} (timeout ${timeout}s)"
  until bun -e "
    const [url, minBlock] = [process.argv[1], Number(process.argv[2])];
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [minBlock] }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) process.exit(1);
    const json = await res.json().catch(() => null);
    process.exit(json && json.result ? 0 : 1);
  " "${url}" "${min_block}" >/dev/null 2>&1; do
    waited=$((waited + 2))
    if [ "${waited}" -ge "${timeout}" ]; then
      _log "TIMEOUT after ${timeout}s waiting for block #${min_block} at ${url}"
      return 1
    fi
    sleep 2
  done
  _log "midnight-node has block #${min_block}"
}
