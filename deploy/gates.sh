#!/usr/bin/env bash
# gates.sh — the D1.3 static gates (spec SC-004, static half).
#
# Everything here is static or per-image: it renders the Compose model, builds
# each image, and drives the solver's fail-fast negative controls INSIDE a
# container. It deliberately does NOT bring the stack up — that is D2, and a
# gate that quietly started a chain on a shared host would be a bad neighbour.
#
# G8 adds the public-network controls (preview, preprod, mainnet): the kernel
# image's public node, batcher, poster and token-registry entries, run with
# `--network none` so every endpoint is unreachable — configuration
# preflights, named refusals (unknown network, retired endpoint host, missing
# Blockfrost token, dev seeds), offline boots that reach their first network
# call with every Blockfrost token redacted, and the entrypoint selection
# harness. No live network is touched.
#
#   ./gates.sh [output-dir]
#   GATES_ONLY=public ./gates.sh [output-dir]   # G8 only: needs just the kernel image
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
  # The command's OUTPUT is captured separately from this header: the header
  # above quotes the expected pattern verbatim, so grepping the whole log would
  # let a literal pattern match its own "### expects:" line and pass the gate
  # with the process having said nothing at all (found at 00007-P-C: every
  # literal-pattern negative gate had been passing that way since D1).
  local out="${log}.out"
  local status=0
  "$@" > "${out}" 2>&1 || status=$?
  cat "${out}" >> "${log}"
  {
    echo
    echo "### exit status: ${status}"
  } >> "${log}"
  if [ "${status}" -eq 0 ]; then
    echo "FAIL ${name}  (exited 0; a missing mandatory variable MUST fail)" | tee -a "${SUMMARY}"
    FAIL=$((FAIL + 1))
    rm -f "${out}"
    return 1
  fi
  if ! grep -qE "${expect}" "${out}"; then
    rm -f "${out}"
    echo "FAIL ${name}  (exit ${status} but no message matching /${expect}/)" | tee -a "${SUMMARY}"
    FAIL=$((FAIL + 1))
    return 1
  fi
  rm -f "${out}"
  echo "PASS ${name}  (exit ${status}, expected message present)" | tee -a "${SUMMARY}"
  PASS=$((PASS + 1))
  return 0
}

# A gate with an exit-code expectation AND literal output patterns that must
# ALL appear — or, written `!literal`, must NOT appear anywhere (a secret the
# command was given). Usage:
#   run_expect_gate <name> <0|nonzero|N> <literal|!literal>... -- <command...>
# The patterns are matched against the command's own output only (the header
# quoting them lives in the log, not in the file that is grepped).
run_expect_gate() {
  local name="$1" want="$2"; shift 2
  local patterns=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do patterns+=("$1"); shift; done
  [ "$#" -gt 0 ] && shift # the --
  local log="${OUT}/${name}.log" out="${OUT}/${name}.log.out" status=0 p
  echo "== expect gate ${name} =="
  {
    echo "### expect gate: ${name}"
    echo "### command: $*"
    echo "### expects exit: ${want}"
    for p in "${patterns[@]}"; do echo "### expects output: ${p}"; done
    echo "### started: $(date -u +%FT%TZ)"
    echo
  } > "${log}"
  "$@" > "${out}" 2>&1 || status=$?
  cat "${out}" >> "${log}"
  printf '\n### exit status: %s\n' "${status}" >> "${log}"
  local reason=""
  case "${want}" in
    nonzero) [ "${status}" -ne 0 ] || reason="exited 0, expected a non-zero exit" ;;
    *) [ "${status}" -eq "${want}" ] || reason="exit ${status}, expected ${want}" ;;
  esac
  if [ -z "${reason}" ]; then
    for p in "${patterns[@]}"; do
      case "${p}" in
        '!'*)
          if grep -qF -- "${p#!}" "${out}"; then reason="forbidden output present: ${p#!}"; break; fi ;;
        *)
          if ! grep -qF -- "${p}" "${out}"; then reason="missing output: ${p}"; break; fi ;;
      esac
    done
  fi
  rm -f "${out}"
  if [ -n "${reason}" ]; then
    echo "FAIL ${name}  (${reason}; see ${log})" | tee -a "${SUMMARY}"
    FAIL=$((FAIL + 1))
    return 1
  fi
  echo "PASS ${name}  (exit ${status}, expected output present)" | tee -a "${SUMMARY}"
  PASS=$((PASS + 1))
  return 0
}

