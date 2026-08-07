/**
 * Mainnet solver — real funds.
 *
 * Requires MIDNIGHT_NETWORK_ID=mainnet, SOLVER_SEED set to a funded wallet, and
 * ZSWAP_API / BATCHER_SUBMIT_URL pointed at the mainnet deployment. Start with
 * SOLVER_DRY_RUN=true and read a few rounds of decisions before letting it
 * settle anything.
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { DEV_SEED, isSolverEnabled, SOLVER_SEED } from "./env.ts";
import { runSolver } from "./src/run.ts";

if (net.id !== "mainnet") {
  throw new Error(`solver.mainnet.ts requires MIDNIGHT_NETWORK_ID=mainnet, got "${net.id}"`);
}

// The dev default is a well-known seed checked into this repo. Reaching mainnet
// with it would put real funds in a wallet anyone can drain.
if (SOLVER_SEED === DEV_SEED) {
  throw new Error("solver.mainnet.ts: SOLVER_SEED is unset or the dev seed — refusing to run");
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
