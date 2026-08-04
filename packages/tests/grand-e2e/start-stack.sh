#!/usr/bin/env bash
# Start a fresh stack and block until bootstrap has genuinely finished.
#
# `/v1/health` goes ok long before the stack is usable: the one-shot bootstrap
# jobs (contract deploy, mint-test-tokens, celestia-fund-bridge) are still
# running, and the orchestrator tears the WHOLE stack down if any of them exits
# non-zero. Waiting on health alone means starting work against a stack that is
# about to disappear underneath it.
set -uo pipefail
cd "$(dirname "$0")/../../.."
LOG=packages/tests/grand-e2e/out/stack.log

# The batcher's concurrency cap is read from the environment at startup and
# defaults to 1 — one in-flight settlement at a time, whatever the UTXO count.
# It must be exported HERE, before the orchestrator spawns the batcher, because
# the batcher inherits the orchestrator's environment; setting it later (or on
# a /restart call) has no effect. See NIGHT-UTXO provisioning in fresh-run.sh:
# slots = min(dust coins / cost, cap), so both halves are needed.
export BATCHER_MAX_SLOTS_PER_WALLET="${BATCHER_MAX_SLOTS_PER_WALLET:-100}"

# The suite asserts against these two windows (config.ts), and the node only
# reads them at startup. Without them the node uses its per-network defaults
# (3600s), and the run fails four checks that look unrelated: p1's
# `ttl_seconds=600`, and three p4 root checks — see the ROOT_UNKNOWN note in
# p4-adversarial.ts for why a wide window makes the "foreign" fixture pass.
export ROOT_WINDOW_SECONDS="${ROOT_WINDOW_SECONDS:-600}"
export OFFER_TTL_SECONDS="${OFFER_TTL_SECONDS:-600}"
NODE_ENV=development nohup bunx orchestrator start > "$LOG" 2>&1 &
echo "orchestrator pid $!"

for i in $(seq 300); do
  sleep 5
  if grep -qa "All processes launched. Orchestrator is running" "$LOG"; then
    if grep -qa "Shutting down: Process" "$LOG"; then
      echo "BOOTSTRAP FAILED: $(grep -a 'exited with code' "$LOG" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
      exit 2
    fi
    curl -s --max-time 5 http://127.0.0.1:9999/v1/health | grep -q '"status":"ok"' && { echo "STACK READY"; exit 0; }
  fi
  grep -qa "Shutting down: Process" "$LOG" && {
    echo "BOOTSTRAP FAILED: $(grep -a 'exited with code' "$LOG" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
    exit 2
  }
done
echo "TIMEOUT waiting for bootstrap"; exit 1
