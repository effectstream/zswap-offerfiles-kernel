/**
 * Mainnet solver — real funds.
 *
 * Requires MIDNIGHT_NETWORK_ID=mainnet, SOLVER_SEED set to a funded wallet, and
 * ZSWAP_API / SOLVER_RELAY_WS_URL pointed at the mainnet deployment. Start with
 * SOLVER_DRY_RUN=true first: dry-run syncs the real wallet and loads read-only
 * inventory while starting no relay jobs. A controlled staging rehearsal is
 * still required before any live acknowledgement.
 */
import {
  midnightNetworkConfig as net,
  redactBlockfrostProjectId,
} from "@effectstream/midnight-contracts/midnight-env";
import { installLogRedaction } from "../offer-guard/public-networks.ts";

import {
  DEV_SEED,
  isDryRun,
  isMainnetLiveTradingAcknowledged,
  isSolverEnabled,
  SOLVER_SEED,
} from "./env.ts";
import { runSolver } from "./src/run.ts";
import { assertNoRetiredSolverPricingEnv } from "./src/launch.ts";
import { startWithSignalOwnership } from "./src/startup-signals.ts";

// The wallet SDK's RPC client logs the node URL it loses, query string
// included; on a public network that URL carries the Blockfrost project token.
installLogRedaction(redactBlockfrostProjectId);

if (net.id !== "mainnet") {
  throw new Error(`solver.mainnet.ts requires MIDNIGHT_NETWORK_ID=mainnet, got "${net.id}"`);
}

// The dev default is a well-known seed checked into this repo. Reaching mainnet
// with it would put real funds in a wallet anyone can drain.
const dryRun = isDryRun(true);
if (SOLVER_SEED === DEV_SEED) {
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

// Validate retired pricing settings before any wallet or network side effect.
assertNoRetiredSolverPricingEnv();

globalThis.WebSocket = WebSocket;

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
