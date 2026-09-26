// The repo-root operator check (`bun check-env.ts`) — its static rules, for the
// preview contract (unchanged) and the stagenet one (00050 FR-007). Lives here
// because packages/node is on the CI unit path and check-env.ts builds on this
// package's stagenet profile. Values are never echoed: only names and verdicts.

import { describe, expect, test } from "bun:test";

import { staticChecks } from "../../check-env.ts";

const map = (vars: Record<string, string>) => new Map(Object.entries(vars));
const failed = (vars: Record<string, string>) =>
  staticChecks(map(vars)).filter((r) => !r.ok).map((r) => r.label);

const PREVIEW = {
  MIDNIGHT_NETWORK_ID: "preview",
  CELESTIA_NETWORK: "mocha",
  CELESTIA_NAMESPACE: "000000000000deadbeef",
  CELESTIA_RPC_URL: "https://quicknode.example.invalid/token/",
  CELESTIA_START_HEIGHT: "10620000",
  BATCHER_WALLET_SEED: "7f".repeat(32),
};

const STAGENET = {
  MIDNIGHT_NETWORK_ID: "stagenet",
  CELESTIA_RPC_URL: "https://mocha.example.invalid",
  CELESTIA_AUTH_TOKEN: "bearer",
  CELESTIA_START_HEIGHT: "9000000",
  BATCHER_WALLET_SEED: "7f".repeat(32),
  BATCHER_STORAGE_DIR: "/var/lib/batcher",
};

describe("check-env.ts — preview (unchanged)", () => {
  test("a complete preview .env passes", () => {
    expect(failed(PREVIEW)).toEqual([]);
  });

  test("preview still requires its namespace override and mocha", () => {
    const { CELESTIA_NAMESPACE: _n, CELESTIA_NETWORK: _c, ...rest } = PREVIEW;
    expect(failed(rest)).toEqual(["CELESTIA_NETWORK", "CELESTIA_NAMESPACE"]);
  });

  test("an unknown network is refused, naming both supported ones", () => {
    const results = staticChecks(map({ ...PREVIEW, MIDNIGHT_NETWORK_ID: "preprod" }));
    const net = results.find((r) => r.label === "MIDNIGHT_NETWORK_ID")!;
    expect(net.ok).toBe(false);
    expect(net.hint).toContain('expected "preview" or "stagenet"');
  });
});

describe("check-env.ts — stagenet (00050 FR-007)", () => {
  test("a complete stagenet .env passes, with MIP-0006 and the stagenet anchor as defaults", () => {
    const results = staticChecks(map(STAGENET));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const labels = results.map((r) => r.label).join("\n");
    expect(labels).toContain("MIDNIGHT_NETWORK_ID = stagenet");
    expect(labels).toContain("NTP_START_TIME — 1786638294000 (stagenet block 1, default)");
    expect(labels).toContain("CELESTIA_NETWORK = mocha (default)");
    expect(labels).toContain("CELESTIA_NAMESPACE — MIP-0006 shared namespace 6d6e2d737761702d7631 (mn-swap-v1)");
    expect(labels).not.toContain("7f7f");
  });

  test("the stagenet-required variables are named when missing", () => {
    expect(failed({ MIDNIGHT_NETWORK_ID: "stagenet" })).toEqual([
      "CELESTIA_RPC_URL",
      "CELESTIA_START_HEIGHT",
      "CELESTIA_AUTH_TOKEN",
      "BATCHER_WALLET_SEED",
      "BATCHER_STORAGE_DIR",
    ]);
  });

  test("a namespace override is refused (owner decision: MIP-0006, no override)", () => {
    expect(failed({ ...STAGENET, CELESTIA_NAMESPACE: "000000000000deadbeef" })).toEqual(["CELESTIA_NAMESPACE"]);
    expect(failed({ ...STAGENET, CELESTIA_NAMESPACE: "6d6e2d737761702d7631" })).toEqual([]);
  });

  test("CELESTIA_AUTH_IN_URL=true is accepted instead of a token", () => {
    const { CELESTIA_AUTH_TOKEN: _t, ...rest } = STAGENET;
    expect(failed({ ...rest, CELESTIA_AUTH_IN_URL: "true" })).toEqual([]);
  });

  test("a public dev batcher seed and a relative storage dir are refused", () => {
    expect(failed({ ...STAGENET, BATCHER_WALLET_SEED: "0".repeat(63) + "3" })).toEqual(["BATCHER_WALLET_SEED"]);
    expect(failed({ ...STAGENET, BATCHER_STORAGE_DIR: "batcher-data" })).toEqual(["BATCHER_STORAGE_DIR"]);
  });

  test("CELESTIA_NETWORK other than mocha is refused", () => {
    expect(failed({ ...STAGENET, CELESTIA_NETWORK: "mainnet" })).toEqual(["CELESTIA_NETWORK"]);
  });
});
