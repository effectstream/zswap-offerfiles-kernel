/**
 * FR-005 (00003 `P4-F05`) — the explicit solver launch surface.
 *
 * These tests pin the configuration contract of `bun run start:solver`: what is
 * mandatory, what is normalized, what is refused, and that a refusal names
 * EVERY problem in one pass instead of failing on the first one. The last two
 * tests drive the real root entrypoint as a child process, so the wiring
 * between `start.solver.ts` and this resolver is covered too, not just the
 * resolver in isolation.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  describeSolverLaunchConfig,
  resolveSolverLaunchConfig,
  SolverLaunchConfigError,
  SOLVER_NETWORK_IDS,
} from "./src/launch.ts";
import { DEV_SEED } from "./env.ts";

const REAL_SEED = "1".repeat(64);
const TOKEN = "a".repeat(32);

/** A complete, valid local-dev environment. Individual tests remove or replace
 * exactly one key so a failure names one cause. */
const complete = (): Record<string, string> => ({
  MIDNIGHT_NETWORK_ID: "undeployed",
  ZSWAP_API: "http://kernel:9999",
  SOLVER_RELAY_WS_URL: "ws://relay:8080/solver",
  SOLVER_RELAY_HTTP_URL: "http://relay:8080/api/v1",
  SOLVER_RELAY_AUTH_TOKEN: TOKEN,
  SOLVER_JOURNAL_PATH: "/var/lib/cow-solver/operations.sqlite",
  SOLVER_SEED: REAL_SEED,
  SOLVER_LADDER_CONFIG: "/etc/cow-solver/ladders.json",
});

const reader = (env: Record<string, string>) => (name: string): string | undefined => env[name];

const resolveWith = (env: Record<string, string>) =>
  resolveSolverLaunchConfig({ read: reader(env) });

const problemsOf = (env: Record<string, string>, resolvedNetworkId?: string): string[] => {
  try {
    resolveSolverLaunchConfig({
      read: reader(env),
      ...(resolvedNetworkId === undefined ? {} : { resolvedNetworkId }),
    });
  } catch (error) {
    expect(error).toBeInstanceOf(SolverLaunchConfigError);
    return [...(error as SolverLaunchConfigError).problems];
  }
  throw new Error("expected the configuration to be refused");
};

const namesOne = (problems: string[], variable: string): void => {
  const matching = problems.filter((problem) => problem.includes(variable));
  expect(matching.length).toBe(1);
};