# all | public — `public` runs only G8, which needs nothing but the kernel image.
GATES_ONLY="${GATES_ONLY:-all}"
case "${GATES_ONLY}" in
  all|public) ;;
  *) echo "GATES_ONLY must be all or public, got '${GATES_ONLY}'" >&2; exit 2 ;;
esac

if [ "${GATES_ONLY}" = "all" ] && [ ! -f .env ]; then
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

# G1–G7 render the Compose model, build every image and drive the solver
# controls; GATES_ONLY=public skips them (the block is not re-indented).
if [ "${GATES_ONLY}" = "all" ]; then

# ── G1: the Compose model renders ───────────────────────────────────────────
# The rendered model carries every generated secret in clear. The transcript is
# evidence that gets copied around, so the values are redacted on the way out
# (audit 00007 F-05); the gate still fails on a render error because `set -o
# pipefail` is on and the sed never fails.
run_gate compose-config sh -c \
  'docker compose --profile e2e config | sed -E "s/^([[:space:]]*[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*:[[:space:]]*).*/\\1<redacted>/"'

# G1b — retained offer services are present and local deploy/mint/register
# services are absent. Exact startup edges are checked after the image exists.
run_gate compose-config-00007-services sh -c \
  'svcs="$(docker compose --profile e2e config --services)"; echo "$svcs"; \
   echo "$svcs" | grep -qx solver-frontend && echo "$svcs" | grep -qx solver-provision && \
   echo "$svcs" | grep -qx maker-offer && \
   ! echo "$svcs" | grep -Eq "^(offerfiles-deploy|mint-test-tokens|register-minted-tokens)$"'

# ── G2: every image builds ──────────────────────────────────────────────────
# One gate per image so a failure names the image instead of "the build".
run_gate build-midnight-node docker compose build midnight-node
run_gate build-proof-server  docker compose build proof-server
run_gate build-indexer       docker compose build indexer
run_gate build-celestia      docker compose build celestia
run_gate build-relay         docker compose build relay
run_gate build-kernel        docker compose build kernel

# G2b — parse the actual all-profile Compose JSON, assert retained chain/offer
# readiness edges, reject removed local funding services, cycles and unknowns.
check_compose_topology() {
  docker compose --profile e2e --profile poster --profile prices config --format json |
    docker compose run --rm --no-deps -T --entrypoint bun solver \
      deploy/scripts/lib/check-compose-topology.ts -
}
run_gate compose-startup-topology check_compose_topology

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

# G3b — the journal path is absent. Compose renders it as "" rather than
# unset, and `loadSolverJournalEnv` words the two differently ("is required"
# for undefined, "must be a non-empty canonical path" for ""); the D1 pattern
# only knew the first and had been passing vacuously (see run_negative_gate).
run_negative_gate solver-missing-journal-path \
  "SOLVER_JOURNAL_PATH (is required|must be a non-empty canonical path)" \
  "${SOLVER_RUN[@]}" -e SOLVER_JOURNAL_PATH= solver run start.solver.ts

