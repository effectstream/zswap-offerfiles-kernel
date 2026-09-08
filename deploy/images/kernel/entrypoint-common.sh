#!/usr/bin/env bash
# entrypoint-common.sh — sourced by every kernel-image entrypoint.
#
# Provides shared readiness waits (see wait-for.sh) and environment cleanup.
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
# Price-feed configuration is deliberately absent from this list. Its config
# loader owns blank-as-unset semantics for strings and numbers, including
# whitespace-only values, so direct package and non-Compose launches behave the
# same as this entrypoint. `PRICE_FEED_MAP` and `PRICE_FEED_ASSETS` likewise
# already treat blank input as an empty override/default list.
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
  SOLVER_DUST_WINDOW_MS
do
  if [ -z "${!_optional_env:-}" ]; then unset "${_optional_env}"; fi
done
unset _optional_env

REPO_ROOT="${REPO_ROOT:-/app}"

log() { echo "[$(basename "${0}")] $*" >&2; }

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
