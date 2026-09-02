#!/usr/bin/env bash
# entrypoint-solver-provision.sh — give the solver something to trade with.
#
# WHY THIS IS A SERVICE AND NOT A README STEP
# -------------------------------------------
# Since R2 (`c4ac2bb`), ladder publication is bounded by what the solver can
# actually move: a rung whose cumulative INPUT exceeds spendable tokenIn was
# withheld along with every rung above it, and a rung whose worst-case residual
# exceeds available tokenOut is withheld too. So a solver with an empty wallet
# published NOTHING, however deep the maker book behind it was.
#
# The failure that produces is silent and expensive. D2 reproduced it exactly:
# every service healthy, the solver connected and authenticated to the relay,
# `pushed 0 pair(s)` forever, and the relay reporting connectedCount:1 with an
# empty token list. Nothing is logged as an error anywhere. Leaving that to a
# documented manual step would mean the default `docker compose up` produces a
# stack that looks perfect and quotes nothing.
#
# 00006-R2 REMOVED THE tokenIn HALF of that bound: fee sizing no longer spends
# the job's amountIn, so a solver holding no tokenIn now publishes every
# whole-maker rung. Minting the solver its tokenIn is therefore no longer needed
# for the stack to quote — only tokenOut still extends a ladder past its first
# rung, and only for interpolated sizes.
#
# WHAT IT RUNS — TWO MODES (00006-V1)
# -----------------------------------
# SOLVER_PROVISION_MINT_TOKENS=true (DEFAULT — the funded control):
#   `packages/solver/scripts/bootstrap-dev.ts`, the repository's OWN solver
#   provisioner. It funds the solver's NIGHT from genesis, registers NIGHT for
#   dust, MINTS the solver TESTA *and* TESTB using the SAME fixed domain
#   separators as `mint-test-tokens.ts` (so the colors are identical to the ones
#   the genesis wallet holds and the maker offer names), and writes those colors
#   into the ladder config. Unchanged, deliberately: it is the control the
#   unfunded rerun is compared against.
#
# SOLVER_PROVISION_MINT_TOKENS=false (00006 SC-004 — the capital-free solver):
#   `deploy/scripts/provision-solver-fees.ts`. Same NIGHT funding, same dust
#   registration, same ladder config — and NO MINT OF ANY TOKEN. It reads the
#   colors out of the deploy one-shot's `minted-tokens.json` instead of deriving
#   them by minting, and writes a receipt of the solver wallet's measured
#   balances that the E2E driver asserts on.
#
# These two are NOT the same as SOLVER_PROVISION_ENABLED=false, which skips fee
# currency as well and leaves a solver that cannot pay for anything.
#
# ORDERING IS LOAD-BEARING: it drives a wallet on SOLVER_SEED, so the solver
# must not be running. Compose enforces that — `solver` waits on this service's
# `service_completed_successfully`.
#
# DEVNET ONLY. This mints inventory to a public dev seed on a throwaway chain.
# A real deployment funds its solver out of band; set SOLVER_PROVISION_ENABLED=
# false and the ladder config falls back to the in-repo default.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP \
            MIDNIGHT_INDEXER_WS MIDNIGHT_PROOF_SERVER_URL SOLVER_SEED \
            SOLVER_LADDER_CONFIG

LADDER_DIR="$(dirname "${SOLVER_LADDER_CONFIG}")"
MARKER="${LADDER_DIR}/.provisioned"
IN_REPO_LADDER="${REPO_ROOT}/packages/solver/config/ladders.dev.json"

mkdir -p "${LADDER_DIR}"

# The solver reads SOLVER_LADDER_CONFIG unconditionally, so this script must
# leave a readable file behind on EVERY path it can exit through — including
# the disabled and already-provisioned ones. A missing file here would surface
# as a solver crash loop whose cause is three services away.
fallback_ladder() {
  if [ ! -f "${SOLVER_LADDER_CONFIG}" ]; then
    install -m 0644 "${IN_REPO_LADDER}" "${SOLVER_LADDER_CONFIG}"
    log "installed the in-repo dev ladder at ${SOLVER_LADDER_CONFIG}"
    log "NOTE: its token colors are from an older deployment and will not match"
    log "NOTE: this stack's freshly deployed contract."
  fi
}

if [ "${SOLVER_PROVISION_ENABLED:-true}" != "true" ]; then
  log "SOLVER_PROVISION_ENABLED=${SOLVER_PROVISION_ENABLED:-} — skipping solver provisioning"
  fallback_ladder
  exit 0
fi

# Idempotent, for the same reason the contract deploy is: re-running would mint
# a second tranche of inventory and re-fund NIGHT on every restart, turning a
# `docker compose restart` into several minutes of proving.
if [ -f "${MARKER}" ] && [ -f "${SOLVER_LADDER_CONFIG}" ]; then
  log "JOIN: ${MARKER} exists — solver already provisioned, not minting again"
  log "$(cat "${MARKER}")"
  exit 0
fi

wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"

adopt_contract_address

cd "${REPO_ROOT}"

if [ "${SOLVER_PROVISION_MINT_TOKENS:-true}" = "true" ]; then
  PROVISIONER="packages/solver/scripts/bootstrap-dev.ts"
  log "MODE: funded — ${PROVISIONER} mints BOTH sides of the pair"
else
  PROVISIONER="deploy/scripts/provision-solver-fees.ts"
  log "MODE: FEE CURRENCY ONLY (00006 SC-004) — ${PROVISIONER} mints NOTHING"
  log "the solver will hold NIGHT/DUST and zero of every swap token"
fi

if bun run "${PROVISIONER}"; then
  printf '%s mode=%s provisioner=%s\n' \
    "$(date -u +%FT%TZ)" \
    "$([ "${SOLVER_PROVISION_MINT_TOKENS:-true}" = "true" ] && echo funded || echo fee-currency-only)" \
    "${PROVISIONER}" > "${MARKER}"
  log "solver provisioned; marker written to ${MARKER}"
  exit 0
fi

# Fail loudly. This is NOT the deploy one-shot's non-fatal mint: a solver that
# cannot pay DUST settles nothing, and in the funded mode a solver without
# inventory used to come up healthy and quote nothing — the one outcome this
# service exists to prevent.
log "ERROR: ${PROVISIONER} failed — the solver would not be able to settle."
log "ERROR: refusing to report success; see the log above for the cause."
exit 1
