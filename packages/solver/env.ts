import { getEnv } from "@effectstream/utils/runtime";

// Dev seed. Must avoid every other wallet on the dev stack — genesis, the
// batcher's (…0003/…0004), and the ring-maker range (…0005+) — because two
// facades on one seed against one node force each other's connection down.
export const DEV_SEED = "0000000000000000000000000000000000000000000000000000000000000021";

export const SOLVER_SEED = getEnv("SOLVER_SEED") ?? DEV_SEED;

/** Identifies this solver's ladders to the node. Stable across restarts so a
 *  restart replaces its own prices rather than adding a second set. */
export const SOLVER_ID = getEnv("SOLVER_ID") ?? `solver-${SOLVER_SEED.slice(-8)}`;

export const ZSWAP_API = getEnv("ZSWAP_API") ?? "http://127.0.0.1:9999";
export const BATCHER_SUBMIT_URL = getEnv("BATCHER_SUBMIT_URL") ?? "http://127.0.0.1:3334";

export const SOLVER_LADDER_CONFIG =
  getEnv("SOLVER_LADDER_CONFIG") ??
  new URL("./config/ladders.dev.json", import.meta.url).pathname;

/** Longest crossing cycle the engine will enumerate. 2 is a straight A↔B
 *  cross; 3 adds a→b→c→a rings. */
export const SOLVER_MAX_CYCLE_LEN = parseInt(getEnv("SOLVER_MAX_CYCLE_LEN") ?? "3");

/** The stream has no replay, so a missed event is permanent until the next full
 *  page-through. */
export const SOLVER_RESYNC_INTERVAL_MS = parseInt(
  getEnv("SOLVER_RESYNC_INTERVAL_MS") ?? "300000",
);

/** How long before an offer's stated expiry the solver stops touching it.
 *  `expiresAt` is a floor, and a shielded offer really dies when its proof's
 *  Merkle root leaves the chain's root window — so leave room for a settlement
 *  that starts near the boundary. */
export const SOLVER_EXPIRY_MARGIN_SECONDS = parseInt(
  getEnv("SOLVER_EXPIRY_MARGIN_SECONDS") ?? "120",
);

export const SOLVER_SETTLE_TTL_MINUTES = parseInt(
  getEnv("SOLVER_SETTLE_TTL_MINUTES") ?? "30",
);

export const SOLVER_LEVELS_PUSH_INTERVAL_MS = parseInt(
  getEnv("SOLVER_LEVELS_PUSH_INTERVAL_MS") ?? "5000",
);

export const SOLVER_STATUS_POLL_MS = parseInt(getEnv("SOLVER_STATUS_POLL_MS") ?? "5000");

/** Mirror the book and log every decision, but never build or submit a
 *  transaction. Safe to point at any environment. */
export const isDryRun = (): boolean =>
  (getEnv("SOLVER_DRY_RUN") ?? "false").toLowerCase() === "true";

export const isSolverEnabled = (): boolean =>
  (getEnv("SOLVER_ENABLED") ?? "true").toLowerCase() !== "false";
