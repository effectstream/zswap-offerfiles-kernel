/**
 * The three fixture sources, as long-lived listeners, for a BROWSER session.
 *
 *   bun run packages/solver-frontend/test-helpers/serve-fixture.ts
 *
 * It prints the environment for `bun run start:solver-frontend` and then keeps
 * serving until interrupted. `SOLVER_FRONTEND_FIXTURE_STATE` selects which of
 * the states the design has to render:
 *
 *   quoting     (default) everything healthy, two pairs on the wire
 *   withdrawn   the solver withdrew DELIBERATELY (P-A's `withdrawn`)
 *   blocked     the fail-closed withdrawal (`cache-not-current`)
 *   relay-down  the relay socket is gone; the ladder is not on the wire
 *   dry-run     no relay client and no executor exist
 *   unreachable the status listener is not started at all
 *
 * This is a TEST HELPER. It serves invented data and is never part of a
 * deployment: the Compose service runs `start.solver-frontend.ts` against the
 * real solver.
 */
import {
  buildStatusSnapshot,
  startFakeKernel,
  startFakeRelay,
  startFakeSolver,
} from "./fixtures.ts";

const state = process.env["SOLVER_FRONTEND_FIXTURE_STATE"] ?? "quoting";
const token = process.env["SOLVER_FRONTEND_FIXTURE_TOKEN"] ?? "fixture-status-bearer-long-enough-0123456789";
const solverPort = Number(process.env["SOLVER_FRONTEND_FIXTURE_SOLVER_PORT"] ?? 19100);
const kernelPort = Number(process.env["SOLVER_FRONTEND_FIXTURE_KERNEL_PORT"] ?? 19101);
const relayPort = Number(process.env["SOLVER_FRONTEND_FIXTURE_RELAY_PORT"] ?? 19102);

const snapshotFor = (at: number) => {
  switch (state) {
    case "withdrawn":
      return buildStatusSnapshot({ now: at, withheld: "withdrawn" });
    case "blocked":
      return buildStatusSnapshot({ now: at, withheld: "cache-not-current", blockedReason: "backend-syncing" });
    case "relay-down":
      return buildStatusSnapshot({ now: at, connected: false });
    case "dry-run":
      return buildStatusSnapshot({ now: at, mode: "dry-run" });
    default:
      return buildStatusSnapshot({ now: at, quarantined: 0 });
  }
};

const kernel = startFakeKernel({ prices: true, decimals: 6, port: kernelPort });
const relay = startFakeRelay(undefined, relayPort);
const solver =
  state === "unreachable"
    ? null
    : startFakeSolver({ token, port: solverPort, snapshot: snapshotFor(Date.now()) });

// Republish on a cadence so the page's "N s ago" and its SSE feed are exercised
// rather than frozen on one frame.
const timer = setInterval(() => solver?.publish(snapshotFor(Date.now())), 2000);

process.on("SIGINT", () => {
  clearInterval(timer);
  solver?.stop();
  kernel.stop();
  relay.stop();
  process.exit(0);
});

console.log(
  [
    `[fixture] state=${state}`,
    `[fixture] solver status : ${solver === null ? `http://127.0.0.1:${solverPort} (NOT started)` : solver.url}`,
    `[fixture] kernel api    : ${kernel.url}`,
    `[fixture] relay http    : ${relay.url}`,
    "",
    "Run the site against it with:",
    `  SOLVER_FRONTEND_SOLVER_STATUS_URL=http://127.0.0.1:${solverPort} \\`,
    `  SOLVER_FRONTEND_SOLVER_STATUS_TOKEN=${token} \\`,
    `  SOLVER_FRONTEND_ZSWAP_API=${kernel.url} \\`,
    `  SOLVER_FRONTEND_RELAY_HTTP_URL=${relay.url} \\`,
    "  bun run start:solver-frontend",
  ].join("\n"),
);
