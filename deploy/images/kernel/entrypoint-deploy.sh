#!/usr/bin/env bash
# entrypoint-deploy.sh — the ONE-SHOT that gives the stack its contract identity.
#
# `restart: no`; every other offer-files service waits on
# `service_completed_successfully`. Two properties matter more than anything
# else here:
#
#   IDEMPOTENCE. If the shared volume already holds an address file, this
#   container JOINS the existing deployment and exits 0 without deploying.
#   Re-deploying would mint a NEW contract identity while the chain volume, the
#   kernel's ledger mirror and any solver journal still refer to the old one —
#   silent, and only visible much later as offers that cannot be found.
#
#   ATOMIC PUBLICATION. The address is written to a temp file and moved into
#   place, and it is published BEFORE minting. A reader therefore never sees a
#   half-written file, and a mint failure cannot strand a stack that already has
#   a usable contract.
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env MIDNIGHT_NETWORK_ID MIDNIGHT_STORAGE_PASSWORD \
            MIDNIGHT_NODE_HTTP MIDNIGHT_INDEXER_HTTP MIDNIGHT_INDEXER_WS \
            MIDNIGHT_PROOF_SERVER_URL

PUBLISHED="${CONTRACT_SHARE_DIR}/${CONTRACT_FILE_NAME}"
MINT_MARKER="${CONTRACT_SHARE_DIR}/.minted"
PKG_DIR="${REPO_ROOT}/packages/contracts-midnight"

mkdir -p "${CONTRACT_SHARE_DIR}"

if [ -f "${PUBLISHED}" ]; then
  log "JOIN: ${PUBLISHED} already exists — not deploying a second contract"
  log "$(cat "${PUBLISHED}")"
  exit 0
fi

# The deploy proves and submits a real transaction, so all three chain services
# must be up AND the chain must have produced a block.
wait_node_block "${MIDNIGHT_NODE_HTTP}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}"
wait_http "${MIDNIGHT_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}"
wait_http "${MIDNIGHT_INDEXER_HTTP}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}"

log "deploying contract-offer-files to ${MIDNIGHT_NETWORK_ID}"
cd "${PKG_DIR}"
bun run midnight-contract:deploy

LOCAL_FILE="${PKG_DIR}/${CONTRACT_FILE_NAME}"
if [ ! -f "${LOCAL_FILE}" ]; then
  log "deploy reported success but ${LOCAL_FILE} was not written"
  exit 1
fi

TMP="${CONTRACT_SHARE_DIR}/.${CONTRACT_FILE_NAME}.$$"
cp "${LOCAL_FILE}" "${TMP}"
mv -f "${TMP}" "${PUBLISHED}"
log "published ${PUBLISHED}: $(cat "${PUBLISHED}")"

# ── Mint test tokens — NON-FATAL ─────────────────────────────────────────────
# Two shielded colors + one unshielded, to the GENESIS wallet, via the contract's
# mint circuits. Idempotent (fixed domain separators, so a re-run tops the same
# colors up). Deliberately not allowed to fail the one-shot: the stack is
# perfectly usable without demo tokens, and failing here would block the kernel,
# batcher, relay and solver on a convenience step.
#
# NOTE for E1: this funds the GENESIS wallet, not the solver. R2 made ladder
# publication bounded by what the solver itself can spend, so the solver's own
# wallet must hold BOTH tokens of every pair it should quote or it publishes an
# empty ladder while looking perfectly healthy. Moving tokens to SOLVER_SEED is
# E1's provisioning job (deploy/scripts/), not this one-shot's.
if [ -f "${MINT_MARKER}" ]; then
  log "mint marker present — skipping mint-test-tokens"
  exit 0
fi

MINTED_FILE="${CONTRACT_SHARE_DIR}/minted-tokens.json"
MINT_LOG="$(mktemp)"

if bun run mint-test-tokens.ts 2>&1 | tee "${MINT_LOG}"; then
  date -u +%FT%TZ > "${MINT_MARKER}"
  log "mint-test-tokens succeeded; marker written"

  # ── Publish the minted COLORS, not just the fact that minting happened ─────
  # A token's color is derived from the deployed contract address plus a domain
  # separator, so it is different for every fresh stack and cannot be written
  # down anywhere in advance. `mint-test-tokens.ts` only prints it — the one
  # line `[mint-test-tokens] MINTED {"shieldedA":…}` — and returns it to
  # in-process callers. Anything downstream that has to name a token (the maker
  # offer, any funding step, an operator reading the book) would otherwise have
  # to scrape container logs, which stop existing the moment the one-shot is
  # pruned. Publish it next to the contract address instead, atomically and by
  # the same rule: the address file is the stack's identity, and these colors
  # are part of it.
  if MINTED_JSON="$(grep -o '{"shielded.*}' "${MINT_LOG}" | tail -1)" && [ -n "${MINTED_JSON}" ]; then
    TMP_MINTED="${CONTRACT_SHARE_DIR}/.minted-tokens.json.$$"
    printf '%s\n' "${MINTED_JSON}" > "${TMP_MINTED}"
    mv -f "${TMP_MINTED}" "${MINTED_FILE}"
    log "published ${MINTED_FILE}: ${MINTED_JSON}"
  else
    log "WARNING: could not extract the MINTED line; ${MINTED_FILE} not written"
    log "WARNING: downstream provisioning must be given GIVE_TOKEN/WANT_TOKEN explicitly"
  fi
else
  log "WARNING: mint-test-tokens failed — continuing (non-fatal, no marker written)"
fi
rm -f "${MINT_LOG}"

exit 0
