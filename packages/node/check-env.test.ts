// The repo-root operator check (`bun check-env.ts`) — its static rules for the
// public-network contract (preview, preprod, mainnet), and the committed
// `.env.<network>.example` files run through it. Lives here because
// packages/node is on the CI unit path and check-env.ts builds on this
// package's public-network profile. Values are never echoed: only names and
// verdicts.

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile, staticChecks } from "../../check-env.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NETWORKS = ["preview", "preprod", "mainnet"] as const;
const TOKEN = "preprodTestProjectId0000000000000";

const map = (vars: Record<string, string | undefined>) =>
  new Map(Object.entries(vars).filter((e): e is [string, string] => e[1] !== undefined));
const failed = (vars: Record<string, string | undefined>) =>
  staticChecks(map(vars)).filter((r) => !r.ok).map((r) => r.label);

const complete = (network: string): Record<string, string | undefined> => ({
  MIDNIGHT_NETWORK_ID: network,
  MIDNIGHT_BLOCKFROST_PROJECT_ID: TOKEN,
  CELESTIA_RPC_URL: "https://celestia.example.invalid",
  CELESTIA_AUTH_TOKEN: "bearer",
  CELESTIA_START_HEIGHT: "9000000",
  BATCHER_WALLET_SEED: "7f".repeat(32),
  BATCHER_STORAGE_DIR: "/var/lib/batcher",
});

