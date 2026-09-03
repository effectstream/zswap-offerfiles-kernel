// The monitor's configuration contract (00007 SC-002, FR-009).
//
// The property that matters most here is the AGGREGATION: a half-configured
// Compose service must print every problem in one message, because a service
// under `restart: unless-stopped` that reports one variable per restart turns a
// five-second fix into five restarts. Every "missing" test below therefore
// asserts the whole list, not just that it threw.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FRONTEND_HISTORY_LIMIT,
  DEFAULT_FRONTEND_HOST,
  DEFAULT_FRONTEND_POLL_MS,
  DEFAULT_FRONTEND_PORT,
  describeFrontendConfig,
  FrontendConfigError,
  resolveFrontendConfig,
} from "./env.ts";

const TOKEN = "s".repeat(48);

const read = (values: Record<string, string | undefined>) => (name: string) => values[name];

const complete = {
  SOLVER_FRONTEND_SOLVER_STATUS_URL: "http://solver:9100",
  SOLVER_FRONTEND_SOLVER_STATUS_TOKEN: TOKEN,
  SOLVER_FRONTEND_ZSWAP_API: "http://kernel:9999",
};

const problemsOf = (values: Record<string, string | undefined>): string[] => {
  try {
    resolveFrontendConfig({ read: read(values) });
  } catch (error) {
    if (error instanceof FrontendConfigError) return [...error.problems];
    throw error;
  }
  throw new Error("expected resolveFrontendConfig to throw");
};

