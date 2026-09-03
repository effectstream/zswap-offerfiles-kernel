#!/usr/bin/env bash
# entrypoint-common.sh — sourced by every kernel-image entrypoint.
#
# Two jobs:
#   1. Publish the deployed contract identity to the process that is about to
#      start, from the shared `offerfiles-deploy` volume.
#   2. Provide the shared readiness waits (see wait-for.sh).
#
# It deliberately does NOT set endpoint defaults. `@effectstream/midnight-contracts`
# already defaults an unset `MIDNIGHT_NETWORK_ID` to `undeployed` with
# 127.0.0.1 endpoints, which inside a container silently means "nothing" — so
# Compose states every endpoint explicitly and a missing one must surface as the
# real failure it is, not be papered over here.
set -euo pipefail

# shellcheck source=/usr/local/bin/wait-for.sh
. /usr/local/bin/wait-for.sh

# ── "" is not "unset" ────────────────────────────────────────────────────────
# Compose cannot express "leave this variable out": `FOO: ${FOO}` with FOO unset
# in .env renders as FOO="", and the container sees a variable that is PRESENT
# and empty. That matters because this codebase reads optional knobs with
# `getEnv(x) ?? default` and `ENV.getString(x, default)`, both of which treat ""
# as a real value (`getEnv` is a bare `process.env[key]`). So an operator who
# simply left a knob blank in .env would silently override a sound default with
# an empty string — an EMPTY Celestia namespace (publisher and reader silently
# stop agreeing, blobs are written and never read), an EMPTY ladder path, an
# empty policy document.
#
# Only genuinely optional knobs are listed. Nothing here is part of a launch
# contract: the solver's seven mandatory variables are deliberately absent, so
# an empty one still reaches `start.solver.ts` and is reported as missing —
# which is the deployment's fail-fast negative control and must not be softened.
# The four names added by 00006-V1 are the STRICTER kind of optional: their
# parsers reject "" outright rather than treating it as unset, so leaving one
# blank in .env would be a startup failure rather than a silent default.
#   * SOLVER_FEE_SIZING_TAKER_INPUTS  — `parseBoundedIntegerEnv` reads "" as a
#     parse failure (measured, not assumed), so it is a LISTED start:solver
#     launch problem. It must be unset here for the blank-means-default rule
#     above to hold for it too.
#   * SOLVER_DUST_MAX_PER_JOB / _PER_WINDOW / SOLVER_DUST_WINDOW_MS — read as a
#     GROUP: `packages/solver/env.ts` requires all three set or all three unset,
#     and `parsePositiveBigint` rejects "". Three empty strings therefore count
#     as "all set" and fail. Unsetting them here is what makes DUST admission
#     genuinely optional in the deployment.
#   * PRICE_FEED_MAP — `parsePriceMapEnv` throws on a malformed entry; "" is
#     not malformed, but listing it here keeps "unset" and "blank" identical
#     for the one variable an operator is most likely to leave empty.
#   * COINGECKO_BASE_URL / PRICE_FEED_* — `ENV.getString(x, default)` would
#     take "" as the value, and an empty base URL turns every request into a
#     relative path against nothing. COINGECKO_API_KEY is in the list for a
#     different reason: "" and unset must both mean "no key", so the service
#     idles (loop) or exits 64 (--once) rather than sending an empty header
#     and reading CoinGecko's 401 as an outage.
for _optional_env in \
  CELESTIA_NAMESPACE \
  CELESTIA_AUTH_TOKEN \
  API_RATE_LIMIT_ALLOWLIST \
  SOLVER_LADDER_CONFIG \
  SOLVER_SUPPORTED_PAIRS \
  SOLVER_MIN_JOB_OUTPUT \
  SOLVER_FEE_SIZING_TAKER_INPUTS \
  SOLVER_DUST_MAX_PER_JOB \
  SOLVER_DUST_MAX_PER_WINDOW \
  SOLVER_DUST_WINDOW_MS \
  COINGECKO_API_KEY \
  COINGECKO_BASE_URL \
  PRICE_FEED_INTERVAL_MS \
  PRICE_FEED_REQUEST_SPACING_MS \
  PRICE_FEED_BATCH_SIZE \
  PRICE_FEED_ASSETS \
  PRICE_FEED_MAP
do
  if [ -z "${!_optional_env:-}" ]; then unset "${_optional_env}"; fi
done
unset _optional_env

REPO_ROOT="${REPO_ROOT:-/app}"
CONTRACT_SHARE_DIR="${CONTRACT_SHARE_DIR:-/srv/offerfiles-deploy}"
MIDNIGHT_NETWORK_ID_EFFECTIVE="${MIDNIGHT_NETWORK_ID:-undeployed}"
CONTRACT_FILE_NAME="contract-offer-files.${MIDNIGHT_NETWORK_ID_EFFECTIVE}.json"
CONTRACT_TARGET_DIR="${REPO_ROOT}/packages/contracts-midnight"

log() { echo "[$(basename "${0}")] $*" >&2; }

# Wait for, then adopt, the contract identity the deploy one-shot published.
#
# BOTH halves are needed and neither is redundant:
#   - the JSON file, because `readMidnightContract()` (packages/node/env.ts)
#     resolves the address by reading exactly
#     `packages/contracts-midnight/contract-offer-files.<network>.json`;
#   - `MIDNIGHT_CONTRACT_ADDRESS`, because the same function lets that variable
#     override the file, and because scripts that never call it still get the
#     address.
# Copied, not symlinked: the file is on a read-mostly shared volume and the
# reader resolves paths relative to the package directory.
adopt_contract_address() {
  local src="${CONTRACT_SHARE_DIR}/${CONTRACT_FILE_NAME}"
  local waited=0
  local timeout="${CONTRACT_WAIT_TIMEOUT_S:-900}"

  while [ ! -f "${src}" ]; do
    waited=$((waited + 2))
    if [ "${waited}" -ge "${timeout}" ]; then
      log "TIMEOUT after ${timeout}s waiting for ${src}"
      log "the offerfiles-deploy one-shot has not published a contract address"
      return 1
    fi
    sleep 2
  done

  install -m 0644 "${src}" "${CONTRACT_TARGET_DIR}/${CONTRACT_FILE_NAME}"

  local address
  address="$(bun -e "
    const json = await Bun.file(process.argv[1]).json();
    const value = json.contractAddress;
    if (typeof value !== 'string' || value.length === 0) {
      console.error('contract file has no string contractAddress');
      process.exit(1);
    }
    process.stdout.write(value);
  " "${src}")"

  export MIDNIGHT_CONTRACT_ADDRESS="${address}"
  log "contract ${CONTRACT_FILE_NAME} adopted: ${address}"
}

# Fail loudly on a variable a container cannot sensibly default.
require_env() {
  local missing=()
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then missing+=("${name}"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "missing required environment: ${missing[*]}"
    return 78 # EX_CONFIG
  fi
}
