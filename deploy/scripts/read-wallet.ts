// read-wallet.ts — report (and optionally assert) one wallet's balances.
//
// This exists for the one balance the E2E driver cannot read itself: the
// SOLVER's. The solver service holds a live facade on SOLVER_SEED, and two
// facades on one seed against one Midnight node force each other's connection
// down — so the driver records the solver deltas it EXPECTS and this script
// checks them once the solver container is stopped.
//
//   docker compose stop solver
//   docker compose run --rm --no-deps \
//     -e READ_SEED="$SOLVER_SEED" \
//     -e EXPECT_SHIELDED='{"<color>":"1000100000"}' \
//     --entrypoint bun scripts run deploy/scripts/read-wallet.ts
//
// Env:
//   READ_SEED         the seed to open (REQUIRED)
//   EXPECT_SHIELDED   optional JSON {color: amount}; every listed color must
//                     match EXACTLY or the script exits 1
//   EXPECT_SHIELDED_ONLY
//                     optional "true": in addition, NO unlisted color may hold
//                     a non-zero balance. This is what turns the gate from
//                     "the expected deltas landed" into "and the wallet holds
//                     nothing else" — the decisive on-chain evidence for
//                     00006 SC-004 that the solver was never provisioned any
//                     token. A solver minted the usual 1e9 of each would fail
//                     it by nine orders of magnitude, whatever any receipt or
//                     configuration file claimed.
//   OUT_FILE          optional path to write the JSON report to
//
// Exit 0 = read (and every expectation held).

import { writeFileSync } from "node:fs";

import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import {
  buildWallet,
  shieldedBalances,
  unshieldedBalances,
  waitForSync,
} from "../../packages/solver-core/wallet.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

const log = (msg: string) => console.log(`[read-wallet] ${msg}`);

const seed = process.env["READ_SEED"] ?? "";
if (!/^[0-9a-f]{64}$/.test(seed)) {
  log("READ_SEED must be a 64-hex seed");
  process.exit(78);
}

const wallet = await buildWallet(seed);
let exitCode = 0;
try {
  await waitForSync(wallet);
  const shielded = await shieldedBalances(wallet);
  const unshielded = await unshieldedBalances(wallet);
  const report = {
    seedSuffix: seed.slice(-4),
    network: net.id,
    shielded: Object.fromEntries(Object.entries(shielded).map(([k, v]) => [k, String(v)])),
    unshielded: Object.fromEntries(Object.entries(unshielded).map(([k, v]) => [k, String(v)])),
  };
  log(JSON.stringify(report, null, 2));

  const expectRaw = process.env["EXPECT_SHIELDED"] ?? "";
  const checks: Array<{ color: string; expected: string; actual: string; ok: boolean }> = [];
  if (expectRaw.trim()) {
    const expected = JSON.parse(expectRaw) as Record<string, string>;
    for (const [color, want] of Object.entries(expected)) {
      const actual = String(shielded[color] ?? 0n);
      const ok = actual === String(want);
      checks.push({ color, expected: String(want), actual, ok });
      log(`${ok ? "PASS" : "FAIL"} shielded[${color.slice(0, 12)}…] expected ${want}, got ${actual}`);
      if (!ok) exitCode = 1;
    }
    if (process.env["EXPECT_SHIELDED_ONLY"] === "true") {
      const listed = new Set(Object.keys(expected));
      const unexpected = Object.entries(shielded).filter(
        ([color, amount]) => !listed.has(color) && amount !== 0n,
      );
      const ok = unexpected.length === 0;
      checks.push({
        color: "(no unlisted color)",
        expected: "none",
        actual: unexpected.map(([c, v]) => `${c.slice(0, 12)}…=${v}`).join(",") || "none",
        ok,
      });
      log(
        `${ok ? "PASS" : "FAIL"} the wallet holds NOTHING beyond the listed colors` +
          (ok ? "" : `: ${unexpected.map(([c, v]) => `${c}=${v}`).join(", ")}`),
      );
      if (!ok) exitCode = 1;
    }
  }

  const outFile = process.env["OUT_FILE"] ?? "";
  if (outFile) {
    writeFileSync(outFile, `${JSON.stringify({ ...report, checks }, null, 2)}\n`);
    log(`wrote ${outFile}`);
  }
} catch (err) {
  log(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  exitCode = 1;
} finally {
  await (wallet.wallet as never as { stop?: () => Promise<void> }).stop?.().catch(() => {});
}
process.exit(exitCode);
