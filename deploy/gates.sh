#!/usr/bin/env bash
# gates.sh — the D1.3 static gates (spec SC-004, static half).
#
# Everything here is static or per-image: it renders the Compose model, builds
# each image, and drives the solver's fail-fast negative controls INSIDE a
# container. It deliberately does NOT bring the stack up — that is D2, and a
# gate that quietly started a chain on a shared host would be a bad neighbour.
#
#   ./gates.sh [output-dir]
#
# Transcripts are written per gate, plus a summary. Exit 0 only if every gate
# passed.
set -uo pipefail

cd "$(dirname "$0")"

OUT="${1:-${GATES_OUT:-/tmp/cow00005-d1-gates}}"
mkdir -p "${OUT}"

PASS=0
FAIL=0
SUMMARY="${OUT}/summary.txt"
: > "${SUMMARY}"

run_gate() {
  local name="$1"; shift
  local log="${OUT}/${name}.log"
  echo "== gate ${name} =="
  {
    echo "### gate: ${name}"
    echo "### command: $*"
    echo "### started: $(date -u +%FT%TZ)"
    echo
  } > "${log}"
  if "$@" >> "${log}" 2>&1; then
    echo "PASS ${name}" | tee -a "${SUMMARY}"
    PASS=$((PASS + 1))
    return 0
  fi
  echo "FAIL ${name}  (see ${log})" | tee -a "${SUMMARY}"
  FAIL=$((FAIL + 1))
  return 1
}

# A gate whose PASS condition is a NON-zero exit and an expected message.
# Used for the solver fail-fast controls: "it refused" is the success case, so
# an exit 0 here is a gate failure, not a pass.
run_negative_gate() {
  local name="$1"; local expect="$2"; shift 2
  local log="${OUT}/${name}.log"
  echo "== negative gate ${name} =="
  {
    echo "### negative gate: ${name}"
    echo "### command: $*"
    echo "### expects: non-zero exit AND stderr/stdout matching: ${expect}"
    echo "### started: $(date -u +%FT%TZ)"
    echo
  } > "${log}"
  local status=0
  "$@" >> "${log}" 2>&1 || status=$?
  {
    echo
    echo "### exit status: ${status}"
  } >> "${log}"
  if [ "${status}" -eq 0 ]; then
    echo "FAIL ${name}  (exited 0; a missing mandatory variable MUST fail)" | tee -a "${SUMMARY}"
    FAIL=$((FAIL + 1))
    return 1
  fi
  if ! grep -qE "${expect}" "${log}"; then
    echo "FAIL ${name}  (exit ${status} but no message matching /${expect}/)" | tee -a "${SUMMARY}"
    FAIL=$((FAIL + 1))
    return 1
  fi
  echo "PASS ${name}  (exit ${status}, expected message present)" | tee -a "${SUMMARY}"
  PASS=$((PASS + 1))
  return 0
}

if [ ! -f .env ]; then
  echo "deploy/.env missing — run ./bootstrap.sh first" >&2
  exit 1
fi

echo "gates output: ${OUT}"
{
  echo "D1.3 static gates"
  echo "host    : $(uname -srm)"
  echo "docker  : $(docker --version)"
  echo "compose : $(docker compose version --short 2>/dev/null || docker compose version)"
  echo "date    : $(date -u +%FT%TZ)"
  echo "disk    : $(df -h . | tail -1)"
  echo
} | tee -a "${SUMMARY}"

# ── G1: the Compose model renders ───────────────────────────────────────────
run_gate compose-config docker compose --profile e2e config

# ── G2: every image builds ──────────────────────────────────────────────────
# One gate per image so a failure names the image instead of "the build".
run_gate build-midnight-node docker compose build midnight-node
run_gate build-proof-server  docker compose build proof-server
run_gate build-indexer       docker compose build indexer
run_gate build-celestia      docker compose build celestia
run_gate build-relay         docker compose build relay
run_gate build-kernel        docker compose build kernel

# ── G3: solver fail-fast negative controls, IN CONTAINER ────────────────────
# These drive the REPO's launch contract (`bun run start.solver.ts` ->
# packages/solver/src/launch.ts), not the deployment's entrypoint wrapper: the
# wrapper is bypassed with `--entrypoint` precisely so the gate cannot be
# satisfied by a shell check of our own. `--no-deps` keeps them from starting a
# chain.
SOLVER_RUN=(docker compose run --rm --no-deps --entrypoint bun)