# G3c — nothing MANDATORY is configured. Proves the aggregation property: ONE
# run reports all seven mandatory boundaries, so an operator does not fix and
# restart seven times.
#
# `SOLVER_FEE_SIZING_TAKER_INPUTS=1` is pinned here deliberately. This gate
# bypasses the entrypoint (that is its whole point), so it does NOT get the
# empty-optional unset pass that `entrypoint-common.sh` performs — and since
# 00006-V1 `compose.yml` forwards that knob, whose parser treats "" as
# MALFORMED rather than as unset. Leaving it blank would add an eighth problem
# and turn a gate about the seven mandatory boundaries into a gate about how
# this machine's `.env` happens to be filled in. G3f below covers the blank case
# properly, with the entrypoint in the loop where it belongs.
run_negative_gate solver-missing-everything \
  "solver launch configuration is invalid \(7 problems\)" \
  "${SOLVER_RUN[@]}" \
    -e MIDNIGHT_NETWORK_ID= -e ZSWAP_API= -e SOLVER_RELAY_WS_URL= \
    -e SOLVER_RELAY_HTTP_URL= -e SOLVER_RELAY_AUTH_TOKEN= \
    -e SOLVER_JOURNAL_PATH= -e SOLVER_SEED= \
    -e SOLVER_FEE_SIZING_TAKER_INPUTS=1 \
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

# G3f — the empty-optional unset list actually covers the strict knobs (00006).
#
# Compose cannot express "leave this variable out": `FOO: ${FOO:-}` renders as
# FOO="". Most of this codebase's optional knobs read "" as a value, which is
# why `entrypoint-common.sh` unsets them — but four of them are STRICTER still,
# because their parsers reject "" outright:
# SOLVER_FEE_SIZING_TAKER_INPUTS (a bounded integer) and the
# SOLVER_DUST_MAX_PER_JOB / _PER_WINDOW / SOLVER_DUST_WINDOW_MS group (positive
# bigints, all-or-nothing). For those, a missing entry in the unset list is not
# a soft mis-default: it is a hard startup failure on a stack whose `.env` left
# them blank.
#
# So this gate keeps the entrypoint IN the loop (the only gate that does) and
# asserts the count: with all four blank AND the seven mandatory boundaries
# blank, the launch report must still be exactly the seven mandatory problems.
# An eighth means the unset list and `compose.yml` have drifted apart.
run_negative_gate solver-blank-strict-optionals \
  "solver launch configuration is invalid \(7 problems\)" \
  docker compose run --rm --no-deps --entrypoint bash \
    -e MIDNIGHT_NETWORK_ID= -e ZSWAP_API= -e SOLVER_RELAY_WS_URL= \
    -e SOLVER_RELAY_HTTP_URL= -e SOLVER_RELAY_AUTH_TOKEN= \
    -e SOLVER_JOURNAL_PATH= -e SOLVER_SEED= \
    -e SOLVER_FEE_SIZING_TAKER_INPUTS= \
    -e SOLVER_DUST_MAX_PER_JOB= -e SOLVER_DUST_MAX_PER_WINDOW= \
    -e SOLVER_DUST_WINDOW_MS= \
    -e SOLVER_SUPPORTED_PAIRS= -e SOLVER_MIN_JOB_OUTPUT= \
    solver -c '. /usr/local/bin/entrypoint-common.sh; cd "${REPO_ROOT}"; exec bun run start.solver.ts'

# G3g — removed manual pricing fails before the solver can touch a wallet,
# journal, backend or relay. It is not blank-normalized into a fallback.
run_negative_gate solver-retired-ladder-config \
  "SOLVER_LADDER_CONFIG was removed" \
  "${SOLVER_RUN[@]}" -e SOLVER_LADDER_CONFIG=/tmp/retired-ladders.json \
    solver run start.solver.ts

# G3h — (00007) a status listener can never come up open: with the port set
# (compose.yml sets it) a short bearer is one of the LISTED launch problems.
run_negative_gate solver-short-status-token \
  "SOLVER_STATUS_AUTH_TOKEN must be at least 32 characters" \
  "${SOLVER_RUN[@]}" -e SOLVER_STATUS_AUTH_TOKEN=tooshort10 \
    -e SOLVER_FEE_SIZING_TAKER_INPUTS=1 solver run start.solver.ts

