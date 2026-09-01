/**
 * The explicit solver launch surface (FR-005 / 00003 `P4-F05`).
 *
 * `start.solver.ts` (root script `start:solver`) is the ONE documented way to
 * run the solver as its own process, and this module is the whole of its
 * configuration contract: it resolves every mandatory boundary of that process
 * up front, aggregates EVERY problem into one error, and hands the entrypoint a
 * fully normalized config. Nothing here starts, opens, or dials anything.
 *
 * Why an entrypoint-level resolver when `runSolver` already validates:
 *
 * - `runSolver` throws on the FIRST missing value, after it has already loaded
 *   the ladder file and (for the journal) touched the filesystem. An operator
 *   bringing up a Compose service wants one message naming everything that is
 *   wrong, before any resource is acquired.
 * - Several boundaries have silent defaults that are safe for a developer and
 *   wrong for a deployment: `MIDNIGHT_NETWORK_ID` unset means `undeployed`
 *   (`@effectstream/midnight-contracts/midnight-env`), `ZSWAP_API` unset means
 *   `http://127.0.0.1:9999`, and `SOLVER_SEED` unset means the repository's
 *   public dev seed. A deployment must state all three.
 * - The solver must NOT be reachable from `start:mainnet` (adding it there
 *   would turn a backend command into a trading command — 00003 `P5-D02`), so
 *   the launch contract has to live in its own entrypoint.
 *
 * Deliberate decisions:
 *
 * 1. The relay WS + HTTP URLs, the relay token, and the journal path are
 *    mandatory **even in dry-run**. A dry-run process opens no relay socket, so
 *    it could technically start without them — but then half of a deployment's
 *    configuration would go unvalidated in exactly the mode operators use as a
 *    rehearsal, and promoting it to live would be the first time the values are
 *    checked. FR-005 asks for one topology, not two.
 * 2. Dry-run DEFAULTS to true on `mainnet` (same boundary `solver.mainnet.ts`
 *    enforces) and to false elsewhere, and live mainnet additionally requires
 *    the exact `SOLVER_MAINNET_LIVE_TRADING_ACK=true`. This entrypoint must
 *    never be an easier route to live mainnet trading than the hardened
 *    mainnet entrypoint it generalizes.
 * 3. The repository dev seed is accepted ONLY on `undeployed`. Every other
 *    network requires an explicitly supplied seed.
 */
import { getEnv } from "@effectstream/utils/runtime";

import {
  DEFAULT_SOLVER_LADDER_CONFIG,
  DEV_SEED,
  loadSolverJournalEnv,
  parseBooleanEnv,
  parseHttpBaseUrl,
  type SolverJournalEnv,
} from "../env.ts";

export type EnvReader = (name: string) => string | undefined;

/** The network ids `midnight-env` resolves. Anything else is a typo that would
 * otherwise be treated as a deployed network with generated URLs. */
export const SOLVER_NETWORK_IDS = [
  "undeployed",
  "devnet",
  "testnet",
  "qanet",
  "preview",
  "preprod",
  "mainnet",
] as const;

export type SolverNetworkId = (typeof SOLVER_NETWORK_IDS)[number];

export interface SolverLaunchConfig {
  networkId: SolverNetworkId;
  /** Kernel (Offer Files) REST/SSE base, normalized without a trailing slash. */
  api: string;
  relayWsUrl: string;
  /** Public relay HTTP base for durable `GET /jobs/:jobId`, normalized. */
  relayHttpUrl: string;
  relayAuthToken: string;
  journal: SolverJournalEnv;
  seed: string;
  dryRun: boolean;
  ladderConfigPath: string;
  /** Non-fatal observations the entrypoint prints. Never a reason to refuse. */
  warnings: readonly string[];
}

export interface SolverLaunchOptions {
  read?: EnvReader;
  /**
   * The network id the Midnight SDK actually selected (`midnightNetworkConfig.id`).
   * Passed by the entrypoint so a value this module rejects — or one it accepts
   * while the SDK resolved something else — is reported instead of silently
   * running against a different network than the operator declared.
   */
  resolvedNetworkId?: string;
}

/** Every problem found in one pass, so one restart shows the operator all of
 * them. `problems` is the machine-readable form of `message`. */
