import { describe, expect, test } from "bun:test";
import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";

import { loadBatcherConfig, resolveBatcherWalletSeed } from "./config.ts";

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const optionalBatcherStrings = (value: string | undefined) => ({
  BATCHER_NODE_API_URL: value,
  BATCHER_STORAGE_DIR: value,
  CELESTIA_NETWORK: value,
  CELESTIA_RPC_URL: value,
  CELESTIA_NAMESPACE: value,
});

test.each([
  ["unset", undefined],
  ["empty", ""],
  ["whitespace", " \t "],
])("batcher optional strings treat %s as unset", (_label, value) => {
  const config = withEnv(optionalBatcherStrings(value), loadBatcherConfig);
  expect(config.sponsorship.nodeApiUrl).toBe("http://127.0.0.1:9999");
  expect(config.storageDir).toEndWith("/packages/batcher/batcher-data");
  expect(config.celestia.network).toBe("devnet");
  expect(config.celestia.rpcUrl).toBe("http://127.0.0.1:26658");
  expect(config.celestia.namespace).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
});

test("batcher optional strings preserve trimmed custom values", () => {
  const config = withEnv(
    {
      BATCHER_NODE_API_URL: " http://kernel:9999/ ",
      BATCHER_STORAGE_DIR: " /tmp/custom-batcher ",
      CELESTIA_NETWORK: " mocha ",
      CELESTIA_RPC_URL: " http://celestia:26658/ ",
      CELESTIA_NAMESPACE: " abcdef ",
    },
    loadBatcherConfig,
  );
  expect(config.sponsorship.nodeApiUrl).toBe("http://kernel:9999/");
  expect(config.storageDir).toBe("/tmp/custom-batcher");
  expect(config.celestia.network).toBe("mocha");
  expect(config.celestia.rpcUrl).toBe("http://celestia:26658/");
  expect(config.celestia.namespace).toBe("abcdef");
});

describe("BATCHER_WALLET_SEED has no public fallback off undeployed", () => {
  const DEV_BATCHER_SEED = "0".repeat(63) + "3";

  test("undeployed keeps the dev fallback …03, and an explicit seed wins", () => {
    expect(resolveBatcherWalletSeed("undeployed", undefined)).toBe(DEV_BATCHER_SEED);
    expect(resolveBatcherWalletSeed("undeployed", "  ")).toBe(DEV_BATCHER_SEED);
    expect(resolveBatcherWalletSeed("undeployed", "7f".repeat(32))).toBe("7f".repeat(32));
    expect(resolveBatcherWalletSeed("undeployed", "0".repeat(63) + "1")).toBe("0".repeat(63) + "1");
  });

  test.each(["preview", "preprod", "mainnet", "stagenet"])("%s: unset, …03 and a 31-zero-byte seed throw naming the variable", (network) => {
    expect(() => resolveBatcherWalletSeed(network, undefined)).toThrow(`BATCHER_WALLET_SEED is required on ${network}`);
    expect(() => resolveBatcherWalletSeed(network, "")).toThrow("BATCHER_WALLET_SEED is required");
    expect(() => resolveBatcherWalletSeed(network, DEV_BATCHER_SEED)).toThrow("BATCHER_WALLET_SEED is a public dev seed");
    expect(() => resolveBatcherWalletSeed(network, "0".repeat(62) + "42")).toThrow("BATCHER_WALLET_SEED is a public dev seed");
    expect(resolveBatcherWalletSeed(network, " " + "7f".repeat(32) + " ")).toBe("7f".repeat(32));
  });
});

describe("loadBatcherConfig() itself refuses on a public network (any entry)", () => {
  // A child process: midnight-env resolves MIDNIGHT_NETWORK_ID at import.
  const HERE = import.meta.dir;
  const load = (seed: string | undefined) => {
    const script = [
      `const { loadBatcherConfig } = await import(${JSON.stringify(`${HERE}/config.ts`)});`,
      "try { loadBatcherConfig(); console.log('LOADED'); } catch (e) { console.log('REFUSED ' + e.message); }",
    ].join("\n");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      MIDNIGHT_NETWORK_ID: "preprod",
      MIDNIGHT_BLOCKFROST_PROJECT_ID: "preprodTestProjectId0000000000000",
    };
    if (seed !== undefined) env["BATCHER_WALLET_SEED"] = seed;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: HERE, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };

  test("unset and the dev seed …03 are refused by name; a real seed loads", () => {
    expect(load(undefined)).toContain("REFUSED BATCHER_WALLET_SEED is required on preprod");
    expect(load("0".repeat(63) + "3")).toContain("REFUSED BATCHER_WALLET_SEED is a public dev seed");
    expect(load("7f".repeat(32))).toContain("LOADED");
  });
});
