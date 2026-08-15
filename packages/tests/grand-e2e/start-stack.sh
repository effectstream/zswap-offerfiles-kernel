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

# The dev batcher bootstraps five registered NIGHT outputs and refuses to
# become ready until all five backing dust streams can pay a fee. Keep the cap
# equal to that proved resource count. Higher caps only add proof-server/CPU
# pressure; they do not create more spendable coins.
export BATCHER_MAX_SLOTS_PER_WALLET="${BATCHER_MAX_SLOTS_PER_WALLET:-5}"

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
    if grep -qa "Shutting down: " "$LOG"; then
      echo "BOOTSTRAP FAILED: $(grep -a 'exited with code' "$LOG" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
      exit 2
    fi
    curl -s --max-time 5 http://127.0.0.1:9999/v1/health | grep -q '"status":"ok"' && { echo "STACK READY"; exit 0; }
  fi
  grep -qa "Shutting down: " "$LOG" && {
    echo "BOOTSTRAP FAILED: $(grep -a 'exited with code' "$LOG" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
    exit 2
  }
done
echo "TIMEOUT waiting for bootstrap"; exit 1
