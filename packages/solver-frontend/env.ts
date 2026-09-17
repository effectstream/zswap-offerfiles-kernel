/**
 * The monitor site's whole configuration contract (00007 FR-009).
 *
 * Deliberately the same SHAPE as `packages/solver/src/launch.ts`: resolve every
 * boundary up front, aggregate EVERY problem into one error, and hand the
 * entrypoint a normalized config. An operator bringing up the Compose service
 * must see one message naming everything that is wrong — a service under
 * `restart: unless-stopped` that fails one variable at a time turns a five
 * second fix into five restarts.
 *
 * Nothing here opens a socket, reads a file, or dials anything.
 *
 * THE ONE SECRET. `SOLVER_FRONTEND_SOLVER_STATUS_TOKEN` is the bearer for the
 * solver's `/status/*` routes. It is mandatory (the solver refuses to serve
 * `/status/*` without one — Q-S-3) and it must never leave this process: it is
 * absent from `/api/snapshot`, from `/api/stream`, from the page, and from the
 * startup banner, which prints its LENGTH exactly as the solver's own banner
 * prints the relay bearer's. `server.test.ts` asserts this by grepping every
 * response body for the configured value.
 *
 * The ≥ 32-character rule is copied from `SOLVER_STATUS_AUTH_TOKEN` on purpose:
 * a token the solver would refuse can never authenticate, so catching it here
 * turns a silent forever-401 (which the page would render as "solver
 * unreachable") into a startup problem naming the variable.
 */
import { SOLVER_STATUS_MIN_TOKEN_LENGTH } from "@zswap-da/solver-core/status-contract";

export type EnvReader = (name: string) => string | undefined;

export interface FrontendConfig {
  /** Interface the page listens on. Loopback by default. */
  host: string;
  port: number;
  /** Solver status listener base (no trailing slash). `/status/stream` and
   *  `/status/snapshot` are appended; nothing else is ever requested. */
  solverStatusUrl: string;
  /** FR-009: sent as `Authorization: Bearer` to the solver and NOWHERE else. */
  solverStatusToken: string;
  /** Kernel Offer Files REST base (no trailing slash). */
  zswapApi: string;
  /** Relay public HTTP base, or null when the deployment has no relay to read.
   *  `GET /tokens` is the only relay route this service knows. */
  relayHttpUrl: string | null;
  pollMs: number;
  /** Bounded transition history the server keeps (FR-010). */
  historyLimit: number;
  /** Non-fatal observations the entrypoint prints. Never a reason to refuse. */
  warnings: readonly string[];
}

/** Every problem found in one pass, so one restart shows the operator all of
 *  them. `problems` is the machine-readable form of `message`. */
export class FrontendConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `solver-frontend configuration is invalid (${problems.length} ` +
        `problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nThe monitor refuses to start half-configured: a site that silently " +
        "cannot reach the solver looks exactly like a solver that is down. " +
        'See packages/solver-frontend/README.md.',
    );
    this.name = "FrontendConfigError";
    this.problems = [...problems];
  }
}

export const DEFAULT_FRONTEND_PORT = 8080;
export const DEFAULT_FRONTEND_HOST = "127.0.0.1";
export const DEFAULT_FRONTEND_POLL_MS = 4_000;
export const DEFAULT_FRONTEND_HISTORY_LIMIT = 500;

/** Poll bounds. Below the floor the monitor becomes load on the kernel; above
 *  the ceiling "N s ago" stops meaning anything. */
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 300_000;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 5_000;

const isCanonicalScalar = (raw: string): boolean =>
  raw.length > 0 && raw.trim() === raw && !raw.includes("\0");

const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * http/https, no embedded credentials, no fragment, no query, no trailing
 * slash. Credentials are refused rather than stripped: a URL carrying a
 * password would otherwise reach the page inside an error string.
 */
export function parseHttpBase(name: string, raw: string): string {
  if (!isCanonicalScalar(raw)) {
    throw new Error(`${name} must be a non-empty URL without surrounding whitespace or NUL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http:// or https:// URL, got ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http:// or https://, got ${JSON.stringify(parsed.protocol)}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${name} must not embed credentials`);
  }
  if (parsed.hash !== "") throw new Error(`${name} must not contain a fragment`);
  if (parsed.search !== "") throw new Error(`${name} must not contain a query string`);
  return parsed.toString().replace(/\/+$/, "");
}