describe("FR-005 solver launch configuration", () => {
  test("an empty environment names every mandatory boundary at once", () => {
    const problems = problemsOf({});
    // One restart must be enough for an operator to see the whole list.
    for (const variable of [
      "MIDNIGHT_NETWORK_ID",
      "ZSWAP_API",
      "SOLVER_RELAY_WS_URL",
      "SOLVER_RELAY_HTTP_URL",
      "SOLVER_RELAY_AUTH_TOKEN",
      "SOLVER_JOURNAL_PATH",
      "SOLVER_SEED",
    ]) {
      namesOne(problems, variable);
    }
    expect(problems.length).toBe(7);
  });

  test("a complete local-dev environment resolves and normalizes", () => {
    const config = resolveWith(complete());
    expect(config).toEqual({
      networkId: "undeployed",
      api: "http://kernel:9999",
      relayWsUrl: "ws://relay:8080/solver",
      relayHttpUrl: "http://relay:8080/api/v1",
      relayAuthToken: TOKEN,
      journal: { path: "/var/lib/cow-solver/operations.sqlite", allowMemory: false },
      seed: REAL_SEED,
      dryRun: false,
      ladderConfigPath: "/etc/cow-solver/ladders.json",
      // 00006 FR-001: optional, but resolved and reported like everything else.
      feeSizingTakerInputs: 1,
      // 00007 FR-001: no SOLVER_STATUS_PORT means no listener at all. This
      // assertion is the SC-001 "unset = zero behaviour change" contract at the
      // configuration layer.
      status: null,
      warnings: [],
    });
  });

  // 00006 FR-001 / Q-R0-1 (option A). The knob is optional, so its DEFAULT must
  // not be a launch problem — but a malformed value must be a listed problem
  // alongside the others, not a crash inside `runSolver` after the wallet is up.
  test("the fee-sizing taker-input knob is optional, bounded, and listed when malformed", () => {
    expect(resolveWith(complete()).feeSizingTakerInputs).toBe(1);
    expect(resolveWith({ ...complete(), SOLVER_FEE_SIZING_TAKER_INPUTS: "3" })
      .feeSizingTakerInputs).toBe(3);

    for (const raw of ["0", "-1", "1.5", "many", "65"]) {
      const problems = problemsOf({ ...complete(), SOLVER_FEE_SIZING_TAKER_INPUTS: raw });
      namesOne(problems, "SOLVER_FEE_SIZING_TAKER_INPUTS");
      // Still ONE pass over everything: a bad knob does not mask a bad seed.
      expect(problemsOf({
        ...complete(), SOLVER_FEE_SIZING_TAKER_INPUTS: raw, SOLVER_SEED: "",
      }).length).toBe(2);
    }
  });

  test("the banner states the fee-sizing model and its coverage", () => {
    const banner = describeSolverLaunchConfig(
      resolveWith({ ...complete(), SOLVER_FEE_SIZING_TAKER_INPUTS: "2" }),
    );
    expect(banner).toContain("models 2 taker input(s)");
    expect(banner).toContain("up to 4");
    expect(banner).toContain("SOLVER_FEE_SIZING_TAKER_INPUTS");
  });

  test("HTTP bases are canonicalized identically for the kernel and the relay", () => {
    const config = resolveWith({
      ...complete(),
      ZSWAP_API: "http://kernel:9999/",
      SOLVER_RELAY_HTTP_URL: "https://relay.example/api/v1/",
    });
    expect(config.api).toBe("http://kernel:9999");
    expect(config.relayHttpUrl).toBe("https://relay.example/api/v1");
  });

  test("the banner prints the topology and no secret", () => {
    const banner = describeSolverLaunchConfig(resolveWith(complete()));
    expect(banner).toContain("network        : undeployed");
    expect(banner).toContain("LIVE relay job execution");
    expect(banner).toContain("http://kernel:9999");
    expect(banner).toContain("relay token    : set (32 chars)");
    expect(banner).toContain("seed           : set (never logged)");
    expect(banner).not.toContain(REAL_SEED);
    expect(banner).not.toContain(TOKEN);
  });

  test("an unset ladder file is a warning, not a refusal", () => {
    const env = complete();
    delete env["SOLVER_LADDER_CONFIG"];
    const config = resolveWith(env);
    expect(config.ladderConfigPath).toContain("ladders.dev.json");
    expect(config.warnings.some((w) => w.includes("SOLVER_LADDER_CONFIG is unset"))).toBe(true);
  });
});

describe("FR-005 network declaration", () => {
  test("every id midnight-env resolves is accepted", () => {
    for (const networkId of SOLVER_NETWORK_IDS) {
      const env = { ...complete(), MIDNIGHT_NETWORK_ID: networkId, SOLVER_DRY_RUN: "true" };
      expect(resolveWith(env).networkId).toBe(networkId);
    }
  });

  test("an unknown network id is refused instead of becoming a generated deployment", () => {
    const problems = problemsOf({ ...complete(), MIDNIGHT_NETWORK_ID: "mainnett" });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("MIDNIGHT_NETWORK_ID must be one of");
  });

  test("a declared network that disagrees with the SDK's resolved one is refused", () => {
    const problems = problemsOf({ ...complete(), MIDNIGHT_NETWORK_ID: "preview" }, "undeployed");
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("the Midnight SDK resolved");
  });

  test("agreement between the declared and resolved network passes", () => {
    const config = resolveSolverLaunchConfig({
      read: reader(complete()),
      resolvedNetworkId: "undeployed",
    });
    expect(config.networkId).toBe("undeployed");
  });
});

