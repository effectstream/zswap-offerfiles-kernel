/**
 * Mainnet solver — real funds.
 *
 * Requires MIDNIGHT_NETWORK_ID=mainnet, SOLVER_SEED set to a funded wallet, and
 * ZSWAP_API / BATCHER_SUBMIT_URL pointed at the mainnet deployment. Start with
 * SOLVER_DRY_RUN=true first, but note that current dry-run does not load wallet
 * inventory and therefore cannot validate Path-A admission. A controlled
 * staging rehearsal is still required before any live acknowledgement.
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import {
  DEV_SEED,
  isDryRun,
  isMainnetLiveTradingAcknowledged,
  isSolverEnabled,
  SOLVER_SEED,
} from "./env.ts";
import { runSolver } from "./src/run.ts";
import { startWithSignalOwnership } from "./src/startup-signals.ts";

if (net.id !== "mainnet") {
  throw new Error(`solver.mainnet.ts requires MIDNIGHT_NETWORK_ID=mainnet, got "${net.id}"`);
}

// The dev default is a well-known seed checked into this repo. Reaching mainnet
// with it would put real funds in a wallet anyone can drain.
const dryRun = isDryRun(true);
if (!dryRun && SOLVER_SEED === DEV_SEED) {
  throw new Error("solver.mainnet.ts: SOLVER_SEED is unset or the dev seed — refusing to run");
}

if (!dryRun && !isMainnetLiveTradingAcknowledged()) {
  throw new Error(
    "solver.mainnet.ts: live trading requires SOLVER_MAINNET_LIVE_TRADING_ACK=true",
  );
}

if (!isSolverEnabled()) {
  console.log("[solver] SOLVER_ENABLED=false — exiting without starting");
  process.exit(0);
}

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

await startWithSignalOwnership((signal) => runSolver({ dryRun, signal }), {
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
