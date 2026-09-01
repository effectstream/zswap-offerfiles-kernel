#!/usr/bin/env bash
# entrypoint-solver.sh — the COW solver as its OWN component (FR-005 / P4-F05).
#
# `exec bun run start.solver.ts`. That root script is the one documented way to
# run the solver; it is deliberately absent from `start:mainnet`, and it is not
# the orchestrator.
#
# THIS SCRIPT MUST NOT VALIDATE THE SOLVER'S OWN CONFIGURATION.
# `packages/solver/src/launch.ts` resolves all seven mandatory boundaries
# (MIDNIGHT_NETWORK_ID, ZSWAP_API, SOLVER_RELAY_WS_URL, SOLVER_RELAY_HTTP_URL,
# SOLVER_RELAY_AUTH_TOKEN, SOLVER_JOURNAL_PATH, SOLVER_SEED) in one
# side-effect-free pass and exits 1 with EVERY problem listed, before any
# wallet, socket or journal is touched. That behaviour is the deployment's
# fail-fast negative control (SC-004). A pre-check here would shadow it: the
# gate would then be proving that this shell script works, which is worth
# nothing. The only variables checked below are the ones this SCRIPT itself
# needs in order to wait for dependencies.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

# Not part of the solver's launch contract — these are the addresses this
# wrapper dials while waiting, and their absence would make the waits silently
# no-op rather than fail.
require_env ZSWAP_API SOLVER_JOURNAL_PATH

# The journal is fail-closed sqlite on a per-instance volume; its directory has
# to exist before `runSolver` opens it. `launch.ts` has already been shown the
# same value and will reject a relative or `:memory:` path itself.
mkdir -p "$(dirname "${SOLVER_JOURNAL_PATH}")"

adopt_contract_address

wait_http "${ZSWAP_API}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-600}"

# The relay does not have to be up: `relay-client` retries the socket. But
# starting into a reachable relay makes the first ladder push immediate, and
# `GET /tokens` is the relay's only unauthenticated route (there is no /health).
if [ -n "${SOLVER_RELAY_HTTP_URL:-}" ]; then
  wait_http "${SOLVER_RELAY_HTTP_URL}/tokens" "relay HTTP" "${RELAY_WAIT_TIMEOUT_S:-300}" || \
    log "WARNING: relay HTTP not reachable yet — the solver's WS client will retry"
fi

cd "${REPO_ROOT}"
log "starting solver (start.solver.ts) — the launch banner follows"
exec bun run start.solver.ts
