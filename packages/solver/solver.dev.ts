/**
 * Dev-stack solver: mirrors the local node's book and fills against posted
 * ladders. Requires MIDNIGHT_NETWORK_ID=undeployed and a running `bun run dev`
 * (node API on ZSWAP_API, Intents socket on SOLVER_RELAY_WS_URL).
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { isSolverEnabled } from "./env.ts";
import { runSolver } from "./src/run.ts";
import { startWithSignalOwnership } from "./src/startup-signals.ts";

if (net.id !== "undeployed") {
  throw new Error(`solver.dev.ts requires MIDNIGHT_NETWORK_ID=undeployed, got "${net.id}"`);
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