# G3i — (00007) the monitor site's own fail-fast: the solver status URL is
# mandatory, and the site must refuse to start rather than render a page that
# can never show the solver. Bypasses the entrypoint like the solver gates.
run_negative_gate solver-frontend-missing-status-url \
  "SOLVER_FRONTEND_SOLVER_STATUS_URL (is required|must be a non-empty URL)" \
  docker compose run --rm --no-deps --entrypoint bun \
    -e SOLVER_FRONTEND_SOLVER_STATUS_URL= solver-frontend run start.solver-frontend.ts

# G3j — (00007) the site's aggregation property: with every mandatory boundary
# blank, ONE run reports all three (status URL, status token, kernel API).
run_negative_gate solver-frontend-missing-everything \
  "solver-frontend configuration is invalid \(3 problems\)" \
  docker compose run --rm --no-deps --entrypoint bun \
    -e SOLVER_FRONTEND_SOLVER_STATUS_URL= -e SOLVER_FRONTEND_SOLVER_STATUS_TOKEN= \
    -e SOLVER_FRONTEND_ZSWAP_API= -e SOLVER_FRONTEND_RELAY_HTTP_URL= \
    solver-frontend run start.solver-frontend.ts

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

# ── G7: (00007) the monitor site's static assets are in the image ───────────
# `public/` is plain files, not a package export, so nothing at install time
# would notice if the build context ignored them; the site would 404 its own
# page at runtime.
run_gate solver-frontend-assets \
  docker compose run --rm --no-deps --entrypoint sh solver-frontend -c \
    'd=/app/packages/solver-frontend/public; set -e; for f in index.html styles.css app.js derive.js help.js; do test -f "$d/$f" || { echo "missing $d/$f"; exit 1; }; done; test -f /app/start.solver-frontend.ts; echo "solver-frontend assets present"'

fi # GATES_ONLY=all

# ── G8: public-network controls, OFFLINE, in the kernel image ───────────────
# `docker run --network none`: nothing is reachable, so no gate here can touch
# a Midnight network, Celestia or a database. Each service is driven through
# its real entry (and, where it has one, its real entrypoint script). Wallet
# seeds are generated inside the container and never printed; the Celestia and
# Blockfrost tokens are dummies, and every gate that is handed the Blockfrost
# token also asserts it never appears in the output (`!${GATE_BF_TOKEN}`).
# The constants the gates look for: the NTP anchor at each network's block 1,
# Celestia mocha (preview, preprod) / mainnet (mainnet), the MIP-0006
# namespace 6d6e2d737761702d7631, root window 1209600 s, and the Blockfrost
# endpoints shown as `project_id=<redacted>`.
# The kernel image exactly as compose.yml names it — ${KERNEL_IMAGE:-cow00005/kernel}:${IMAGE_TAG:-dev},
# the shell environment winning over .env as in Compose. (`docker compose config
# --images` ignores its service filter and lists every image in no fixed order.)
env_value() { [ -f .env ] || return 0; grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- ; }
KERNEL_REPO="${KERNEL_IMAGE:-$(env_value KERNEL_IMAGE)}"
KERNEL_TAG="${IMAGE_TAG:-$(env_value IMAGE_TAG)}"
KERNEL_IMG="${KERNEL_REPO:-cow00005/kernel}:${KERNEL_TAG:-dev}"
echo "public-network gates use kernel image: ${KERNEL_IMG}"
# `--pull never`: a missing image is an immediate failure, never a registry
# pull (which on some Docker Desktop hosts stalls without end).
KRUN=(docker run --rm --pull never --network none)
run_gate public-kernel-image-present docker image inspect --format '{{.Id}}' "${KERNEL_IMG}"
GATE_BF_TOKEN=gateDummyBlockfrostToken00000000
GATE_TOKENS=(-e GIVE_TOKEN=ad2ba014014e6ec705357be9db5d3ad6f535d4bef6576f84a461f23b313a2e8e
             -e WANT_TOKEN=e934b965a454ed6857080e9956ea83fb5542e0a860e96ce91daf35f5d7b02c9f)