# G3a — the relay WS URL is absent. Expect exit 1 AND a message that names
# every problem at once, not just the first.
run_negative_gate solver-missing-relay-ws \
  "SOLVER_RELAY_WS_URL is required" \
  "${SOLVER_RUN[@]}" -e SOLVER_RELAY_WS_URL= solver run start.solver.ts

# G3b — the journal path is absent.
run_negative_gate solver-missing-journal-path \
  "SOLVER_JOURNAL_PATH is required" \
  "${SOLVER_RUN[@]}" -e SOLVER_JOURNAL_PATH= solver run start.solver.ts

# G3c — nothing at all is configured. Proves the aggregation property: ONE run
# reports all seven mandatory boundaries, so an operator does not fix and
# restart seven times.
run_negative_gate solver-missing-everything \
  "solver launch configuration is invalid \(7 problems\)" \
  "${SOLVER_RUN[@]}" \
    -e MIDNIGHT_NETWORK_ID= -e ZSWAP_API= -e SOLVER_RELAY_WS_URL= \
    -e SOLVER_RELAY_HTTP_URL= -e SOLVER_RELAY_AUTH_TOKEN= \
    -e SOLVER_JOURNAL_PATH= -e SOLVER_SEED= \
    solver run start.solver.ts

# G3d — a short bearer is refused. Both sides of the wire enforce 32 chars; the
# candidate must refuse before it ever dials.
run_negative_gate solver-short-auth-token \
  "SOLVER_RELAY_AUTH_TOKEN must be at least 32 characters" \
  "${SOLVER_RUN[@]}" -e SOLVER_RELAY_AUTH_TOKEN=tooshort solver run start.solver.ts

# G3e — a relative journal path is refused (it must be a mounted volume).
run_negative_gate solver-relative-journal-path \
  "SOLVER_JOURNAL_PATH must be an absolute mounted-volume path" \
  "${SOLVER_RUN[@]}" -e SOLVER_JOURNAL_PATH=operations.sqlite solver run start.solver.ts

# ── G4: the disabled solver is a clean exit 0, not a crash ──────────────────
run_gate solver-disabled-exits-zero \
  "${SOLVER_RUN[@]}" -e SOLVER_ENABLED=false solver run start.solver.ts

# ── G5: the entrypoints parse ───────────────────────────────────────────────
# A shell syntax error in an entrypoint is invisible until the service starts,
# which on this stack is minutes into a bring-up behind three healthchecks.
run_gate entrypoints-parse \
  docker compose run --rm --no-deps --entrypoint sh solver -c \
    'set -e; for f in /usr/local/bin/entrypoint-*.sh /usr/local/bin/wait-for.sh; do echo "checking $f"; bash -n "$f"; done; echo "all entrypoints parse"'

# ── G6: the pglite server module resolves inside the image ──────────────────
# `@effectstream/db` is not a root dependency and the bun store holds two copies
# of it behind different content hashes, so this resolve is the one thing in the
# pglite entrypoint that can fail for reasons no static check would catch. Prove
# it resolves to a real file WITHOUT starting the server.
run_gate pglite-resolver \
  docker compose run --rm --no-deps --entrypoint sh solver -c \
    'p=$(bun --cwd /app/packages/database -e "process.stdout.write(import.meta.resolve(\"@effectstream/db/start-pglite\").replace(\"file://\",\"\"))"); echo "resolved: $p"; test -f "$p"'

# ── G7: the compiled Compact artifacts are in the image ─────────────────────
# `src/managed/` is gitignored, so it exists only because the image built it.
# Without the proving keys the deploy one-shot, the kernel's contract read and
# the mint script all fail at runtime, far from the cause.
run_gate compact-artifacts \
  docker compose run --rm --no-deps --entrypoint sh solver -c \
    'd=/app/packages/contracts-midnight/contract-offer-files/src/managed; set -e; for sub in compiler contract keys zkir; do test -d "$d/$sub" || { echo "missing $d/$sub"; exit 1; }; done; test -f "$d/compiler/contract-info.json"; ls "$d/keys"; echo "compact artifacts present"'

{
  echo
  echo "passed: ${PASS}"
  echo "failed: ${FAIL}"
  echo "finished: $(date -u +%FT%TZ)"
} | tee -a "${SUMMARY}"

[ "${FAIL}" -eq 0 ]
