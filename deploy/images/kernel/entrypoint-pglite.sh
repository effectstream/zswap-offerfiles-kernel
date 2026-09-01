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
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env PGLITE_DATA_DIR

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
echo "[pglite] port     : ${DB_PORT:-5432}" >&2
echo "[pglite] server   : ${START_PGLITE}" >&2

exec bun run "${START_PGLITE}" --port "${DB_PORT:-5432}"