describe("FR-005 boundary grammars", () => {
  test("the kernel API must be a canonical credential-free HTTP base", () => {
    expect(problemsOf({ ...complete(), ZSWAP_API: "kernel" })[0])
      .toContain("ZSWAP_API must be an absolute HTTP(S) URL");
    // Parses as a URL, but its scheme is "kernel:" — caught by the protocol rule.
    expect(problemsOf({ ...complete(), ZSWAP_API: "kernel:9999" })[0])
      .toContain("ZSWAP_API must use http/https");
    expect(problemsOf({ ...complete(), ZSWAP_API: "http://u:p@kernel:9999" })[0])
      .toContain("no credentials, query, or fragment");
    expect(problemsOf({ ...complete(), ZSWAP_API: "http://kernel:9999?x=1" })[0])
      .toContain("no credentials, query, or fragment");
  });

  test("the relay socket must be ws(s) and must not carry credentials", () => {
    expect(problemsOf({ ...complete(), SOLVER_RELAY_WS_URL: "http://relay:8080" })[0])
      .toContain("must use ws:// or wss://");
    expect(problemsOf({ ...complete(), SOLVER_RELAY_WS_URL: "wss://u:p@relay/solver" })[0])
      .toContain("must not embed credentials");
    expect(problemsOf({ ...complete(), SOLVER_RELAY_WS_URL: "wss://relay/solver#frag" })[0])
      .toContain("must not contain a fragment");
    // A path and a query are the relay's business, not this entrypoint's.
    expect(resolveWith({ ...complete(), SOLVER_RELAY_WS_URL: "wss://relay/solver?v=1" }).relayWsUrl)
      .toBe("wss://relay/solver?v=1");
  });

  test("the relay bearer must be at least the 32 characters the relay enforces", () => {
    const problems = problemsOf({ ...complete(), SOLVER_RELAY_AUTH_TOKEN: "a".repeat(31) });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("at least 32 characters");
    expect(resolveWith({ ...complete(), SOLVER_RELAY_AUTH_TOKEN: "a".repeat(32) }).relayAuthToken)
      .toBe("a".repeat(32));
  });

  test("the journal must be an absolute path, and :memory: stays impossible", () => {
    expect(problemsOf({ ...complete(), SOLVER_JOURNAL_PATH: "operations.sqlite" })[0])
      .toContain("must be an absolute mounted-volume path");
    expect(problemsOf({ ...complete(), SOLVER_JOURNAL_PATH: ":memory:" })[0])
      .toContain("requires SOLVER_JOURNAL_ALLOW_MEMORY=true in an explicit test harness");
    // Even with the harness flag: this entrypoint declares runtimeMode=production.
    expect(problemsOf({
      ...complete(),
      SOLVER_JOURNAL_PATH: ":memory:",
      SOLVER_JOURNAL_ALLOW_MEMORY: "true",
    })[0]).toContain("explicit test harness");
  });

  test("a non-canonical boolean is a listed problem, not a crash", () => {
    const problems = problemsOf({ ...complete(), SOLVER_DRY_RUN: "TRUE" });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("SOLVER_DRY_RUN");
  });

  test("problems accumulate across independent boundaries", () => {
    const malformed = {
      MIDNIGHT_NETWORK_ID: "undeployed",
      ZSWAP_API: "nope",
      SOLVER_RELAY_WS_URL: "http://relay",
      SOLVER_RELAY_HTTP_URL: "http://relay/api//v1",
      SOLVER_RELAY_AUTH_TOKEN: "short",
      SOLVER_JOURNAL_PATH: "relative.sqlite",
      SOLVER_SEED: DEV_SEED,
      SOLVER_LADDER_CONFIG: "/etc/l.json",
    };
    const problems = problemsOf(malformed);
    for (const variable of [
      "ZSWAP_API",
      "SOLVER_RELAY_WS_URL",
      "SOLVER_RELAY_HTTP_URL",
      "SOLVER_RELAY_AUTH_TOKEN",
      "SOLVER_JOURNAL_PATH",
    ]) {
      namesOne(problems, variable);
    }
    // Five malformed values, and the dev seed is legal on undeployed.
    expect(problems.length).toBe(5);
    // The same environment on a deployed network adds exactly the seed problem.
    const deployed = problemsOf({ ...malformed, MIDNIGHT_NETWORK_ID: "preview" });
    expect(deployed.length).toBe(6);
    namesOne(deployed, "public dev seed");
  });
});

