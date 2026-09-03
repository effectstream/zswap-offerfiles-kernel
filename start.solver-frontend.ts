/**
 * `bun run start:solver-frontend` — the ONE documented way to run the COW
 * solver's read-only monitor site (00007 FR-008).
 *
 * This is a single process and it trades nothing. It holds no wallet, no seed
 * and no journal; it opens no relay socket; and it has no route that mutates
 * anything, here or upstream. It reads three sources — the solver's status
 * listener, the kernel's Offer Files API, and the relay's public `GET /tokens`
 * — and serves one page plus `/api/snapshot` and `/api/stream`.
 *
 * It deliberately does NOT depend on the solver being up. A monitor that dies
 * with the process it monitors is useless at the only moment anyone opens it,
 * so a solver that never answers is a rendered state ("SOLVER UNREACHABLE",
 * with the time it was last seen), not a startup failure.
 *
 * Every boundary is resolved and validated before the listener binds, and a
 * startup missing or malformed values exits non-zero with ONE message listing
 * every problem at once — the same contract `start.solver.ts` follows, so the
 * Compose `restart` loop cannot mask a half-configured monitor.
 *
 * Required: SOLVER_FRONTEND_SOLVER_STATUS_URL, SOLVER_FRONTEND_SOLVER_STATUS_TOKEN
 * (the solver's SOLVER_STATUS_AUTH_TOKEN — sent as a Bearer to the solver and
 * never to the browser), SOLVER_FRONTEND_ZSWAP_API.
 * Optional: SOLVER_FRONTEND_HOST (default 127.0.0.1), SOLVER_FRONTEND_PORT
 * (default 8080), SOLVER_FRONTEND_RELAY_HTTP_URL, SOLVER_FRONTEND_POLL_MS
 * (default 4000), SOLVER_FRONTEND_HISTORY_LIMIT (default 500).
 */
import {
  describeFrontendConfig,
  FrontendConfigError,
  resolveFrontendConfig,
  type FrontendConfig,
} from "./packages/solver-frontend/env.ts";
import { startFrontendServer } from "./packages/solver-frontend/server.ts";

let config: FrontendConfig;
try {
  config = resolveFrontendConfig();
} catch (error) {
  if (error instanceof FrontendConfigError) {
    // The operator needs the list, not a stack trace.
    console.error(`[solver-frontend] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

console.log(describeFrontendConfig(config));

let site: ReturnType<typeof startFrontendServer>;
try {
  site = startFrontendServer(config, { log: (message) => console.error(message) });
} catch (error) {
  // A boundary that can only be discovered by trying — an occupied port — is
  // reported in the SAME shape as a missing variable, so an operator reads one
  // kind of message either way.
  console.error(
    `[solver-frontend] ${new FrontendConfigError([
      `could not bind ${config.host}:${config.port} — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    ]).message}`,
  );
  process.exit(1);
}

console.log(`[solver-frontend] listening on http://${site.host}:${site.port}`);

let stopping = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) {
    console.error(`[solver-frontend] second ${signal} received — forcing shutdown`);
    process.exit(1);
  }
  stopping = true;
  console.log(`[solver-frontend] ${signal} received — stopping`);
  try {
    site.stop();
  } catch (error) {
    console.error("[solver-frontend] shutdown failed", error);
    process.exit(1);
  }
  process.exit(0);
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
