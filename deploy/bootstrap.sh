#!/usr/bin/env bash
# bootstrap.sh — create deploy/.env from .env.example with fresh secrets.
#
# Idempotent: an existing .env is left alone unless --force is given, because
# INDEXER_SECRET is the indexer's wallet-encryption secret: regenerating it
# under an existing indexer volume leaves the wallet data it encrypted with the
# old secret unreadable.
set -euo pipefail

cd "$(dirname "$0")"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ -f .env ] && [ "${FORCE}" -eq 0 ]; then
  echo "deploy/.env already exists — leaving it alone (pass --force to regenerate)."
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

# The indexer wants uppercase hex for APP__INFRA__SECRET.
INDEXER_SECRET="$(openssl rand -hex 32 | tr 'a-f' 'A-F')"

cp .env.example .env
# Portable in-place edit: BSD and GNU sed disagree about `-i`.
tmp="$(mktemp)"
sed -e "s|^INDEXER_SECRET=.*|INDEXER_SECRET=${INDEXER_SECRET}|" \
    .env > "${tmp}"
mv "${tmp}" .env
chmod 600 .env

echo "Wrote deploy/.env (gitignored) with a generated INDEXER_SECRET."
echo "Review the host ports before starting — this is a shared machine:"
grep -E '^(COMPOSE_PROJECT_NAME|BIND_ADDR|HOST_)' .env
