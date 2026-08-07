/**
 * Dev-stack solver: mirrors the local node's book and fills against posted
 * ladders. Requires MIDNIGHT_NETWORK_ID=undeployed and a running `bun run dev`
 * (node API on ZSWAP_API, batcher on BATCHER_SUBMIT_URL).
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { isSolverEnabled } from "./env.ts";
import { runSolver } from "./src/run.ts";

if (net.id !== "undeployed") {
  throw new Error(`solver.dev.ts requires MIDNIGHT_NETWORK_ID=undeployed, got "${net.id}"`);
}

if (!isSolverEnabled()) {
  console.log("[solver] SOLVER_ENABLED=false — exiting without starting");
  process.exit(0);
}

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

const handle = await runSolver();
await handle.ready;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.stop().then(() => process.exit(0));
  });
}