RANDOM_SEED='$(od -An -N32 -tx1 /dev/urandom | tr -d " \n")'
# A loopback listener that only reports a connection: the "database" of the
# offline boots, so the log proves the node reached its first network call.
DB_PROBE='bun -e "Bun.listen({hostname:\"127.0.0.1\",port:5432,socket:{open(s){console.log(\"[probe] database connection attempt on 127.0.0.1:5432\");s.end()},data(){}}})" &'

node_env() { # <network>
  NODE_ENV=(-e "MIDNIGHT_NETWORK_ID=$1" -e "MIDNIGHT_BLOCKFROST_PROJECT_ID=${GATE_BF_TOKEN}"
            -e CELESTIA_RPC_URL=https://celestia.invalid -e CELESTIA_AUTH_TOKEN=gate-dummy-token
            -e CELESTIA_START_HEIGHT=9000000 -e PGLITE=false
            -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300)
}
batcher_env() { # <network>
  BATCHER_ENV=(-e "MIDNIGHT_NETWORK_ID=$1" -e "MIDNIGHT_BLOCKFROST_PROJECT_ID=${GATE_BF_TOKEN}"
               -e CELESTIA_RPC_URL=https://celestia.invalid -e CELESTIA_AUTH_TOKEN=gate-dummy-token
               -e BATCHER_STORAGE_DIR=/var/lib/batcher -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300)
}

# G8a/b — every public network with pinned reference parameters: the node
# preflight and the batcher --check print the network's constants and the
# REDACTED Blockfrost endpoints.
for NET in preview preprod; do
  case "${NET}" in
    preview) ANCHOR=1784214468491; CEL=mocha ;;
    preprod) ANCHOR=1774031004000; CEL=mocha ;;
  esac
  node_env "${NET}"; batcher_env "${NET}"
  run_expect_gate "${NET}-node-preflight" 0 \
    "NTP anchor         : ${ANCHOR}" "Celestia network   : ${CEL}" \
    "Celestia namespace : 6d6e2d737761702d7631 (MIP-0006 mn-swap-v1)" "root window        : 1209600 s" \
    "Midnight indexer   : https://midnight-${NET}.blockfrost.io/api/v0?project_id=<redacted>" \
    "node configuration OK" "!${GATE_BF_TOKEN}" -- \
    "${KRUN[@]}" "${NODE_ENV[@]}" --entrypoint bun "${KERNEL_IMG}" run packages/node/public-network-profile.ts
  run_expect_gate "${NET}-batcher-check" 0 \
    "[${NET}] network            : ${NET}" \
    "Midnight node      : https://rpc.midnight-${NET}.blockfrost.io?project_id=<redacted>" \
    "Celestia network   : ${CEL}" "Celestia namespace : 6d6e2d737761702d7631 (MIP-0006 mn-swap-v1)" \
    "DUST-state cache   : /var/lib/batcher/dust-state" "batcher configuration OK" "!${GATE_BF_TOKEN}" -- \
    "${KRUN[@]}" "${BATCHER_ENV[@]}" --entrypoint sh "${KERNEL_IMG}" -c \
      "export BATCHER_WALLET_SEED=${RANDOM_SEED}; exec bun run packages/batcher/batcher.public.ts --check"
done

# G8a/b mainnet — supported, but its ledger-9 reference parameters are not
# pinned yet: the node preflight, the node entry, the batcher --check and the
# batcher entry each exit 78 saying so (not "not supported"), before any
# network call, with an otherwise complete configuration.
MAINNET_NOT_PINNED='MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ledger-9 reference parameters are not pinned yet'
node_env mainnet; batcher_env mainnet
run_expect_gate mainnet-node-preflight-not-pinned 78 "${MAINNET_NOT_PINNED}" "(1 problem)" "!${GATE_BF_TOKEN}" -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" --entrypoint bun "${KERNEL_IMG}" run packages/node/public-network-profile.ts
run_expect_gate mainnet-node-entry-not-pinned 78 "${MAINNET_NOT_PINNED}" "!${GATE_BF_TOKEN}" "!Starting ZSwap DA Node" -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" --entrypoint bun "${KERNEL_IMG}" run packages/node/main.public.ts
run_expect_gate mainnet-batcher-check-not-pinned 78 "${MAINNET_NOT_PINNED}" "(1 problem)" "!${GATE_BF_TOKEN}" -- \
  "${KRUN[@]}" "${BATCHER_ENV[@]}" --entrypoint sh "${KERNEL_IMG}" -c \
    "export BATCHER_WALLET_SEED=${RANDOM_SEED}; exec bun run packages/batcher/batcher.public.ts --check"