describe("FR-005 seed policy", () => {
  test("the repository dev seed is accepted only on undeployed", () => {
    const dev = resolveWith({ ...complete(), SOLVER_SEED: DEV_SEED });
    expect(dev.seed).toBe(DEV_SEED);
    expect(dev.warnings.some((w) => w.includes("public dev seed"))).toBe(true);

    for (const networkId of ["preview", "preprod", "testnet", "mainnet"] as const) {
      const problems = problemsOf({
        ...complete(),
        MIDNIGHT_NETWORK_ID: networkId,
        SOLVER_DRY_RUN: "true",
        SOLVER_SEED: DEV_SEED,
      });
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain("public dev seed");
    }
  });

  test("a seed that is not 64 lowercase hex is a warning, not a refusal", () => {
    const config = resolveWith({ ...complete(), SOLVER_SEED: "abandon abandon about" });
    expect(config.seed).toBe("abandon abandon about");
    expect(config.warnings.some((w) => w.includes("64 lowercase hex"))).toBe(true);
  });

  test("a padded seed is refused rather than silently trimmed", () => {
    const problems = problemsOf({ ...complete(), SOLVER_SEED: ` ${REAL_SEED} ` });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("whitespace or NUL");
  });
});

describe("FR-005 mainnet safety boundary", () => {
  const mainnetEnv = (): Record<string, string> => ({
    ...complete(),
    MIDNIGHT_NETWORK_ID: "mainnet",
    ZSWAP_API: "https://api.example",
    SOLVER_RELAY_WS_URL: "wss://relay.example/solver",
    SOLVER_RELAY_HTTP_URL: "https://relay.example/api/v1",
  });

  test("mainnet defaults to dry-run, exactly as solver.mainnet.ts does", () => {
    expect(resolveWith(mainnetEnv()).dryRun).toBe(true);
  });

  test("live mainnet requires the explicit acknowledgement", () => {
    const problems = problemsOf({ ...mainnetEnv(), SOLVER_DRY_RUN: "false" });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("SOLVER_MAINNET_LIVE_TRADING_ACK=true");

    const refusedFalse = problemsOf({
      ...mainnetEnv(),
      SOLVER_DRY_RUN: "false",
      SOLVER_MAINNET_LIVE_TRADING_ACK: "false",
    });
    expect(refusedFalse.length).toBe(1);
  });

  test("live mainnet with the acknowledgement resolves in live mode", () => {
    const config = resolveWith({
      ...mainnetEnv(),
      SOLVER_DRY_RUN: "false",
      SOLVER_MAINNET_LIVE_TRADING_ACK: "true",
    });
    expect(config.dryRun).toBe(false);
    expect(config.networkId).toBe("mainnet");
  });

  test("a non-mainnet network defaults to live mode and needs no acknowledgement", () => {
    const config = resolveWith({ ...complete(), MIDNIGHT_NETWORK_ID: "preview" });
    expect(config.dryRun).toBe(false);
  });

  test("dry-run still requires the whole relay and journal wiring", () => {
    const env = mainnetEnv();
    delete env["SOLVER_RELAY_HTTP_URL"];
    delete env["SOLVER_JOURNAL_PATH"];
    const problems = problemsOf(env);
    expect(problems.length).toBe(2);
    namesOne(problems, "SOLVER_RELAY_HTTP_URL");
    namesOne(problems, "SOLVER_JOURNAL_PATH");
  });
});