describe("resolveFrontendConfig", () => {
  test("resolves the minimal configuration with documented defaults", () => {
    const config = resolveFrontendConfig({ read: read(complete) });
    expect(config.host).toBe(DEFAULT_FRONTEND_HOST);
    expect(config.port).toBe(DEFAULT_FRONTEND_PORT);
    expect(config.pollMs).toBe(DEFAULT_FRONTEND_POLL_MS);
    expect(config.historyLimit).toBe(DEFAULT_FRONTEND_HISTORY_LIMIT);
    expect(config.relayHttpUrl).toBeNull();
    expect(config.solverStatusUrl).toBe("http://solver:9100");
    expect(config.zswapApi).toBe("http://kernel:9999");
    // The relay is optional, but a deployment without it loses a panel and is
    // told so rather than left to wonder.
    expect(config.warnings.join(" ")).toContain("SOLVER_FRONTEND_RELAY_HTTP_URL");
  });

  test("lists EVERY problem at once when nothing is configured", () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("SOLVER_FRONTEND_SOLVER_STATUS_URL is required");
    expect(problems.join("\n")).toContain("SOLVER_FRONTEND_SOLVER_STATUS_TOKEN is required");
    expect(problems.join("\n")).toContain("SOLVER_FRONTEND_ZSWAP_API is required");
  });

  test("aggregates malformed values alongside missing ones", () => {
    const problems = problemsOf({
      SOLVER_FRONTEND_SOLVER_STATUS_URL: "solver:9100",
      SOLVER_FRONTEND_SOLVER_STATUS_TOKEN: "short",
      SOLVER_FRONTEND_PORT: "70000",
      SOLVER_FRONTEND_POLL_MS: "10",
      SOLVER_FRONTEND_HISTORY_LIMIT: "0",
      SOLVER_FRONTEND_RELAY_HTTP_URL: "ftp://relay",
    });
    expect(problems).toHaveLength(7);
    const joined = problems.join("\n");
    // `solver:9100` PARSES as a URL whose protocol is `solver:` — the scheme
    // check is what catches a host:port that forgot its scheme.
    expect(joined).toContain('SOLVER_FRONTEND_SOLVER_STATUS_URL must use http:// or https://, got "solver:"');
    expect(joined).toContain("SOLVER_FRONTEND_SOLVER_STATUS_TOKEN must be at least 32");
    expect(joined).toContain("SOLVER_FRONTEND_PORT must be between 1 and 65535");
    expect(joined).toContain("SOLVER_FRONTEND_POLL_MS must be between 250");
    expect(joined).toContain("SOLVER_FRONTEND_HISTORY_LIMIT must be between 1");
    expect(joined).toContain("SOLVER_FRONTEND_RELAY_HTTP_URL must use http:// or https://");
    expect(joined).toContain("SOLVER_FRONTEND_ZSWAP_API is required");
  });

  test("the error message carries the whole list, not just the first problem", () => {
    try {
      resolveFrontendConfig({ read: read({}) });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(FrontendConfigError);
      const message = (error as FrontendConfigError).message;
      expect(message).toContain("(3 problems)");
      expect(message).toContain("SOLVER_FRONTEND_SOLVER_STATUS_URL");
      expect(message).toContain("SOLVER_FRONTEND_ZSWAP_API");
    }
  });

  test("a token the SOLVER would refuse is a startup problem, not a silent 401", () => {
    // The solver refuses SOLVER_STATUS_AUTH_TOKEN under 32 characters, so a
    // shorter value here could only ever 401 — which the page would render as
    // "solver unreachable" forever.
    const problems = problemsOf({ ...complete, SOLVER_FRONTEND_SOLVER_STATUS_TOKEN: "x".repeat(31) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("at least 32 characters");
    expect(problems[0]).toContain("got 31");
  });

  test("a value that is not a URL at all is named as such", () => {
    expect(problemsOf({ ...complete, SOLVER_FRONTEND_ZSWAP_API: "not a url" })[0])
      .toContain("must be an absolute http:// or https:// URL");
  });

  test("refuses a status URL with embedded credentials, a fragment or a query", () => {
    expect(problemsOf({ ...complete, SOLVER_FRONTEND_SOLVER_STATUS_URL: "http://u:p@solver:9100" })[0])
      .toContain("must not embed credentials");
    expect(problemsOf({ ...complete, SOLVER_FRONTEND_SOLVER_STATUS_URL: "http://solver:9100#x" })[0])
      .toContain("must not contain a fragment");
    expect(problemsOf({ ...complete, SOLVER_FRONTEND_SOLVER_STATUS_URL: "http://solver:9100?x=1" })[0])
      .toContain("must not contain a query string");
  });

  test("normalizes trailing slashes so route joining cannot double them", () => {
    const config = resolveFrontendConfig({
      read: read({
        ...complete,
        SOLVER_FRONTEND_SOLVER_STATUS_URL: "http://solver:9100///",
        SOLVER_FRONTEND_ZSWAP_API: "http://kernel:9999/",
        SOLVER_FRONTEND_RELAY_HTTP_URL: "http://relay:3000/",
      }),
    });
    expect(config.solverStatusUrl).toBe("http://solver:9100");
    expect(config.zswapApi).toBe("http://kernel:9999");
    expect(config.relayHttpUrl).toBe("http://relay:3000");
  });

  test("refuses whitespace and NUL in the token", () => {
    expect(problemsOf({ ...complete, SOLVER_FRONTEND_SOLVER_STATUS_TOKEN: ` ${TOKEN} ` })[0])
      .toContain("surrounding whitespace");
    expect(problemsOf({ ...complete, SOLVER_FRONTEND_SOLVER_STATUS_TOKEN: `${TOKEN}\0` })[0])
      .toContain("surrounding whitespace or NUL");
  });

  test("a non-loopback listen host is a warning, never a refusal (Compose sets 0.0.0.0)", () => {
    const config = resolveFrontendConfig({
      read: read({ ...complete, SOLVER_FRONTEND_HOST: "0.0.0.0" }),
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.warnings.join(" ")).toContain("is not loopback");
  });

  test("accepts the full configuration and applies every override", () => {
    const config = resolveFrontendConfig({
      read: read({
        ...complete,
        SOLVER_FRONTEND_HOST: "127.0.0.1",
        SOLVER_FRONTEND_PORT: "18080",
        SOLVER_FRONTEND_RELAY_HTTP_URL: "http://relay:3000",
        SOLVER_FRONTEND_POLL_MS: "1500",
        SOLVER_FRONTEND_HISTORY_LIMIT: "42",
      }),
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 18080,
      relayHttpUrl: "http://relay:3000",
      pollMs: 1500,
      historyLimit: 42,
    });
    expect(config.warnings).toHaveLength(0);
  });

  test("rejects a non-integer poll interval rather than coercing it", () => {
    expect(problemsOf({ ...complete, SOLVER_FRONTEND_POLL_MS: "4000.5" })[0])
      .toContain("must be a plain non-negative integer");
  });
});

describe("describeFrontendConfig", () => {
  test("prints the bearer's LENGTH and never its value (FR-006 discipline)", () => {
    const config = resolveFrontendConfig({
      read: read({ ...complete, SOLVER_FRONTEND_RELAY_HTTP_URL: "http://relay:3000" }),
    });
    const banner = describeFrontendConfig(config);
    expect(banner).toContain("bearer set, 48 chars");
    expect(banner).not.toContain(TOKEN);
    expect(banner).toContain("http://solver:9100");
    expect(banner).toContain("http://kernel:9999");
  });

  test("names an unconfigured relay rather than printing an empty field", () => {
    const banner = describeFrontendConfig(resolveFrontendConfig({ read: read(complete) }));
    expect(banner).toContain("relay http     : not configured");
    expect(banner).toContain("! SOLVER_FRONTEND_RELAY_HTTP_URL is unset");
  });
});
