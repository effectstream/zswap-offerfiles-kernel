#!/usr/bin/env bash
# entrypoint-pglite.sh — the kernel's database, as its own Compose service.
#
# Why a service at all: `PGLITE=true` does NOT mean "embedded in the kernel
# process". `@effectstream/orchestrator/scripts/launch-pglite.ts` spawns
# `@effectstream/db/scripts/start-pglite.ts --port 5432`, a pg-gateway TCP
# server wrapping the PGlite WASM backend, and the kernel connects to it over
# the Postgres wire protocol via DB_HOST/DB_PORT. `PGLITE=true` only selects the
# client's single-connection mode. So the dev stack has always had a separate
# database process; here Compose spawns it instead of the orchestrator.
#
# `PGLITE_DATA_DIR` MUST be a path, not the `memory://` default: an in-memory
# database would drop the kernel's whole ledger mirror on restart while the
# chain volumes kept their history, which is the one inconsistency this stack
# must not be able to produce.
#
# Two processes, one container. `start-pglite` binds 127.0.0.1 and has no
# option to bind another address, so other containers could not reach it on
# DB_PORT. The server therefore listens on 127.0.0.1:PGLITE_LOOPBACK_PORT and
# `pglite-forwarder.ts` serves 0.0.0.0:DB_PORT, relaying every connection to
# it. This script supervises both: SIGTERM or SIGINT stops both, and when
# either one exits the other is stopped and the script exits non-zero, so the
# restart policy sees one failed service. Once `start-pglite` can bind a
# non-loopback address, run it on DB_PORT and drop the forwarder.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env PGLITE_DATA_DIR

DB_PORT="${DB_PORT:-5432}"
PGLITE_LOOPBACK_PORT="${PGLITE_LOOPBACK_PORT:-55432}"
for _port_var in DB_PORT PGLITE_LOOPBACK_PORT; do
  if ! [[ "${!_port_var}" =~ ^[1-9][0-9]{0,4}$ ]] || [ "${!_port_var}" -gt 65535 ]; then
    echo "[pglite] ${_port_var} must be a TCP port, got '${!_port_var}'" >&2
    exit 78
  fi
done
unset _port_var
if [ "${PGLITE_LOOPBACK_PORT}" = "${DB_PORT}" ]; then
  echo "[pglite] PGLITE_LOOPBACK_PORT must differ from DB_PORT (both ${DB_PORT})" >&2
  exit 78
fi

if [ "${PGLITE_DATA_DIR}" = "memory://" ]; then
  echo "[pglite] refusing PGLITE_DATA_DIR=memory:// — the kernel's state must" >&2
  echo "[pglite] outlive a container restart; point it at the pglite-data volume." >&2
  exit 78
fi

mkdir -p "${PGLITE_DATA_DIR}"

# Resolved through bun rather than hard-coded: `@effectstream/db` lives under
# node_modules/.bun behind a content hash, and the store holds TWO copies of it
# at different hashes — so a literal path would be a coin flip.
#
# The `--cwd` matters. `@effectstream/db` is NOT a dependency of the workspace
# root, so resolving from /app fails ("Cannot find module"). It IS a direct
# dependency of `@zswap-da/database`, the workspace package that owns the
# database, so the resolve is done from there. This mirrors what
# `@effectstream/orchestrator/scripts/launch-pglite.ts` does — it resolves the
# same specifier from inside its own package, which likewise depends on it.
START_PGLITE="$(bun --cwd "${REPO_ROOT}/packages/database" \
  -e 'process.stdout.write(import.meta.resolve("@effectstream/db/start-pglite").replace("file://", ""))')"

if [ -z "${START_PGLITE}" ] || [ ! -f "${START_PGLITE}" ]; then
  echo "[pglite] could not resolve @effectstream/db/start-pglite (got '${START_PGLITE}')" >&2
  exit 70 # EX_SOFTWARE
fi

echo "[pglite] data dir : ${PGLITE_DATA_DIR}" >&2
echo "[pglite] port     : ${DB_PORT} (forwarded to 127.0.0.1:${PGLITE_LOOPBACK_PORT})" >&2
echo "[pglite] server   : ${START_PGLITE}" >&2

server_pid=""
forwarder_pid=""

# Stops whichever children still run: SIGTERM, up to 5 s to exit, then SIGKILL.
stop_children() {
  local pid alive tries=0
  for pid in "${forwarder_pid}" "${server_pid}"; do
    if [ -n "${pid}" ]; then kill -TERM "${pid}" 2>/dev/null || true; fi
  done
  while [ "${tries}" -lt 50 ]; do
    alive=0
    for pid in "${forwarder_pid}" "${server_pid}"; do
      if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then alive=1; fi
    done
    if [ "${alive}" -eq 0 ]; then break; fi
    sleep 0.1
    tries=$((tries + 1))
  done
  for pid in "${forwarder_pid}" "${server_pid}"; do
    if [ -n "${pid}" ]; then kill -KILL "${pid}" 2>/dev/null || true; fi
  done
  wait || true
}

on_signal() { # <signal> <exit status>
  trap - TERM INT
  echo "[pglite] ${1}: stopping the server and the forwarder" >&2
  stop_children
  exit "${2}"
}
trap 'on_signal SIGTERM 143' TERM
trap 'on_signal SIGINT 130' INT

bun run "${START_PGLITE}" --port "${PGLITE_LOOPBACK_PORT}" &
server_pid=$!
echo "[pglite] server pid ${server_pid} on 127.0.0.1:${PGLITE_LOOPBACK_PORT}" >&2

# The forwarder starts only once the server listens: a connection it accepted
# earlier would be closed at once, and a bare TCP accept is what the kernel's
# wait_tcp counts as "the database is up".
start_timeout_s="${PGLITE_START_TIMEOUT_S:-120}"
waited_ds=0
until (exec 3<>"/dev/tcp/127.0.0.1/${PGLITE_LOOPBACK_PORT}") 2>/dev/null; do
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    status=0
    wait "${server_pid}" || status=$?
    echo "[pglite] the server exited (status ${status}) before it listened" >&2
    exit $(( status == 0 ? 70 : status ))
  fi
  if [ "${waited_ds}" -ge $(( start_timeout_s * 10 )) ]; then
    echo "[pglite] the server did not listen on 127.0.0.1:${PGLITE_LOOPBACK_PORT} within ${start_timeout_s}s" >&2
    stop_children
    exit 70 # EX_SOFTWARE
  fi
  sleep 0.2
  waited_ds=$((waited_ds + 2))
done

bun run /usr/local/bin/pglite-forwarder.ts "${DB_PORT}" "${PGLITE_LOOPBACK_PORT}" &
forwarder_pid=$!
echo "[pglite] forwarder pid ${forwarder_pid} on 0.0.0.0:${DB_PORT}" >&2

# Watch both children. The sleep runs in the background so that a trapped
# signal interrupts `wait` at once (its trap then exits the script).
while kill -0 "${server_pid}" 2>/dev/null && kill -0 "${forwarder_pid}" 2>/dev/null; do
  sleep 0.5 &
  wait "$!" || true
done
if kill -0 "${server_pid}" 2>/dev/null; then
  gone="forwarder"; gone_pid="${forwarder_pid}"
else
  gone="server"; gone_pid="${server_pid}"
fi
status=0
wait "${gone_pid}" || status=$?
echo "[pglite] the ${gone} exited (status ${status}); stopping the other process" >&2
stop_children
exit $(( status == 0 ? 70 : status ))