export class SolverLaunchConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `solver launch configuration is invalid (${problems.length} ` +
        `problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nThe solver refuses to start on a partial trading configuration. " +
        "See README.md → \"Running the solver\".",
    );
    this.name = "SolverLaunchConfigError";
    this.problems = [...problems];
  }
}

const CANONICAL_SEED = /^[0-9a-f]{64}$/;

const isCanonicalScalar = (raw: string): boolean =>
  raw.length > 0 && raw.trim() === raw && !raw.includes("\0");

const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** ws/wss, no embedded credentials, no fragment. A path and a query are left
 * alone: deployed relays are reached at a path (`/solver`) and some front doors
 * carry a query, and this module must not invent a stricter wire contract than
 * the relay's. */
const parseRelayWsUrl = (name: string, raw: string): string => {
  if (!isCanonicalScalar(raw)) {
    throw new Error(`${name} must be a non-empty canonical ws(s) URL without whitespace or NUL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute ws:// or wss:// URL`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`${name} must use ws:// or wss://, got ${JSON.stringify(parsed.protocol)}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${name} must not embed credentials; use SOLVER_RELAY_AUTH_TOKEN`);
  }
  if (parsed.hash !== "") {
    throw new Error(`${name} must not contain a fragment`);
  }
  return parsed.toString();
};

/**
 * Resolve the launch configuration or throw one `SolverLaunchConfigError`
 * listing every problem. Side-effect free: it reads environment values and
 * parses them, and touches no file, socket, or wallet.
 */