describe("check-env.ts — the public-network contract", () => {
  test.each(NETWORKS)("a complete %s .env passes, with MIP-0006 and the network's block-1 anchor as defaults", (network) => {
    const results = staticChecks(map(complete(network)));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const labels = results.map((r) => r.label).join("\n");
    expect(labels).toContain(`MIDNIGHT_NETWORK_ID = ${network}`);
    expect(labels).toContain(`(${network} block 1, default)`);
    expect(labels).toContain(`CELESTIA_NETWORK = ${network === "mainnet" ? "mainnet" : "mocha"} (default)`);
    expect(labels).toContain("CELESTIA_NAMESPACE — MIP-0006 shared namespace 6d6e2d737761702d7631 (mn-swap-v1)");
    expect(labels).not.toContain("7f7f");
    expect(labels).not.toContain(TOKEN);
  });

  test("the required variables are named when missing", () => {
    expect(failed({ MIDNIGHT_NETWORK_ID: "preprod" })).toEqual([
      "MIDNIGHT_BLOCKFROST_PROJECT_ID",
      "CELESTIA_RPC_URL",
      "CELESTIA_START_HEIGHT",
      "CELESTIA_AUTH_TOKEN",
      "BATCHER_WALLET_SEED",
      "BATCHER_STORAGE_DIR",
    ]);
  });

  test.each(["stagenet", "devnet", ""])("MIDNIGHT_NETWORK_ID=%j is refused, naming the four supported networks", (network) => {
    const results = staticChecks(map(complete(network)));
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.hint).toContain("(supported: undeployed, preview, preprod, mainnet)");
  });

  test("undeployed is not a public network: nothing to check, dev seeds accepted", () => {
    const results = staticChecks(map({ MIDNIGHT_NETWORK_ID: "undeployed", BATCHER_WALLET_SEED: "0".repeat(63) + "3" }));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("a retired endpoint host is refused naming MIDNIGHT_BLOCKFROST_PROJECT_ID; a Blockfrost override passes", () => {
    const retired = staticChecks(
      map({ ...complete("preprod"), MIDNIGHT_INDEXER_HTTP: "https://indexer.preprod.midnight.network/api/v4/graphql" }),
    ).filter((r) => !r.ok);
    expect(retired.map((r) => r.label)).toEqual(["MIDNIGHT_INDEXER_HTTP"]);
    expect(retired[0]!.hint).toContain("MIDNIGHT_BLOCKFROST_PROJECT_ID");
    expect(
      failed({ ...complete("preprod"), MIDNIGHT_INDEXER_HTTP: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${TOKEN}` }),
    ).toEqual([]);
  });

  test("all three overrides stand in for the token", () => {
    const { MIDNIGHT_BLOCKFROST_PROJECT_ID: _t, ...rest } = complete("mainnet");
    expect(
      failed({
        ...rest,
        MIDNIGHT_INDEXER_HTTP: "https://midnight-mainnet.blockfrost.io/api/v0?project_id=x",
        MIDNIGHT_INDEXER_WS: "wss://midnight-mainnet.blockfrost.io/api/v0/ws?project_id=x",
        MIDNIGHT_NODE_HTTP: "https://rpc.midnight-mainnet.blockfrost.io?project_id=x",
      }),
    ).toEqual([]);
  });

  test("a namespace override (the old …deadbeef) is refused", () => {
    expect(failed({ ...complete("preview"), CELESTIA_NAMESPACE: "000000000000deadbeef" })).toEqual(["CELESTIA_NAMESPACE"]);
    expect(failed({ ...complete("preview"), CELESTIA_NAMESPACE: "6d6e2d737761702d7631" })).toEqual([]);
  });

  test("the wrong Celestia network is refused", () => {
    expect(failed({ ...complete("mainnet"), CELESTIA_NETWORK: "mocha" })).toEqual(["CELESTIA_NETWORK"]);
    expect(failed({ ...complete("preprod"), CELESTIA_NETWORK: "mainnet" })).toEqual(["CELESTIA_NETWORK"]);
  });

  test("CELESTIA_AUTH_IN_URL=true is accepted instead of a token", () => {
    const { CELESTIA_AUTH_TOKEN: _t, ...rest } = complete("preprod");
    expect(failed({ ...rest, CELESTIA_AUTH_IN_URL: "true" })).toEqual([]);
  });

  test.each(NETWORKS)("%s: a public dev batcher seed and a relative storage dir are refused", (network) => {
    expect(failed({ ...complete(network), BATCHER_WALLET_SEED: "0".repeat(63) + "3" })).toEqual(["BATCHER_WALLET_SEED"]);
    expect(failed({ ...complete(network), BATCHER_WALLET_SEED: "0".repeat(62) + "99" })).toEqual(["BATCHER_WALLET_SEED"]);
    expect(failed({ ...complete(network), BATCHER_STORAGE_DIR: "batcher-data" })).toEqual(["BATCHER_STORAGE_DIR"]);
  });

  test("every other wallet seed in the file is refused when it is a dev seed", () => {
    expect(
      failed({
        ...complete("mainnet"),
        POSTER_SEED: "0".repeat(63) + "1",
        SOLVER_SEED: "0".repeat(62) + "21",
        MIDNIGHT_WALLET_SEED: "7e".repeat(32),
      }),
    ).toEqual(["POSTER_SEED", "SOLVER_SEED"]);
  });
});

describe("the committed .env.<network>.example files", () => {
  // The values an operator fills in: dummy, non-dev, never real secrets.
  const DUMMIES: Record<string, string> = {
    MIDNIGHT_BLOCKFROST_PROJECT_ID: "dummyProjectId00000000000000000",
    CELESTIA_RPC_URL: "https://celestia.example.invalid",
    CELESTIA_AUTH_TOKEN: "dummy-bearer",
    CELESTIA_START_HEIGHT: "9000000",
    DB_HOST: "postgres.example.invalid",
    DB_PW: "dummy-password",
    BATCHER_WALLET_SEED: "7f".repeat(32),
    POSTER_SEED: "6e".repeat(32),
    SOLVER_SEED: "5d".repeat(32),
    GIVE_TOKEN: "12".repeat(32),
    WANT_TOKEN: "34".repeat(32),
  };
  const SECRETS = ["MIDNIGHT_BLOCKFROST_PROJECT_ID", "CELESTIA_AUTH_TOKEN", "DB_PW", "BATCHER_WALLET_SEED", "POSTER_SEED"];

  const example = (network: string) => parseEnvFile(join(REPO_ROOT, `.env.${network}.example`));
  const filled = (network: string) => {
    const env = example(network);
    for (const [key, value] of env) if (value === "" && key in DUMMIES) env.set(key, DUMMIES[key]!);
    return env;
  };

  test.each(NETWORKS)(".env.%s.example names its network and ships every secret empty", (network) => {
    const env = example(network);
    expect(env.get("MIDNIGHT_NETWORK_ID")).toBe(network);
    for (const name of SECRETS) expect(env.get(name), name).toBe("");
    expect(env.has("CELESTIA_NAMESPACE")).toBe(false);
  });

  test.each(NETWORKS)(".env.%s.example as committed fails check-env, naming what the operator must fill", (network) => {
    const labels = staticChecks(example(network)).filter((r) => !r.ok).map((r) => r.label);
    expect(labels).toEqual([
      "MIDNIGHT_BLOCKFROST_PROJECT_ID",
      "CELESTIA_RPC_URL",
      "CELESTIA_START_HEIGHT",
      "CELESTIA_AUTH_TOKEN",
      "BATCHER_WALLET_SEED",
    ]);
  });

  test.each(NETWORKS)(".env.%s.example filled with dummy non-dev values passes check-env", (network) => {
    expect(staticChecks(filled(network)).filter((r) => !r.ok)).toEqual([]);
  });

  test.each(NETWORKS)(".env.%s.example filled with a dev seed fails check-env, naming it", (network) => {
    const env = filled(network);
    env.set("BATCHER_WALLET_SEED", "0".repeat(63) + "3");
    expect(staticChecks(env).filter((r) => !r.ok).map((r) => r.label)).toEqual(["BATCHER_WALLET_SEED"]);
    const poster = filled(network);
    poster.set("POSTER_SEED", "0".repeat(63) + "1");
    expect(staticChecks(poster).filter((r) => !r.ok).map((r) => r.label)).toEqual(["POSTER_SEED"]);
  });
});
