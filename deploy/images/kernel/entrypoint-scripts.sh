#!/usr/bin/env bash
# entrypoint-scripts.sh — the provisioning / E2E driver component.
#
# Its own Compose service (`scripts`, `restart: no`, profile `e2e`) so the
# end-to-end proof runs INSIDE the stack's network, against the same service
# names every other component uses, rather than from the host through published
# ports. Exit 0 means the E2E passed; any other exit is a failure (SC-005).
#
# D1 defines the component and its wiring only. The driver itself —
# `deploy/scripts/e2e.ts`: fund maker/taker/solver wallets, post a maker zswap
# into the kernel, drive the taker's quote + consume through the reference
# relay, and assert settlement — is E1's deliverable. Until then this exits
# non-zero rather than 0, because a driver that "passes" by doing nothing is
# the one failure mode an E2E gate must never have.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env ZSWAP_API MIDNIGHT_NETWORK_ID

adopt_contract_address

wait_http "${ZSWAP_API}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-600}"
if [ -n "${RELAY_HTTP_URL:-}" ]; then
  wait_http "${RELAY_HTTP_URL}/tokens" "relay HTTP" "${RELAY_WAIT_TIMEOUT_S:-300}"
fi

cd "${REPO_ROOT}"

DRIVER="${E2E_DRIVER:-${REPO_ROOT}/deploy/scripts/e2e.ts}"
if [ ! -f "${DRIVER}" ]; then
  log "no E2E driver at ${DRIVER}"
  log "D1 wires this component; the driver is E1's deliverable. Refusing to"
  log "exit 0 — an empty pass is indistinguishable from a real one."
  exit 69 # EX_UNAVAILABLE
fi

log "running E2E driver ${DRIVER}"
exec bun run "${DRIVER}" "$@"
