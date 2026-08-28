import { describe, expect, test } from "bun:test";

import {
  COMMON_CONTAINER_FIELDS,
  LIVE_CONTAINER_FIELDS,
  runContainerDispatcher,
  validateContainerEnvironment,
  type ContainerEnvReader,
} from "./solver.container.ts";

const complete = (overrides: Record<string, string | undefined> = {}): Record<string, string> => {
  const values: Record<string, string> = {
    MIDNIGHT_NETWORK_ID: "preview",
    SOLVER_ENABLED: "false",
    SOLVER_DRY_RUN: "true",
    SOLVER_SEED: "public-dummy-seed-not-for-use",
    ZSWAP_API: "http://recorder.invalid",
    SOLVER_LADDER_CONFIG: "/etc/cow-solver/ladders.json",
    MIDNIGHT_INDEXER_HTTP: "http://indexer.invalid",
    MIDNIGHT_INDEXER_WS: "ws://indexer.invalid",
    MIDNIGHT_NODE_HTTP: "http://node.invalid",
    MIDNIGHT_PROOF_SERVER_URL: "http://proof.invalid",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete values[name];
    else values[name] = value;
  }
  return values;
};

const reader = (values: Record<string, string>): ContainerEnvReader => (name) => values[name];
const readable = (): void => {};

describe("container preflight", () => {
  test("accepts complete explicit preview dry-run configuration", () => {
    expect(validateContainerEnvironment(reader(complete()), readable)).toEqual({
      network: "preview",
      solverEnabled: false,
      dryRun: true,
      ladderPath: "/etc/cow-solver/ladders.json",
    });
  });

  for (const name of [
    "MIDNIGHT_NETWORK_ID",
    "SOLVER_ENABLED",
    "SOLVER_DRY_RUN",
    ...COMMON_CONTAINER_FIELDS,
  ]) {
    test(`rejects missing ${name}`, () => {
      expect(() => validateContainerEnvironment(reader(complete({ [name]: undefined })), readable))
        .toThrow(name);
    });
  }

  for (const name of ["SOLVER_ENABLED", "SOLVER_DRY_RUN"]) {
    test(`requires a strict ${name} boolean`, () => {
      expect(() => validateContainerEnvironment(reader(complete({ [name]: "TRUE" })), readable))
        .toThrow(`${name} must be exactly true or false`);
    });
  }

  test("rejects unsupported network without reflecting its value", () => {
    const secretValue = "secret-network-value";
    expect(() => validateContainerEnvironment(
      reader(complete({ MIDNIGHT_NETWORK_ID: secretValue })),
      readable,
    )).toThrow("MIDNIGHT_NETWORK_ID must be preview or mainnet");
    try {
      validateContainerEnvironment(reader(complete({ MIDNIGHT_NETWORK_ID: secretValue })), readable);
    } catch (error) {
      expect(String(error)).not.toContain(secretValue);
    }
  });

  test("rejects an unreadable ladder without reflecting its path", () => {
    const secretPath = "/secret/ladder/value.json";
    try {
      validateContainerEnvironment(reader(complete({ SOLVER_LADDER_CONFIG: secretPath })), () => {
        throw new Error("unreadable");
      });
      throw new Error("expected preflight to reject the ladder");
    } catch (error) {
      expect(String(error)).toContain("SOLVER_LADDER_CONFIG");
      expect(String(error)).not.toContain(secretPath);
    }
  });

  for (const name of LIVE_CONTAINER_FIELDS) {
    test(`requires live-only ${name}`, () => {
      const live = Object.fromEntries(LIVE_CONTAINER_FIELDS.map((field) => [
        field,
        field === "SOLVER_JOURNAL_PATH"
          ? "/var/lib/cow-solver/operations.sqlite"
          : `${field}-dummy`,
      ]));
      expect(() => validateContainerEnvironment(
        reader(complete({ SOLVER_DRY_RUN: "false", ...live, [name]: undefined })),
        readable,
      )).toThrow(name);
    });
  }

  test("requires an absolute live journal path", () => {
    const live = Object.fromEntries(LIVE_CONTAINER_FIELDS.map((name) => [name, `${name}-dummy`]));
    expect(() => validateContainerEnvironment(reader(complete({
      SOLVER_DRY_RUN: "false",
      ...live,
      SOLVER_JOURNAL_PATH: "relative.sqlite",
    })), readable)).toThrow("SOLVER_JOURNAL_PATH must be absolute");
  });

  test("requires the exact mainnet live acknowledgement", () => {
    const live = Object.fromEntries(LIVE_CONTAINER_FIELDS.map((name) => [name, `${name}-dummy`]));
    expect(() => validateContainerEnvironment(reader(complete({
      MIDNIGHT_NETWORK_ID: "mainnet",
      SOLVER_DRY_RUN: "false",
      ...live,
      SOLVER_JOURNAL_PATH: "/var/lib/cow-solver/operations.sqlite",
      SOLVER_MAINNET_LIVE_TRADING_ACK: "false",
    })), readable)).toThrow("SOLVER_MAINNET_LIVE_TRADING_ACK");
  });
});

describe("container dispatch", () => {
  test("loads only preview for preview", async () => {
    const calls: string[] = [];
    await runContainerDispatcher({
      read: reader(complete()),
      ensureReadableFile: readable,
      importPreview: async () => { calls.push("preview"); },
      importMainnet: async () => { calls.push("mainnet"); },
    });
    expect(calls).toEqual(["preview"]);
  });

  test("loads only mainnet for mainnet dry-run", async () => {
    const calls: string[] = [];
    await runContainerDispatcher({
      read: reader(complete({ MIDNIGHT_NETWORK_ID: "mainnet" })),
      ensureReadableFile: readable,
      importPreview: async () => { calls.push("preview"); },
      importMainnet: async () => { calls.push("mainnet"); },
    });
    expect(calls).toEqual(["mainnet"]);
  });

  test("validation happens before any application import", async () => {
    const calls: string[] = [];
    await expect(runContainerDispatcher({
      read: reader(complete({ SOLVER_SEED: undefined })),
      ensureReadableFile: readable,
      importPreview: async () => { calls.push("preview"); },
      importMainnet: async () => { calls.push("mainnet"); },
    })).rejects.toThrow("SOLVER_SEED");
    expect(calls).toEqual([]);
  });
});

test("container preflight has no production application static imports", async () => {
  const source = await Bun.file(import.meta.dir + "/solver.container.ts").text();
  for (const forbidden of [
    'from "./env.ts"',
    'from "./src/run.ts"',
    'from "./solver.preview.ts"',
    'from "./solver.mainnet.ts"',
  ]) {
    expect(source).not.toContain(forbidden);
  }
});

test("preview delegates dry-run selection to runSolver's explicit environment fallback", async () => {
  const preview = await Bun.file(import.meta.dir + "/solver.preview.ts").text();
  const run = await Bun.file(import.meta.dir + "/src/run.ts").text();
  expect(preview).toContain("runSolver({ signal })");
  expect(run).toContain("opts.dryRun ?? isDryRun()");
});
