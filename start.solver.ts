/**
 * `bun run start:solver` — the ONE documented way to run the COW solver as its
 * own component (FR-005 / 00003 `P4-F05`).
 *
 * This is a single process. It launches no orchestrator, no kernel, no batcher
 * and no chain service: the solver is a separate component that attaches to an
 * already-running kernel API and Midnight Intents relay. That is also why the
 * solver is deliberately ABSENT from `start.mainnet.ts` (`bun run start:mainnet`
 * brings up pglite/midnight/sync/batcher only): adding it there would turn a
 * backend command into a trading command with no explicit acknowledgement.
 *
 * Every mandatory boundary is resolved and validated before any resource is
 * acquired — see `packages/solver/src/launch.ts` for the contract and the
 * reasons each value is mandatory. A missing or malformed value exits non-zero
 * with one message listing every problem at once, so the Compose service
 * `restart: on-failure` loop cannot mask a half-configured solver.
 *
 * Required: MIDNIGHT_NETWORK_ID, ZSWAP_API, SOLVER_RELAY_WS_URL,
 * SOLVER_RELAY_HTTP_URL, SOLVER_RELAY_AUTH_TOKEN, SOLVER_JOURNAL_PATH,
 * SOLVER_SEED. Mainnet additionally defaults to dry-run and requires
 * SOLVER_MAINNET_LIVE_TRADING_ACK=true for live settlement.
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { isSolverEnabled } from "./packages/solver/env.ts";
import {
  describeSolverLaunchConfig,
  resolveSolverLaunchConfig,
  SolverLaunchConfigError,
  type SolverLaunchConfig,
} from "./packages/solver/src/launch.ts";
import { runSolver } from "./packages/solver/src/run.ts";
import { startWithSignalOwnership } from "./packages/solver/src/startup-signals.ts";

// An intentionally disabled service must not have to satisfy the full trading
// configuration to report that it is disabled. Note the value grammar is still
// canonical: a typo is a startup failure, never a silent "enabled".
if (!isSolverEnabled()) {
  console.log("[solver] SOLVER_ENABLED=false — exiting without starting");
  process.exit(0);
}

let config: SolverLaunchConfig;
try {
  config = resolveSolverLaunchConfig({ resolvedNetworkId: net.id });
} catch (error) {
  if (error instanceof SolverLaunchConfigError) {
    // The operator needs the list, not a stack trace.
    console.error(`[solver] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

console.log(describeSolverLaunchConfig(config));

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

await startWithSignalOwnership(
  (signal) =>
    runSolver({
      // Everything this entrypoint validated is passed explicitly, so the
      // running process cannot disagree with the banner it just printed. The
      // journal is the one exception: `runSolver` reads SOLVER_JOURNAL_PATH
      // itself through the production path (`journalOptions` is a test-only
      // seam), and the launch resolver validated the same variable with the
      // same parser before we got here.
      api: config.api,
      seed: config.seed,
      dryRun: config.dryRun,
      relayUrl: config.relayWsUrl,
      relayHttpUrl: config.relayHttpUrl,
      relayAuthToken: config.relayAuthToken,
      ladderConfigPath: config.ladderConfigPath,
      signal,
    }),
  {
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
  },
);