run_expect_gate mainnet-batcher-entry-not-pinned 78 "${MAINNET_NOT_PINNED}" "!${GATE_BF_TOKEN}" "!starting on" -- \
  "${KRUN[@]}" "${BATCHER_ENV[@]}" --entrypoint sh "${KERNEL_IMG}" -c \
    "export BATCHER_WALLET_SEED=${RANDOM_SEED}; exec bun run packages/batcher/batcher.public.ts"

# G8c–f — node refusals by name (exit 78): an unsupported network, a missing
# start height, no Blockfrost token, a retired Midnight-hosted endpoint.
node_env preprod
run_expect_gate public-node-stagenet-refused 78 \
  'MIDNIGHT_NETWORK_ID="stagenet" is not supported (supported: undeployed, preview, preprod, mainnet)' -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" -e MIDNIGHT_NETWORK_ID=stagenet --entrypoint bun "${KERNEL_IMG}" run packages/node/main.public.ts
run_expect_gate public-node-missing-start-height 78 "CELESTIA_START_HEIGHT is required on preprod" -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" -e CELESTIA_START_HEIGHT= --entrypoint bun "${KERNEL_IMG}" run packages/node/public-network-profile.ts
run_expect_gate public-node-missing-blockfrost-token 78 "MIDNIGHT_BLOCKFROST_PROJECT_ID is required on mainnet" -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" -e MIDNIGHT_NETWORK_ID=mainnet -e MIDNIGHT_BLOCKFROST_PROJECT_ID= \
    --entrypoint bun "${KERNEL_IMG}" run packages/node/main.public.ts
run_expect_gate public-node-retired-endpoint 78 \
  "MIDNIGHT_INDEXER_HTTP points at indexer.preprod.midnight.network" "MIDNIGHT_BLOCKFROST_PROJECT_ID" -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" -e MIDNIGHT_INDEXER_HTTP=https://indexer.preprod.midnight.network/api/v4/graphql \
    --entrypoint bun "${KERNEL_IMG}" run packages/node/main.public.ts

# G8g — node: main.public.ts boots offline to its first network call; the
# unreachable indexer is a warning, and the token never reaches the log.
run_expect_gate public-node-boot-offline nonzero \
  "Starting ZSwap DA Node (preprod)" \
  "[preprod] resolved: network=preprod ntpStartTime=1774031004000 blockTimeMs=600000 celestiaNetwork=mocha namespace=6d6e2d737761702d7631 rootWindowSeconds=1209600" \
  "Midnight indexer   : https://midnight-preprod.blockfrost.io/api/v0?project_id=<redacted>" \
  "unreachable at startup" "[probe] database connection attempt on 127.0.0.1:5432" "!${GATE_BF_TOKEN}" -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" -e DB_HOST=127.0.0.1 -e DB_PORT=5432 --entrypoint sh "${KERNEL_IMG}" -c \
    "${DB_PROBE} sleep 1; exec timeout 45 bun run packages/node/main.public.ts"

# G8h — kernel entrypoint: selects main.public.ts, preflight BEFORE the waits.
run_expect_gate public-kernel-entrypoint nonzero \
  "selected packages/node/main.public.ts for network preprod" "node configuration OK" \
  "waiting for pglite at tcp://postgres.invalid:5432" "TIMEOUT after 4s" "!${GATE_BF_TOKEN}" -- \
  "${KRUN[@]}" "${NODE_ENV[@]}" -e DB_HOST=postgres.invalid -e DB_PORT=5432 -e DB_WAIT_TIMEOUT_S=4 \
    --entrypoint /usr/local/bin/entrypoint-kernel.sh "${KERNEL_IMG}"