export function resolveSolverLaunchConfig(
  options: SolverLaunchOptions = {},
): SolverLaunchConfig {
  const read = options.read ?? getEnv;
  const problems: string[] = [];
  const warnings: string[] = [];

  // ── network ────────────────────────────────────────────────────────────────
  const rawNetwork = read("MIDNIGHT_NETWORK_ID");
  let networkId: SolverNetworkId | null = null;
  if (rawNetwork === undefined || rawNetwork === "") {
    problems.push(
      "MIDNIGHT_NETWORK_ID is required: the SDK silently defaults to " +
        `"undeployed", so a deployment must declare its network explicitly ` +
        `(one of ${SOLVER_NETWORK_IDS.join(", ")})`,
    );
  } else if (!(SOLVER_NETWORK_IDS as readonly string[]).includes(rawNetwork)) {
    problems.push(
      `MIDNIGHT_NETWORK_ID must be one of ${SOLVER_NETWORK_IDS.join(", ")}, ` +
        `got ${JSON.stringify(rawNetwork)} (an unknown value is treated as a ` +
        "deployed network with generated indexer/node URLs)",
    );
  } else {
    networkId = rawNetwork as SolverNetworkId;
    if (options.resolvedNetworkId !== undefined && options.resolvedNetworkId !== networkId) {
      problems.push(
        `MIDNIGHT_NETWORK_ID=${networkId} but the Midnight SDK resolved ` +
          `${JSON.stringify(options.resolvedNetworkId)}; refusing to run against ` +
          "a different network than the one declared",
      );
    }
  }

  // ── kernel API ─────────────────────────────────────────────────────────────
  let api = "";
  const rawApi = read("ZSWAP_API");
  if (rawApi === undefined || rawApi === "") {
    problems.push(
      "ZSWAP_API is required: the kernel Offer Files REST/SSE base " +
        "(it otherwise defaults to http://127.0.0.1:9999, which is a developer " +
        "default, not a deployment one)",
    );
  } else {
    try {
      api = parseHttpBaseUrl("ZSWAP_API", rawApi);
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  // ── relay boundary ─────────────────────────────────────────────────────────
  let relayWsUrl = "";
  const rawWs = read("SOLVER_RELAY_WS_URL");
  if (rawWs === undefined || rawWs === "") {
    problems.push("SOLVER_RELAY_WS_URL is required: the outbound Midnight Intents solver socket");
  } else {
    try {
      relayWsUrl = parseRelayWsUrl("SOLVER_RELAY_WS_URL", rawWs);
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  let relayHttpUrl = "";
  const rawHttp = read("SOLVER_RELAY_HTTP_URL");
  if (rawHttp === undefined || rawHttp === "") {
    problems.push(
      "SOLVER_RELAY_HTTP_URL is required: the relay's public HTTP base for " +
        "durable GET /jobs/:jobId recovery. It is never derived from the " +
        "websocket URL — a deployed HTTP prefix may differ (for example /api/v1)",
    );
  } else {
    try {
      relayHttpUrl = parseHttpBaseUrl("SOLVER_RELAY_HTTP_URL", rawHttp);
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  const rawToken = read("SOLVER_RELAY_AUTH_TOKEN");
  let relayAuthToken = "";
  if (rawToken === undefined || rawToken === "") {
    problems.push(
      "SOLVER_RELAY_AUTH_TOKEN is required: the shared relay bearer (the relay " +
        "deployment calls the same secret SOLVER_AUTH_TOKEN). The kernel " +
        "exact-files read is deliberately unauthenticated",
    );
  } else if (!isCanonicalScalar(rawToken)) {
    problems.push("SOLVER_RELAY_AUTH_TOKEN must not contain surrounding whitespace or NUL bytes");
  } else if (rawToken.length < 32) {
    problems.push(
      `SOLVER_RELAY_AUTH_TOKEN must be at least 32 characters (the relay refuses ` +
        `shorter tokens); got ${rawToken.length}`,
    );
  } else {
    relayAuthToken = rawToken;
  }

  // ── durable journal ────────────────────────────────────────────────────────
  let journal: SolverJournalEnv | null = null;
  try {
    journal = loadSolverJournalEnv(read, {
      relayExecutionEnabled: true,
      runtimeMode: "production",
    });
  } catch (error) {
    problems.push(asMessage(error));
  }

  // ── dry-run / live acknowledgement ─────────────────────────────────────────
  // Mainnet defaults to dry-run exactly as solver.mainnet.ts does, so this
  // generalized entrypoint cannot become the cheaper route to live trading.
  const mainnet = networkId === "mainnet";
  let dryRun = mainnet;
  try {
    dryRun = parseBooleanEnv("SOLVER_DRY_RUN", read("SOLVER_DRY_RUN"), mainnet);
  } catch (error) {
    problems.push(asMessage(error));
  }
  if (mainnet && !dryRun) {
    let acknowledged = false;
    try {
      acknowledged = parseBooleanEnv(
        "SOLVER_MAINNET_LIVE_TRADING_ACK",
        read("SOLVER_MAINNET_LIVE_TRADING_ACK"),
        false,
      );
    } catch (error) {
      problems.push(asMessage(error));
    }
    if (!acknowledged) {
      problems.push(
        "live mainnet settlement requires the exact " +
          "SOLVER_MAINNET_LIVE_TRADING_ACK=true alongside SOLVER_DRY_RUN=false",
      );
    }
  }

  // ── wallet seed ────────────────────────────────────────────────────────────
  const rawSeed = read("SOLVER_SEED");
  let seed = "";
  if (rawSeed === undefined || rawSeed === "") {
    problems.push(
      "SOLVER_SEED is required: an unset seed silently selects the " +
        "repository's public dev seed, which anyone can drain",
    );
  } else if (!isCanonicalScalar(rawSeed)) {
    problems.push("SOLVER_SEED must not contain surrounding whitespace or NUL bytes");
  } else if (rawSeed === DEV_SEED && networkId !== "undeployed") {
    problems.push(
      "SOLVER_SEED is the repository's public dev seed, which is accepted only " +
        `on MIDNIGHT_NETWORK_ID=undeployed (declared: ${networkId ?? "unset"})`,
    );
  } else {
    seed = rawSeed;
    if (!CANONICAL_SEED.test(rawSeed)) {
      // A warning, not a refusal: the wallet facade owns the seed grammar, and
      // this entrypoint must not invent a narrower one than it accepts.
      warnings.push(
        "SOLVER_SEED is not 64 lowercase hex characters — the wallet facade will " +
          "decide whether it is usable; check for a truncated or quoted secret",
      );
    }
    if (rawSeed === DEV_SEED) {
      warnings.push(
        "SOLVER_SEED is the repository's public dev seed (allowed on undeployed only)",
      );
    }
  }

  const ladderConfigPath = read("SOLVER_LADDER_CONFIG") ?? DEFAULT_SOLVER_LADDER_CONFIG;
  if (read("SOLVER_LADDER_CONFIG") === undefined) {
    warnings.push(
      `SOLVER_LADDER_CONFIG is unset — using the in-repo dev ladder file ` +
        `${DEFAULT_SOLVER_LADDER_CONFIG}`,
    );
  }

  if (problems.length > 0 || networkId === null || journal === null) {
    // networkId/journal being null always coincides with a recorded problem;
    // the check keeps that invariant explicit rather than assumed.
    throw new SolverLaunchConfigError(
      problems.length > 0 ? problems : ["solver launch configuration could not be resolved"],
    );
  }

  return {
    networkId,
    api,
    relayWsUrl,
    relayHttpUrl,
    relayAuthToken,
    journal,
    seed,
    dryRun,
    ladderConfigPath,
    warnings,
  };
}

/**
 * The startup banner. Deliberately prints no secret: the seed never appears in
 * any form, and the relay bearer only as its length.
 */
export function describeSolverLaunchConfig(config: SolverLaunchConfig): string {
  const lines = [
    `[solver] launch topology (start:solver, single process)`,
    `  network        : ${config.networkId}`,
    `  mode           : ${config.dryRun ? "DRY-RUN (no relay jobs, no wallet mutation)" : "LIVE relay job execution"}`,
    `  kernel api     : ${config.api}`,
    `  relay ws       : ${config.relayWsUrl}`,
    `  relay http     : ${config.relayHttpUrl}`,
    `  relay token    : set (${config.relayAuthToken.length} chars)`,
    `  journal        : ${config.journal.path}`,
    `  ladder config  : ${config.ladderConfigPath}`,
    `  seed           : set (never logged)`,
  ];
  for (const warning of config.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}
