#!/usr/bin/env bash
# Focused restart-state harness for the real mint one-shot. It runs inside the
# built kernel image and asserts effects/exit status rather than source text.
set -euo pipefail

ENTRYPOINT="/app/deploy/images/kernel/entrypoint-mint-test-tokens.sh"
TEST_ROOT="$(mktemp -d)"
cleanup() { rm -rf "${TEST_ROOT}"; }
trap cleanup EXIT

run_entrypoint() {
  local share="$1"
  local repo="$2"
  env \
    REPO_ROOT="${repo}" \
    CONTRACT_SHARE_DIR="${share}" \
    MINTED_TOKENS_FILE="${share}/minted-tokens.json" \
    CONTRACT_WAIT_TIMEOUT_S="1" \
    KERNEL_WAIT_TIMEOUT_S="1" \
    ZSWAP_API="http://127.0.0.1:1" \
    MIDNIGHT_NETWORK_ID="undeployed" \
    MIDNIGHT_STORAGE_PASSWORD="test" \
    MIDNIGHT_NODE_HTTP="http://midnight-node:9944" \
    MIDNIGHT_INDEXER_HTTP="http://indexer:8088/api/v3/graphql" \
    MIDNIGHT_INDEXER_WS="ws://indexer:8088/api/v3/graphql/ws" \
    MIDNIGHT_PROOF_SERVER_URL="http://proof-server:6300" \
    timeout 10s bash "${ENTRYPOINT}"
}

# Receipt without marker: no contract exists, so exit 0 proves the entrypoint
# did not attempt to mint. It repairs the marker and preserves the receipt.
RECEIPT_SHARE="${TEST_ROOT}/receipt-authoritative/share"
RECEIPT_REPO="${TEST_ROOT}/receipt-authoritative/repo"
mkdir -p "${RECEIPT_SHARE}" "${RECEIPT_REPO}/packages/contracts-midnight"
printf '%s\n' '{"shieldedA":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","shieldedB":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","unshielded":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' \
  > "${RECEIPT_SHARE}/minted-tokens.expected.json"
cp "${RECEIPT_SHARE}/minted-tokens.expected.json" "${RECEIPT_SHARE}/minted-tokens.json"
run_entrypoint "${RECEIPT_SHARE}" "${RECEIPT_REPO}"
cmp "${RECEIPT_SHARE}/minted-tokens.expected.json" "${RECEIPT_SHARE}/minted-tokens.json"
test -f "${RECEIPT_SHARE}/.minted"
test ! -e "${RECEIPT_REPO}/packages/contracts-midnight/contract-offer-files.undeployed.json"

# Marker without receipt: a valid published contract is adopted, then the dead
# API produces the expected bounded failure. Reaching adoption proves the stale
# marker did not suppress the retry path; no fabricated receipt is published.
MARKER_SHARE="${TEST_ROOT}/marker-without-receipt/share"
MARKER_REPO="${TEST_ROOT}/marker-without-receipt/repo"
MARKER_CONTRACT="${MARKER_SHARE}/contract-offer-files.undeployed.json"
ADOPTED_CONTRACT="${MARKER_REPO}/packages/contracts-midnight/contract-offer-files.undeployed.json"
mkdir -p "${MARKER_SHARE}" "${MARKER_REPO}/packages/contracts-midnight"
printf 'stale marker\n' > "${MARKER_SHARE}/.minted"
printf '%s\n' '{"contractAddress":"test-contract-address"}' > "${MARKER_CONTRACT}"
marker_status=0
run_entrypoint "${MARKER_SHARE}" "${MARKER_REPO}" || marker_status=$?
test "${marker_status}" = "1"
cmp "${MARKER_CONTRACT}" "${ADOPTED_CONTRACT}"
test -f "${MARKER_SHARE}/.minted"
test ! -e "${MARKER_SHARE}/minted-tokens.json"

printf 'mint receipt restart-state harness passed\n'