# G8i–k — batcher refusals by name (exit 78): no seed, the batcher dev seed
# …03, a 31-zero-byte seed. None falls back.
batcher_env preprod
run_expect_gate public-batcher-missing-seed 78 "BATCHER_WALLET_SEED is required on preprod" -- \
  "${KRUN[@]}" "${BATCHER_ENV[@]}" --entrypoint bun "${KERNEL_IMG}" run packages/batcher/batcher.public.ts
batcher_env mainnet
run_expect_gate public-batcher-dev-seed 78 "BATCHER_WALLET_SEED is a public dev seed" -- \
  "${KRUN[@]}" "${BATCHER_ENV[@]}" -e BATCHER_WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000003 \
    --entrypoint bun "${KERNEL_IMG}" run packages/batcher/batcher.public.ts
batcher_env preview
run_expect_gate public-batcher-31-zero-byte-seed 78 "BATCHER_WALLET_SEED is a public dev seed" -- \
  "${KRUN[@]}" "${BATCHER_ENV[@]}" -e BATCHER_WALLET_SEED=00000000000000000000000000000000000000000000000000000000000000c4 \
    --entrypoint bun "${KERNEL_IMG}" run packages/batcher/batcher.public.ts

# G8l — batcher: boots offline to its first network calls (wallet + Celestia);
# dependency lines that name the node URL are redacted too.
batcher_env preprod
run_expect_gate public-batcher-boot-offline nonzero \
  "[preprod] starting on :3334" "DUST-state cache   : /var/lib/batcher/dust-state" \
  "unreachable at startup" "[Celestia] readiness probe failed" "!${GATE_BF_TOKEN}" -- \
  "${KRUN[@]}" "${BATCHER_ENV[@]}" --entrypoint sh "${KERNEL_IMG}" -c \
    "export BATCHER_WALLET_SEED=${RANDOM_SEED}; exec timeout 40 bun run packages/batcher/batcher.public.ts"

# G8m — batcher entrypoint: selects batcher.public.ts, --check BEFORE the waits.
run_expect_gate public-batcher-entrypoint nonzero \
  "selected packages/batcher/batcher.public.ts for network preprod" "batcher configuration OK" \
  "waiting for proof-server at http://proof-server:6300" "TIMEOUT after 4s" "!${GATE_BF_TOKEN}" -- \
  "${KRUN[@]}" "${BATCHER_ENV[@]}" -e PROOF_WAIT_TIMEOUT_S=4 --entrypoint sh "${KERNEL_IMG}" -c \
    "export BATCHER_WALLET_SEED=${RANDOM_SEED}; exec /usr/local/bin/entrypoint-batcher.sh"

# G8n/o — poster: a missing wallet (entrypoint) and a dev seed (entry) are refused.
run_expect_gate public-poster-missing-seed 78 "missing required environment: POSTER_SEED or POSTER_MNEMONIC" -- \
  "${KRUN[@]}" -e MIDNIGHT_NETWORK_ID=preprod -e "MIDNIGHT_BLOCKFROST_PROJECT_ID=${GATE_BF_TOKEN}" \
    -e ZSWAP_API=http://kernel.invalid:9999 "${GATE_TOKENS[@]}" \
    --entrypoint /usr/local/bin/entrypoint-offer-poster.sh "${KERNEL_IMG}"
run_expect_gate public-poster-dev-seed 78 "configuration error (PUBLIC_DEV_SEED)" -- \
  "${KRUN[@]}" -e MIDNIGHT_NETWORK_ID=mainnet -e "MIDNIGHT_BLOCKFROST_PROJECT_ID=${GATE_BF_TOKEN}" \
    -e ZSWAP_API=http://kernel.invalid:9999 "${GATE_TOKENS[@]}" \
    -e POSTER_SEED=0000000000000000000000000000000000000000000000000000000000000001 \
    --entrypoint bun "${KERNEL_IMG}" run deploy/scripts/offer-poster.ts

