/**
 * Preview-network solver.
 *
 * Requires MIDNIGHT_NETWORK_ID=preview, SOLVER_SEED set to a funded wallet, and
 * ZSWAP_API / SOLVER_RELAY_WS_URL pointed at the preview deployment. The node's
 * per-IP budget applies here (no allowlist off-host), so the book mirror leans
 * on the SSE stream rather than polling.
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { isSolverEnabled } from "./env.ts";
import { runSolver } from "./src/run.ts";
import { startWithSignalOwnership } from "./src/startup-signals.ts";

if (net.id !== "preview") {
  throw new Error(`solver.preview.ts requires MIDNIGHT_NETWORK_ID=preview, got "${net.id}"`);
}

if (!isSolverEnabled()) {
  console.log("[solver] SOLVER_ENABLED=false — exiting without starting");
  process.exit(0);
}

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

await startWithSignalOwnership((signal) => runSolver({ signal }), {
  onSecondSignal: (signal) => {
    console.error(`[solver] second ${signal} received — forcing shutdown`);
    process.exit(1);
  },
  onSignalHandled: ({ signal, stopError }) => {
    if (stopError !== undefined) {
      console.error(`[solver] ${signal} shutdown failed`, stopError);
      process.exit(1);
    }
    process.exit(0);
  },
});
