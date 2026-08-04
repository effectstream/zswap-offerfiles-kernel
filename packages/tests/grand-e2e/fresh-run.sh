#!/usr/bin/env bash
# Clean-stack driver for the grand e2e suite.
#
# The suite audits totals across the WHOLE database, so it must start from a
# wiped PGlite — rerunning against a warm stack fails the chart/volume checks
# with the previous run's fills. `bunx orchestrator start` wipes PGlite and
# Celestia on boot.
#
# Dust provisioning must land AFTER the batcher has registered: registration
# rotates pre-existing UTXOs into at most two outputs, so funding first destroys
# the coins it is trying to create.
#
# Pass --keep-stack to run against a stack that is already up.
set -uo pipefail
cd "$(dirname "$0")/../../.."
HERE=packages/tests/grand-e2e
OUT=$HERE/out
mkdir -p "$OUT"
say() { echo "[$(date +%H:%M:%S)] $*"; }

if [[ "${1:-}" != "--keep-stack" ]]; then
  say "shutting the stack down"
  curl -s -X POST --max-time 10 http://127.0.0.1:4747/shutdown >/dev/null 2>&1
  for i in $(seq 60); do ss -ltn 2>/dev/null | grep -qE ":(9999|4747)\b" || break; sleep 2; done

  # Reap orphans. /shutdown does not always take the batcher with it, and a
  # provisioning run whose stack died underneath it spins on wallet-sync retries
  # forever. Both outlive their orchestrator, and a surviving batcher is the
  # dangerous one: it holds the SAME wallet seed as the batcher the next stack
  # starts, so two of them compete for one wallet's dust coins. Observed after
  # an aborted run: a batcher 10 min stale and a provisioning process 83 min
  # stale, still burning CPU. Patterns are bracketed and this runs from a script
  # file, so neither matches the driver's own argv.
  for pat in 'packages/batcher/[b]atcher.ts' '[p]rovision-batcher-dust.ts' 'grand-e2e/[r]un.ts'; do
    for pid in $(pgrep -f "$pat" 2>/dev/null); do
      say "reaping orphan $pid ($pat)"; kill "$pid" 2>/dev/null
    done
  done
  sleep 3

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
    [[ $attempt == 3 ]] && { say "stack would not bootstrap; see $OUT/stack.log"; exit 1; }
  done
fi

for i in $(seq 120); do
  curl -s --max-time 3 http://127.0.0.1:3334/health 2>/dev/null | grep -q '"isRunning":true' && break
  sleep 5
done
say "batcher: $(curl -s --max-time 3 http://127.0.0.1:3334/health)"

say "provisioning 20 fat NIGHT UTXOs for the batcher (post-registration)"
bun run "$HERE/provision-batcher-dust.ts" 20 > "$OUT/dust-provision.log" 2>&1
say "provisioning exit $? — $(grep -aE 'sent|done|UTXO' "$OUT/dust-provision.log" | tail -1)"

say "restarting the batcher so it re-scans its UTXO set"
curl -s -X POST --max-time 20 -H 'content-type: application/json' \
  -d '{"name":"batcher"}' http://127.0.0.1:4747/restart >/dev/null
for i in $(seq 60); do
  curl -s --max-time 3 http://127.0.0.1:3334/health 2>/dev/null | grep -q '"isRunning":true' && break
  sleep 5
done
say "batcher slots: $(grep -ao 'worker slots: .*' "$OUT/stack.log" | tail -1)"

say "running the suite"
GRAND_OFFERS=${GRAND_OFFERS:-25} \
GRAND_STORM_API=${GRAND_STORM_API:-200} \
GRAND_STORM_CELESTIA=${GRAND_STORM_CELESTIA:-30} \
  bun run "$HERE/run.ts" 2>&1 | tee "$OUT/grand-v3.log"
say "suite exited with ${PIPESTATUS[0]}"
