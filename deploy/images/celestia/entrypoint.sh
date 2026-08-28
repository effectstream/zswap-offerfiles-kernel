#!/usr/bin/env bash
# Celestia devnet supervisor: celestia-appd (consensus) + celestia bridge.
#
# Every step below reproduces `@effectstream/celestia@0.103.1`'s `index.js`
# (`initGenesis()` / `run()` / `fund()`), which is what `bun run dev` executes
# through `launchCelestia()`. Constants are that module's, not invented here:
#   CHAIN_ID='test', KEY_NAME='validator', KEYRING_BACKEND='test', FEES='500utia'
#   genesis account 1000000000000000utia, gentx 5000000000utia,
#   voting period patched 604800s -> 30s, RPC laddr patched to 0.0.0.0:26657,
#   indexer "null" -> "kv", discard_abci_responses false,
#   bridge PruningWindow -> "0", bridge started with --rpc.skip-auth,
#   bridge wallet funded with 100000000utia at 2000utia fees.
#
# One deliberate difference: the wrapper's bridge listens on 127.0.0.1 because
# everything shared a host. Here the bridge must be reachable from the kernel
# and batcher containers, so it is started with --rpc.addr 0.0.0.0. The bridge
# still reaches consensus over --core.ip 127.0.0.1 inside this container.
#
# NOTE ON AUTH: the bridge runs with `--rpc.skip-auth`, exactly as the wrapper
# does, so there is NO auth token to hand off and CELESTIA_AUTH_TOKEN stays
# empty everywhere. (The v9 sibling stack's `celestia-auth` shared volume has no
# counterpart here — see deployment brief §6.2.)
set -euo pipefail

CHAIN_ID="${CELESTIA_CHAIN_ID:-test}"
KEY_NAME=validator
KEYRING=test
FEES=500utia
APP_HOME="${CELESTIA_HOME:-/data/celestia-app}"
BRIDGE_HOME="${CELESTIA_BRIDGE_HOME:-/data/celestia-bridge}"
CONSENSUS_RPC_PORT="${CELESTIA_CONSENSUS_RPC_PORT:-26657}"
BRIDGE_RPC_PORT="${CELESTIA_BRIDGE_RPC_PORT:-26658}"
BRIDGE_FUND_AMOUNT="${CELESTIA_BRIDGE_FUND_AMOUNT:-100000000utia}"
BRIDGE_FUND_FEES="${CELESTIA_BRIDGE_FUND_FEES:-2000utia}"

log() { echo "[celestia] $*" >&2; }

APPD_PID=""
BRIDGE_PID=""
shutdown() {
  log "shutting down"
  [ -n "${BRIDGE_PID}" ] && kill "${BRIDGE_PID}" 2>/dev/null || true
  [ -n "${APPD_PID}" ] && kill "${APPD_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap shutdown TERM INT

# ── genesis (once per volume) ────────────────────────────────────────────────
if [ ! -f "${APP_HOME}/config/genesis.json" ]; then
  log "initialising validator + genesis in ${APP_HOME}"
  celestia-appd init "${CHAIN_ID}" --chain-id "${CHAIN_ID}" --home "${APP_HOME}"
  celestia-appd keys add "${KEY_NAME}" --keyring-backend="${KEYRING}" --home "${APP_HOME}"
  VALIDATOR_ADDR="$(celestia-appd keys show "${KEY_NAME}" -a --keyring-backend="${KEYRING}" --home "${APP_HOME}")"
  log "validator address: ${VALIDATOR_ADDR}"
  celestia-appd genesis add-genesis-account "${VALIDATOR_ADDR}" 1000000000000000utia --home "${APP_HOME}"
  celestia-appd genesis gentx "${KEY_NAME}" 5000000000utia \
    --fees "${FEES}" \
    --keyring-backend="${KEYRING}" \
    --chain-id "${CHAIN_ID}" \
    --home "${APP_HOME}" \
    --commission-rate=0.05 \
    --commission-max-rate=1.0 \
    --commission-max-change-rate=1.0
  celestia-appd genesis collect-gentxs --home "${APP_HOME}"

  CONFIG_TOML="${APP_HOME}/config/config.toml"
  # 0.0.0.0 rather than the wrapper's 127.0.0.1: the bridge is in this container
  # but a human debugging the stack reaches consensus RPC through the published
  # host port.
  sed -i 's|"tcp://127.0.0.1:26657"|"tcp://0.0.0.0:26657"|' "${CONFIG_TOML}"
  sed -i 's|"null"|"kv"|' "${CONFIG_TOML}"
  sed -i 's|discard_abci_responses = true|discard_abci_responses = false|' "${CONFIG_TOML}"
  sed -i 's|^log_level = "info"|log_level = "*:error,p2p:info,state:info"|' "${CONFIG_TOML}"
  sed -i 's|^trace_type *=.*|trace_type = "local"|' "${CONFIG_TOML}"
  sed -i 's|^trace_pull_address *=.*|trace_pull_address = ":26661"|' "${CONFIG_TOML}"
  sed -i 's|^trace_push_batch_size *=.*|trace_push_batch_size = "1000"|' "${CONFIG_TOML}"

  # Governance voting period 1 week -> 30 s, so a devnet can actually vote.
  sed -i 's|"604800s"|"30s"|' "${APP_HOME}/config/genesis.json"
  log "genesis initialised"
else
  log "reusing existing genesis in ${APP_HOME}"
fi

# ── consensus node ───────────────────────────────────────────────────────────
log "starting celestia-appd"
celestia-appd start \
  --home "${APP_HOME}" \
  --api.enable \
  --grpc.enable \
  --rpc.unsafe \
  --grpc-web.enable \
  --delayed-precommit-timeout 1s \
  ${CELESTIA_FORCE_NO_BBR:+--force-no-bbr} &
APPD_PID=$!

# ── wait for the genesis block (the bridge is anchored to its hash) ──────────
log "waiting for genesis block on 127.0.0.1:${CONSENSUS_RPC_PORT}"
GENESIS_HASH=""
for _ in $(seq 1 "${CELESTIA_GENESIS_TIMEOUT_S:-180}"); do
  GENESIS_HASH="$(curl -sf "http://127.0.0.1:${CONSENSUS_RPC_PORT}/block?height=1" 2>/dev/null \
    | jq -r '.result.block_id.hash // empty' 2>/dev/null || true)"
  if [ -n "${GENESIS_HASH}" ] && [ "${GENESIS_HASH}" != "null" ]; then break; fi
  if ! kill -0 "${APPD_PID}" 2>/dev/null; then
    log "celestia-appd exited before producing a genesis block"
    exit 1
  fi
  sleep 1
