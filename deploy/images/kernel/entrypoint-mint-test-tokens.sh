#!/usr/bin/env bash
# entrypoint-mint-test-tokens.sh — post-kernel demo-token mint/register one-shot.
#
# The contract-only deploy one-shot publishes the address, the kernel adopts it
# and becomes healthy, then this service mints the three fixed-colour dev tokens
# and lets mint-test-tokens.ts register their names through the live kernel API.
# The minted-colour receipt is published atomically for every downstream wallet
# consumer. Mint failure remains non-fatal, matching the previous inline step.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env ZSWAP_API MIDNIGHT_NETWORK_ID MIDNIGHT_STORAGE_PASSWORD \
            MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP MIDNIGHT_INDEXER_WS \
            MIDNIGHT_PROOF_SERVER_URL

MINT_MARKER="${CONTRACT_SHARE_DIR}/.minted"
MINTED_FILE="${MINTED_TOKENS_FILE:-${CONTRACT_SHARE_DIR}/minted-tokens.json}"
PKG_DIR="${REPO_ROOT}/packages/contracts-midnight"

mkdir -p "${CONTRACT_SHARE_DIR}"

# The receipt is the durable authority. If a crash happened after its atomic
# rename but before the marker rename, repair the marker without minting twice.
if [ -f "${MINTED_FILE}" ]; then
  if [ ! -f "${MINT_MARKER}" ]; then
    TMP_MARKER="${CONTRACT_SHARE_DIR}/.minted.$$"
    printf '%s recovered-from=%s\n' "$(date -u +%FT%TZ)" "${MINTED_FILE}" > "${TMP_MARKER}"
    mv -f "${TMP_MARKER}" "${MINT_MARKER}"
  fi
  log "JOIN: ${MINTED_FILE} already exists — not minting a second tranche"
  exit 0
fi

if [ -f "${MINT_MARKER}" ]; then
  log "WARNING: ${MINT_MARKER} exists but ${MINTED_FILE} does not; retrying mint so downstream consumers receive a receipt"
fi

adopt_contract_address
wait_http "${ZSWAP_API%/}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-300}"

MINT_LOG="$(mktemp)"
cleanup() { rm -f "${MINT_LOG}"; }
trap cleanup EXIT

cd "${PKG_DIR}"
if ! bun run mint-test-tokens.ts 2>&1 | tee "${MINT_LOG}"; then
  log "WARNING: mint-test-tokens failed — continuing (non-fatal, no receipt or marker written)"
  exit 0
fi

MINTED_JSON="$(sed -n 's/^.* MINTED //p' "${MINT_LOG}" | tail -1)"
TMP_MINTED="${CONTRACT_SHARE_DIR}/.minted-tokens.json.$$"
printf '%s\n' "${MINTED_JSON}" > "${TMP_MINTED}"

if ! bun -e '
  const value = await Bun.file(process.argv[1]).json();
  for (const key of ["shieldedA", "shieldedB", "unshielded"]) {
    if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/i.test(value[key])) {
      throw new Error(`MINTED receipt has no 64-hex ${key}`);
    }
  }
' "${TMP_MINTED}"; then
  rm -f "${TMP_MINTED}"
  log "WARNING: mint succeeded but its MINTED receipt was missing or malformed"
  log "WARNING: ${MINTED_FILE} and marker were not written; a retry remains possible"
  exit 0
fi

mv -f "${TMP_MINTED}" "${MINTED_FILE}"
TMP_MARKER="${CONTRACT_SHARE_DIR}/.minted.$$"
printf '%s receipt=%s\n' "$(date -u +%FT%TZ)" "${MINTED_FILE}" > "${TMP_MARKER}"
mv -f "${TMP_MARKER}" "${MINT_MARKER}"
log "mint/register succeeded; published ${MINTED_FILE} and ${MINT_MARKER}"

exit 0
