#!/usr/bin/env bash
# entrypoint-solver-frontend.sh — the COW solver's read-only monitor site (00007).
#
# `exec bun run start.solver-frontend.ts`. That root script is the one
# documented way to run the site, and it is a single process so the container's
# PID 1 is the real workload and Compose's SIGTERM reaches it.
#
# IT DOES NOT WAIT FOR THE SOLVER, and that is the entire point of the service.
# Every other entrypoint here waits for what it needs, because a solver that
# starts into a missing kernel is a bug. This one is the opposite: the moment
# anyone opens the monitor is the moment the solver is down, so an unreachable
# solver is a RENDERED STATE ("SOLVER UNREACHABLE", with the time it was last
# seen) and never a reason to refuse to start. A wait here would delete exactly
# the behaviour the service exists for.
#
# It does not call `adopt_contract_address` either. The site never names a
# token colour from the contract — it labels colours from the kernel's own
# `GET /v1/known-tokens` and falls back to short hex — so it has no reason to
# read the deployed identity, and the service does not mount the shared volume
# that holds it. (Calling it here would block for CONTRACT_WAIT_TIMEOUT_S and
# then fail, which is a fifteen-minute way of saying "wrong dependency".)
#
# THIS SCRIPT MUST NOT VALIDATE THE SITE'S OWN CONFIGURATION — the same rule
# entrypoint-solver.sh follows. `packages/solver-frontend/env.ts` resolves every
# boundary (SOLVER_FRONTEND_SOLVER_STATUS_URL, SOLVER_FRONTEND_SOLVER_STATUS_TOKEN,
# SOLVER_FRONTEND_ZSWAP_API, and the optional host/port/relay/poll/history knobs)
# in one side-effect-free pass and exits 1 listing EVERY problem at once, before
# anything binds. That is the deployment's fail-fast negative control in
# gates.sh; a pre-check here would shadow it and the gate would then be proving
# that this shell script works, which is worth nothing.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

cd "${REPO_ROOT}"
log "starting solver-frontend (start.solver-frontend.ts) — the banner follows"
exec bun run start.solver-frontend.ts