done
if [ -z "${GENESIS_HASH}" ]; then
  log "TIMEOUT waiting for the genesis block"
  exit 1
fi
log "genesis block hash: ${GENESIS_HASH}"

# ── bridge ───────────────────────────────────────────────────────────────────
# Re-inited every start, as the wrapper does: the bridge's identity is derived
# from CELESTIA_CUSTOM=<chain>:<genesis hash>, so a stale home would silently
# bind it to a chain that no longer exists.
export CELESTIA_CUSTOM="${CHAIN_ID}:${GENESIS_HASH}"
export CELESTIA_HOME="${BRIDGE_HOME}"
rm -rf "${BRIDGE_HOME}"
mkdir -p "${BRIDGE_HOME}"

log "initialising bridge node (CELESTIA_CUSTOM=${CELESTIA_CUSTOM})"
celestia bridge init --core.ip 127.0.0.1 --node.store "${BRIDGE_HOME}"

# Bridge nodes must retain everything they sample.
if [ -f "${BRIDGE_HOME}/config.toml" ]; then
  sed -i 's|PruningWindow *=.*|PruningWindow = "0"|' "${BRIDGE_HOME}/config.toml"
fi

# The wrapper sleeps 6 s here before starting the bridge; keep it — the
# consensus node needs a moment past genesis before it will serve the bridge.
sleep "${CELESTIA_BRIDGE_START_DELAY_S:-6}"

log "starting bridge on 0.0.0.0:${BRIDGE_RPC_PORT} (--rpc.skip-auth)"
celestia bridge start \
  --core.ip 127.0.0.1 \
  --node.store "${BRIDGE_HOME}" \
  --rpc.addr 0.0.0.0 \
  --rpc.port "${BRIDGE_RPC_PORT}" \
  --rpc.skip-auth &
BRIDGE_PID=$!

# ── fund the bridge wallet ───────────────────────────────────────────────────
# Replaces `packages/contracts-celestia/fund-bridge.ts` (getBridgeAddress via
# state.AccountAddress, then `celestia-appd tx bank send`). Without it the
# bridge cannot pay for blob submissions and every offer publication fails with
# an insufficient-funds error that surfaces far from here.
log "resolving bridge wallet address"
BRIDGE_ADDR=""
for _ in $(seq 1 "${CELESTIA_BRIDGE_ADDR_TIMEOUT_S:-60}"); do
  BRIDGE_ADDR="$(curl -sf -m 5 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"state.AccountAddress","params":[]}' \
    "http://127.0.0.1:${BRIDGE_RPC_PORT}" 2>/dev/null | jq -r '.result // empty' 2>/dev/null || true)"
  if [ -n "${BRIDGE_ADDR}" ]; then break; fi
  sleep 1
done

if [ -z "${BRIDGE_ADDR}" ]; then
  log "WARNING: could not resolve the bridge wallet address — NOT funded."
  log "Blob submissions will fail until it is funded manually."
else
  log "funding bridge wallet ${BRIDGE_ADDR} with ${BRIDGE_FUND_AMOUNT}"
  if celestia-appd tx bank send "${KEY_NAME}" "${BRIDGE_ADDR}" "${BRIDGE_FUND_AMOUNT}" \
        --fees "${BRIDGE_FUND_FEES}" \
        --chain-id "${CHAIN_ID}" \
        --keyring-backend="${KEYRING}" \
        --yes \
        --home "${APP_HOME}"; then
    log "bridge wallet funded"
    : > /tmp/celestia-bridge-funded
  else
    log "WARNING: funding the bridge wallet failed — blob submissions will fail"
  fi
fi

log "devnet up (consensus :${CONSENSUS_RPC_PORT}, bridge :${BRIDGE_RPC_PORT})"

# Exit as soon as EITHER process dies so Compose restarts the pair together;
# a half-dead celestia is worse than a restarting one.
wait -n "${APPD_PID}" "${BRIDGE_PID}"
STATUS=$?
log "a celestia process exited (status ${STATUS}) — stopping the other"
shutdown
exit "${STATUS}"