describe("FR-005 the real entrypoint fails fast", () => {
  // resolve(import.meta.dir, …), never new URL(...).pathname: a checkout under a
  // directory containing a space would percent-encode the path.
  const entrypoint = resolve(import.meta.dir, "../../start.solver.ts");
  const run = async (env: Record<string, string>) => {
    const child = Bun.spawn(["bun", entrypoint], {
      cwd: resolve(import.meta.dir, "../.."),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };

  test("start:solver exits non-zero and lists every missing variable", async () => {
    const { exitCode, stderr } = await run({});
    expect(exitCode).toBe(1);
    expect(stderr).toContain("solver launch configuration is invalid (7 problems)");
    for (const variable of [
      "MIDNIGHT_NETWORK_ID",
      "ZSWAP_API",
      "SOLVER_RELAY_WS_URL",
      "SOLVER_RELAY_HTTP_URL",
      "SOLVER_RELAY_AUTH_TOKEN",
      "SOLVER_JOURNAL_PATH",
      "SOLVER_SEED",
    ]) {
      expect(stderr).toContain(variable);
    }
    // No stack trace: the operator gets the list, and nothing was started.
    expect(stderr).not.toContain("at <anonymous>");
  }, 60_000);

  test("SOLVER_ENABLED=false exits 0 without demanding the trading configuration", async () => {
    const { exitCode, stdout } = await run({ SOLVER_ENABLED: "false" });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SOLVER_ENABLED=false");
  }, 60_000);
});

/**
 * 00007 FR-001 — the read-only status listener's configuration boundary.
 *
 * The whole point of these is the Q-S-3 amendment: `/status/*` serves the
 * solver's ENTIRE internal state, so a listener that comes up open must be
 * impossible to configure, not merely discouraged. The port is the opt-in and
 * the bearer is mandatory with it; everything else is grammar.
 */
describe("FR-001 status listener configuration (00007)", () => {
  const STATUS_TOKEN = `s${"7".repeat(39)}`;
  const withStatus = (extra: Record<string, string>): Record<string, string> => ({
    ...complete(),
    ...extra,
  });

  test("no SOLVER_STATUS_PORT means no listener and no other change", () => {
    const config = resolveWith(complete());
    expect(config.status).toBeNull();
    // SC-001's configuration half: the unset case must not even warn.
    expect(config.warnings).toEqual([]);
    expect(describeSolverLaunchConfig(config))
      .toContain("status listener: disabled (SOLVER_STATUS_PORT unset)");
  });

  test("a port plus a long enough bearer resolves, defaulting the host to loopback", () => {
    const config = resolveWith(withStatus({
      SOLVER_STATUS_PORT: "9100",
      SOLVER_STATUS_AUTH_TOKEN: STATUS_TOKEN,
    }));
    expect(config.status).toEqual({ host: "127.0.0.1", port: 9100, authToken: STATUS_TOKEN });
    // Loopback by default, and silently so: it is the safe choice.
    expect(config.warnings).toEqual([]);
  });

  test("the bearer is MANDATORY whenever the port is set", () => {
    const problems = problemsOf(withStatus({ SOLVER_STATUS_PORT: "9100" }));
    namesOne(problems, "SOLVER_STATUS_AUTH_TOKEN");
    expect(problems[0]).toContain("must never be open");
  });

  test("a bearer shorter than 32 characters is refused, and its length is named", () => {
    const problems = problemsOf(withStatus({
      SOLVER_STATUS_PORT: "9100",
      SOLVER_STATUS_AUTH_TOKEN: "0123456789",
    }));
    namesOne(problems, "SOLVER_STATUS_AUTH_TOKEN");
    expect(problems[0]).toContain("at least 32 characters");
    expect(problems[0]).toContain("got 10");
    // The refusal names the LENGTH and never the value.
    expect(problems[0]).not.toContain("0123456789");
  });

  test("a bearer with surrounding whitespace is refused rather than trimmed", () => {
    const problems = problemsOf(withStatus({
      SOLVER_STATUS_PORT: "9100",
      SOLVER_STATUS_AUTH_TOKEN: ` ${STATUS_TOKEN} `,
    }));
    namesOne(problems, "SOLVER_STATUS_AUTH_TOKEN");
    expect(problems[0]).toContain("whitespace");
  });

  test("the port grammar is canonical base-10 in [1, 65535]", () => {
    for (const port of ["0", "65536", "8080x", " 8080", "08080", "-1", "3.5", ""]) {
      const env = withStatus({
        SOLVER_STATUS_PORT: port,
        SOLVER_STATUS_AUTH_TOKEN: STATUS_TOKEN,
      });
      if (port === "") {
        // Empty is "unset", not "malformed" — but it leaves the token unused.
        const config = resolveWith(env);
        expect(config.status).toBeNull();
        continue;
      }
      const problems = problemsOf(env);
      namesOne(problems, "SOLVER_STATUS_PORT");
    }
    expect(resolveWith(withStatus({
      SOLVER_STATUS_PORT: "65535",
      SOLVER_STATUS_AUTH_TOKEN: STATUS_TOKEN,
    })).status!.port).toBe(65_535);
  });

  test("a non-loopback host is allowed but WARNED about, because Compose needs it", () => {
    // `deploy/compose.yml` sets 0.0.0.0 so `solver-frontend` can reach the
    // listener inside the container network. That is legitimate; publishing the
    // port to a public interface is not, and the operator is told at every boot.
    const config = resolveWith(withStatus({
      SOLVER_STATUS_PORT: "9100",
      SOLVER_STATUS_HOST: "0.0.0.0",
      SOLVER_STATUS_AUTH_TOKEN: STATUS_TOKEN,
    }));
    expect(config.status).toEqual({ host: "0.0.0.0", port: 9100, authToken: STATUS_TOKEN });
    expect(config.warnings).toEqual([
      expect.stringContaining("is not loopback"),
    ]);
  });

  test("a malformed host is a refusal, not a silent fallback to loopback", () => {
    const problems = problemsOf(withStatus({
      SOLVER_STATUS_PORT: "9100",
      SOLVER_STATUS_HOST: " 0.0.0.0",
      SOLVER_STATUS_AUTH_TOKEN: STATUS_TOKEN,
    }));
    namesOne(problems, "SOLVER_STATUS_HOST");
  });

  test("a bearer or host without a port is a warning: it looks protected and serves nothing", () => {
    const config = resolveWith(withStatus({
      SOLVER_STATUS_AUTH_TOKEN: STATUS_TOKEN,
      SOLVER_STATUS_HOST: "0.0.0.0",
    }));
    expect(config.status).toBeNull();
    expect(config.warnings).toEqual([
      expect.stringContaining("SOLVER_STATUS_AUTH_TOKEN is set but SOLVER_STATUS_PORT is not"),
      expect.stringContaining("SOLVER_STATUS_HOST is set but SOLVER_STATUS_PORT is not"),
    ]);
  });

  test("the banner prints the bearer's length and never the bearer (FR-006)", () => {
    const banner = describeSolverLaunchConfig(resolveWith(withStatus({
      SOLVER_STATUS_PORT: "9100",
      SOLVER_STATUS_AUTH_TOKEN: STATUS_TOKEN,
    })));
    expect(banner).toContain("status listener: http://127.0.0.1:9100");
    expect(banner).toContain("bearer set, 40 chars");
    expect(banner).not.toContain(STATUS_TOKEN);
    // And the seed and the relay bearer are still absent, as they always were.
    expect(banner).not.toContain(REAL_SEED);
    expect(banner).not.toContain(TOKEN);
  });

  test("status problems join the SAME aggregated list as every other boundary", () => {
    // One restart shows the operator everything, including the status listener.
    // `namesOne` is deliberately not used for the two status variables: the
    // bearer's message names the PORT as well ("required whenever
    // SOLVER_STATUS_PORT is set"), which is the wording that makes it
    // actionable, so a substring count would report two.
    const problems = problemsOf({ SOLVER_STATUS_PORT: "70000" });
    namesOne(problems, "MIDNIGHT_NETWORK_ID");
    namesOne(problems, "SOLVER_SEED");
    // The seven pre-existing mandatory boundaries, plus a bad port, plus the
    // bearer the port made mandatory.
    expect(problems.length).toBe(9);
    expect(problems.filter((problem) => problem.startsWith("SOLVER_STATUS_PORT")).length).toBe(1);
    expect(problems.filter((problem) => problem.startsWith("SOLVER_STATUS_AUTH_TOKEN")).length)
      .toBe(1);
  });
});
