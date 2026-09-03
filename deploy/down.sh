#!/usr/bin/env bash
# down.sh — FULL teardown, and a proof that it was full.
#
# `docker compose down` alone leaves the volumes. That is the wrong default
# here: every volume in this project is CHAIN-KEYED. The kernel's ledger
# mirror, the indexer's SQLite, the batcher's parked inputs and the solver's
# operation journal all describe one specific genesis and one specific deployed
# contract address. Keeping any of them across a chain reset produces a stack
# that starts cleanly and is wrong — offers that cannot be found, nullifiers
# that refer to nothing, a journal recovering operations against a contract that
# no longer exists. So volumes go with the containers, always, as a set.
#
#   ./down.sh                 containers + networks + volumes
#   ./down.sh --keep-images   the same, but leave the built images
#   ./down.sh --images        also remove the images this project built
#
# EVERY optional profile has to be named on the `down` lines below. Compose only
# removes what the selected profiles select, so a profiled service left out here
# survives teardown — its container keeps running and its volume keeps a
# chain-keyed state file that the next stack would silently inherit. Add any new
# profile to BOTH invocations.
set -euo pipefail

cd "$(dirname "$0")"

REMOVE_IMAGES=0
for arg in "$@"; do
  case "${arg}" in
    --images) REMOVE_IMAGES=1 ;;
    --keep-images) REMOVE_IMAGES=0 ;;
    *) echo "unknown flag: ${arg}" >&2; exit 2 ;;
  esac
done

PROJECT="$(grep -E '^COMPOSE_PROJECT_NAME=' .env 2>/dev/null | cut -d= -f2- || true)"
PROJECT="${PROJECT:-cow00005_e2e}"

echo "== tearing down project ${PROJECT} =="
docker compose --profile e2e --profile prices --profile poster down --volumes --remove-orphans --timeout 30 || true

if [ "${REMOVE_IMAGES}" -eq 1 ]; then
  echo "== removing images built by this project =="
  docker compose --profile e2e --profile prices --profile poster down --rmi local --volumes --remove-orphans || true
fi

echo
echo "== teardown proof =="
echo "-- containers (expect none) --"
docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}}\t{{.Status}}'
echo "-- volumes (expect none) --"
docker volume ls --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Name}}'
echo "-- networks (expect none) --"
docker network ls --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Name}}'
echo "-- end --"