# G8p — poster: Blockfrost endpoint defaults (redacted in the config dump),
# then offline to its wallet sync.
run_expect_gate public-poster-boot-offline nonzero \
  '"indexer": "https://midnight-preprod.blockfrost.io/api/v0?project_id=<redacted>"' \
  "waiting for wallet sync" "startup failed: wallet sync (POSTER_SYNC_TIMEOUT_MS) timed out" "!${GATE_BF_TOKEN}" -- \
  "${KRUN[@]}" -e MIDNIGHT_NETWORK_ID=preprod -e "MIDNIGHT_BLOCKFROST_PROJECT_ID=${GATE_BF_TOKEN}" \
    -e ZSWAP_API=http://kernel.invalid:9999 "${GATE_TOKENS[@]}" \
    -e POSTER_JOURNAL_FILE=/tmp/offer-poster/journal.json -e POSTER_SYNC_TIMEOUT_MS=20000 --entrypoint sh "${KERNEL_IMG}" -c \
    "export POSTER_SEED=${RANDOM_SEED}; exec bun run deploy/scripts/offer-poster.ts"

# G8q/r/t — token-registry one-shot: undeployed refused; an import that cannot
# apply fails LOUDLY after its bounded retries (the registry is unreachable);
# mainnet has no source yet, so it imports nothing and exits 0 without retry.
run_expect_gate public-token-registry-undeployed 78 "TOKEN_REGISTRY_NETWORK must be" -- \
  "${KRUN[@]}" -e TOKEN_REGISTRY_NETWORK=undeployed -e DB_HOST=127.0.0.1 -e DB_PORT=5432 \
    --entrypoint /usr/local/bin/entrypoint-token-registry.sh "${KERNEL_IMG}"
run_expect_gate public-token-registry-loud-failure 1 \
  "FAILED (required import did not apply)" "token registry import FAILED after 2 attempt(s)" -- \
  "${KRUN[@]}" -e TOKEN_REGISTRY_NETWORK=preprod -e DB_HOST=127.0.0.1 -e DB_PORT=5432 \
    -e TOKEN_REGISTRY_ATTEMPTS=2 -e TOKEN_REGISTRY_RETRY_DELAY_S=0 -e TOKEN_REGISTRY_TIMEOUT_MS=1000 \
    --entrypoint sh "${KERNEL_IMG}" -c "${DB_PROBE} sleep 1; exec /usr/local/bin/entrypoint-token-registry.sh"
run_expect_gate public-token-registry-mainnet-nothing-to-import 0 \
  "token registry import skipped: nothing to import for mainnet" "!FAILED" -- \
  "${KRUN[@]}" -e TOKEN_REGISTRY_NETWORK=mainnet -e DB_HOST=127.0.0.1 -e DB_PORT=5432 \
    -e TOKEN_REGISTRY_ATTEMPTS=2 -e TOKEN_REGISTRY_RETRY_DELAY_S=0 \
    --entrypoint sh "${KERNEL_IMG}" -c "${DB_PROBE} sleep 1; exec /usr/local/bin/entrypoint-token-registry.sh"

# G8s — the entrypoint selection harness passes with the image's own bash/bun
# (undeployed still execs main.dev.ts / batcher.dev.ts).
run_expect_gate public-entrypoint-selection-harness 0 " 0 fail" -- \
  "${KRUN[@]}" --entrypoint bun "${KERNEL_IMG}" test deploy/scripts/lib/kernel-entrypoints.test.ts

{
  echo
  echo "passed: ${PASS}"
  echo "failed: ${FAIL}"
  echo "finished: $(date -u +%FT%TZ)"
} | tee -a "${SUMMARY}"

[ "${FAIL}" -eq 0 ]
