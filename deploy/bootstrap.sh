#!/usr/bin/env bash
# bootstrap.sh — create deploy/.env from .env.example with fresh secrets.
#
# Idempotent: an existing .env is left alone unless --force is given, because
# regenerating SOLVER_AUTH_TOKEN under a running stack would silently break the
# solver's WS upgrade (the relay would start answering 401) while everything
# still looked healthy.
set -euo pipefail

cd "$(dirname "$0")"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ -f .env ] && [ "${FORCE}" -eq 0 ]; then
  echo "deploy/.env already exists — leaving it alone (pass --force to regenerate)."
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

# 64 hex chars: comfortably over the 32-character minimum BOTH the relay
# (packages/relay/src/config.ts) and the candidate (packages/solver/src/launch.ts)
# enforce on this shared bearer.
SOLVER_AUTH_TOKEN="$(openssl rand -hex 32)"
# The solver's status-listener bearer (00007): same >= 32-character rule, same
# generation. compose.yml feeds it to the solver AND to solver-frontend from
# this one variable, so the two sides cannot drift.
SOLVER_STATUS_AUTH_TOKEN="$(openssl rand -hex 32)"
# The indexer wants uppercase hex for APP__INFRA__SECRET.
INDEXER_SECRET="$(openssl rand -hex 32 | tr 'a-f' 'A-F')"

cp .env.example .env
# Portable in-place edit: BSD and GNU sed disagree about `-i`.
tmp="$(mktemp)"
sed -e "s|^SOLVER_AUTH_TOKEN=.*|SOLVER_AUTH_TOKEN=${SOLVER_AUTH_TOKEN}|" \
    -e "s|^SOLVER_STATUS_AUTH_TOKEN=.*|SOLVER_STATUS_AUTH_TOKEN=${SOLVER_STATUS_AUTH_TOKEN}|" \
    -e "s|^INDEXER_SECRET=.*|INDEXER_SECRET=${INDEXER_SECRET}|" \
    .env > "${tmp}"
mv "${tmp}" .env
chmod 600 .env

echo "Wrote deploy/.env (gitignored) with generated SOLVER_AUTH_TOKEN, SOLVER_STATUS_AUTH_TOKEN and INDEXER_SECRET."
echo "Review the host ports before starting — this is a shared machine:"
grep -E '^(COMPOSE_PROJECT_NAME|BIND_ADDR|HOST_)' .env