function parseBoundedInteger(
  name: string,
  raw: string,
  min: number,
  max: number,
): number {
  if (!isCanonicalScalar(raw) || !/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a plain non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

export interface FrontendConfigOptions {
  read?: EnvReader;
}

/**
 * Resolve the configuration or throw one `FrontendConfigError` listing every
 * problem. Side-effect free.
 */
export function resolveFrontendConfig(options: FrontendConfigOptions = {}): FrontendConfig {
  const read = options.read ?? ((name: string) => process.env[name]);
  const problems: string[] = [];
  const warnings: string[] = [];

  // ── listener ───────────────────────────────────────────────────────────────
  let port = DEFAULT_FRONTEND_PORT;
  const rawPort = read("SOLVER_FRONTEND_PORT");
  if (rawPort !== undefined && rawPort !== "") {
    try {
      port = parseBoundedInteger("SOLVER_FRONTEND_PORT", rawPort, 1, 65_535);
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  let host = DEFAULT_FRONTEND_HOST;
  const rawHost = read("SOLVER_FRONTEND_HOST");
  if (rawHost !== undefined && rawHost !== "") {
    if (!isCanonicalScalar(rawHost)) {
      problems.push(
        "SOLVER_FRONTEND_HOST must be a non-empty host without surrounding whitespace or NUL",
      );
    } else {
      host = rawHost;
      // 0.0.0.0 is what the Compose service sets so the published port reaches
      // it; a warning, not a refusal, but the page is unauthenticated and must
      // be fronted by the host's proxy if it leaves a private network.
      if (host !== DEFAULT_FRONTEND_HOST && host !== "localhost" && host !== "::1") {
        warnings.push(
          `SOLVER_FRONTEND_HOST=${host} is not loopback — this page has no ` +
            "authentication of its own; publish it to a private network or put a " +
            "reverse proxy in front of it (README → Security posture)",
        );
      }
    }
  }

  // ── solver status listener ────────────────────────────────────────────────
  let solverStatusUrl = "";
  const rawStatusUrl = read("SOLVER_FRONTEND_SOLVER_STATUS_URL");
  if (rawStatusUrl === undefined || rawStatusUrl === "") {
    problems.push(
      "SOLVER_FRONTEND_SOLVER_STATUS_URL is required: the solver's read-only " +
        "status listener base (the solver serves it when SOLVER_STATUS_PORT is set). " +
        "Without it there is nothing to monitor",
    );
  } else {
    try {
      solverStatusUrl = parseHttpBase("SOLVER_FRONTEND_SOLVER_STATUS_URL", rawStatusUrl);
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  let solverStatusToken = "";
  const rawToken = read("SOLVER_FRONTEND_SOLVER_STATUS_TOKEN");
  if (rawToken === undefined || rawToken === "") {
    problems.push(
      "SOLVER_FRONTEND_SOLVER_STATUS_TOKEN is required: the solver's " +
        "SOLVER_STATUS_AUTH_TOKEN, sent as a Bearer on every /status/* request. " +
        "It is never sent to the browser",
    );
  } else if (!isCanonicalScalar(rawToken)) {
    problems.push(
      "SOLVER_FRONTEND_SOLVER_STATUS_TOKEN must not contain surrounding whitespace or NUL bytes",
    );
  } else if (rawToken.length < SOLVER_STATUS_MIN_TOKEN_LENGTH) {
    problems.push(
      `SOLVER_FRONTEND_SOLVER_STATUS_TOKEN must be at least ${SOLVER_STATUS_MIN_TOKEN_LENGTH} ` +
        "characters — the solver refuses to start with a shorter " +
        `SOLVER_STATUS_AUTH_TOKEN, so a shorter value here can only ever 401; got ${rawToken.length}`,
    );
  } else {
    solverStatusToken = rawToken;
  }

  // ── kernel ─────────────────────────────────────────────────────────────────
  let zswapApi = "";
  const rawApi = read("SOLVER_FRONTEND_ZSWAP_API");
  if (rawApi === undefined || rawApi === "") {
    problems.push(
      "SOLVER_FRONTEND_ZSWAP_API is required: the kernel Offer Files REST base " +
        "(/v1/health/sync, /v1/offers, /v1/known-tokens, /v1/pairs). The page " +
        "must keep rendering the book while the solver is down, so this is not " +
        "derived from the solver's own configuration",
    );
  } else {
    try {
      zswapApi = parseHttpBase("SOLVER_FRONTEND_ZSWAP_API", rawApi);
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  // ── relay (optional) ───────────────────────────────────────────────────────
  let relayHttpUrl: string | null = null;
  const rawRelay = read("SOLVER_FRONTEND_RELAY_HTTP_URL");
  if (rawRelay !== undefined && rawRelay !== "") {
    try {
      relayHttpUrl = parseHttpBase("SOLVER_FRONTEND_RELAY_HTTP_URL", rawRelay);
    } catch (error) {
      problems.push(asMessage(error));
    }
  } else {
    warnings.push(
      "SOLVER_FRONTEND_RELAY_HTTP_URL is unset — the Relay panel will say " +
        "'not configured' instead of listing the tokens the relay advertises",
    );
  }

  // ── cadence and history ────────────────────────────────────────────────────
  let pollMs = DEFAULT_FRONTEND_POLL_MS;
  const rawPoll = read("SOLVER_FRONTEND_POLL_MS");
  if (rawPoll !== undefined && rawPoll !== "") {
    try {
      pollMs = parseBoundedInteger("SOLVER_FRONTEND_POLL_MS", rawPoll, MIN_POLL_MS, MAX_POLL_MS);
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  let historyLimit = DEFAULT_FRONTEND_HISTORY_LIMIT;
  const rawHistory = read("SOLVER_FRONTEND_HISTORY_LIMIT");
  if (rawHistory !== undefined && rawHistory !== "") {
    try {
      historyLimit = parseBoundedInteger(
        "SOLVER_FRONTEND_HISTORY_LIMIT",
        rawHistory,
        MIN_HISTORY_LIMIT,
        MAX_HISTORY_LIMIT,
      );
    } catch (error) {
      problems.push(asMessage(error));
    }
  }

  if (problems.length > 0) throw new FrontendConfigError(problems);

  return {
    host,
    port,
    solverStatusUrl,
    solverStatusToken,
    zswapApi,
    relayHttpUrl,
    pollMs,
    historyLimit,
    warnings,
  };
}

/**
 * The startup banner. The status bearer prints as a length, exactly as the
 * solver's own banner prints the relay bearer.
 */
export function describeFrontendConfig(config: FrontendConfig): string {
  const lines = [
    "[solver-frontend] read-only monitor (start:solver-frontend, single process)",
    `  listening      : http://${config.host}:${config.port}`,
    `  solver status  : ${config.solverStatusUrl} (bearer set, ${config.solverStatusToken.length} chars)`,
    `  kernel api     : ${config.zswapApi}`,
    `  relay http     : ${config.relayHttpUrl ?? "not configured"}`,
    `  poll interval  : ${config.pollMs} ms`,
    `  history limit  : ${config.historyLimit} transitions`,
  ];
  for (const warning of config.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}
