#!/usr/bin/env bash
# Clean-stack driver for the grand e2e suite.
#
# The suite audits totals across the WHOLE database, so it must start from a
# wiped PGlite — rerunning against a warm stack fails the chart/volume checks
# with the previous run's fills. `bunx orchestrator start` wipes PGlite and
# Celestia on boot.
#
# The batcher now performs its own address-registration + five-output NIGHT
# bootstrap before the adapter snapshots worker capacity. No external funding
# or restart step is part of a normal run.
#
# Pass --keep-stack to run against a stack that is already up.
set -uo pipefail
cd "$(dirname "$0")/../../.."
HERE=packages/tests/grand-e2e
OUT=$HERE/out
mkdir -p "$OUT"
say() { echo "[$(date +%H:%M:%S)] $*"; }

# Reap our own leftovers. Must run before EVERY attempt, not just the first:
# a failed attempt's midnight-indexer outlives the orchestrator's SIGTERM by a
# few seconds, and the next attempt's `--clean` deletes indexer.sqlite out from
# under it — which surfaces as `run Sqlite migrations: disk I/O error` and
# kills the retry too. The batcher matters for the same reason plus a worse
# one: it holds the same wallet seed as the next stack's batcher, so two
# compete for one wallet's dust coins. A provisioning run whose stack died
# retries wallet sync forever.
#
# -u restricts matching to our own uid. Unrelated projects on this box run
# identically-named processes (e.g. an indexer-standalone container as uid
# 10001); those are not ours to signal and must not be touched.
reap_orphans() {
  local pat pid
  # main.grand-b.ts is the one that hurts most and was missing: p7a spawns a
  # SECOND full node replaying the chain from height 1, and it is by far the
  # heaviest thing this suite runs (measured: load average 17 on a 16-core box
  # while it replays). A run killed during p7a — which a session teardown does —
  # leaves that replica running indefinitely, quietly loading every subsequent
  # run: deeper STM catch-up, slower settlement, inflated latency metrics, and
  # no visible cause. main.dev.ts is here for the same reason; the orchestrator
  # shutdown above handles it on a clean exit, but not on a hard kill.
  #
  # start-pglite is the same story with a sharper edge: it holds port 5432, so a
  # survivor does not merely slow the next run, it stops the new stack binding at
  # all. Diagnosed the hard way when a reboot left the SYSTEM postgres on 5432 —
  # three identical bootstrap failures whose real cause was one SASL line deep in
  # stack.log. A stale PGlite of our own produces the same symptom.
  for pat in 'packages/batcher/[b]atcher[.]dev[.]ts' '[p]rovision-batcher-dust.ts' \
             '[i]ndexer-standalone' 'packages/node/main[.]grand-b[.]ts' \
             'packages/node/main[.]dev[.]ts' '[s]tart-pglite'; do
    for pid in $(pgrep -u "$(id -u)" -f "$pat" 2>/dev/null); do
      say "reaping orphan $pid ($pat)"; kill "$pid" 2>/dev/null
    done
  done
  sleep 4
}

if [[ "${1:-}" != "--keep-stack" ]]; then
  say "shutting the stack down"
  curl -s -X POST --max-time 10 http://127.0.0.1:4747/shutdown >/dev/null 2>&1
  for i in $(seq 60); do ss -ltn 2>/dev/null | grep -qE ":(9999|4747)\b" || break; sleep 2; done

  reap_orphans

  # midnight-mint-test-tokens intermittently fails on a brand-new chain with
  # `RpcError: 1010: Invalid Transaction: Custom error: 196`, and the
  # orchestrator tears the whole stack down when it does. Retry rather than
  # lose the run.
  for attempt in 1 2 3; do
    say "starting a fresh stack (attempt $attempt)"
    if "$HERE/start-stack.sh"; then say "stack ready"; break; fi
    say "bootstrap failed — retrying"
    curl -s -X POST --max-time 10 http://127.0.0.1:4747/shutdown >/dev/null 2>&1
    sleep 10
    reap_orphans
    [[ $attempt == 3 ]] && { say "stack would not bootstrap; see $OUT/stack.log"; exit 1; }
  done
fi

for i in $(seq 120); do
  curl -s --max-time 3 http://127.0.0.1:3334/health 2>/dev/null | grep -q '"isRunning":true' && break
  sleep 5
done
say "batcher: $(curl -s --max-time 3 http://127.0.0.1:3334/health)"

for i in $(seq 120); do
  grep -qa 'NIGHT bootstrap: .*5 spendable dust streams' "$OUT/stack.log" && \
    grep -qa 'worker slots: 5 ' "$OUT/stack.log" && break
  sleep 5
done
bootstrap_line="$(grep -ao 'NIGHT bootstrap: .*' "$OUT/stack.log" | tail -1)"
slots_line="$(grep -ao 'worker slots: .*' "$OUT/stack.log" | tail -1)"
say "batcher bootstrap: $bootstrap_line"
say "batcher slots: $slots_line"
[[ "$bootstrap_line" == *"5 spendable dust streams"* && "$slots_line" == "worker slots: 5 "* ]] || {
  say "batcher did not prove the five-UTXO/five-slot bootstrap"
  exit 1
}

say "running the suite"
GRAND_OFFERS=${GRAND_OFFERS:-60} \
GRAND_STORM_API=${GRAND_STORM_API:-200} \
GRAND_STORM_CELESTIA=${GRAND_STORM_CELESTIA:-30} \
ROOT_WINDOW_SECONDS=${ROOT_WINDOW_SECONDS:-600} \
OFFER_TTL_SECONDS=${OFFER_TTL_SECONDS:-600} \
  bun run "$HERE/run.ts" 2>&1 | tee "$OUT/grand-v3.log"
suite_status=${PIPESTATUS[0]}
say "suite exited with $suite_status"
exit "$suite_status"
