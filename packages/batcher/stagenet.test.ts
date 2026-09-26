import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";

import type { BatcherConfig } from "./config.ts";
import { describeStagenetBatcher, redactedOrigin, resolveStagenetBatcher } from "./stagenet.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SEED = "7f".repeat(32);

/** What loadBatcherConfig() builds for a stagenet env — including the devnet
 *  defaults the stagenet profile must not trust (seed …03, loopback RPC). */
function base(overrides: Partial<BatcherConfig> = {}): BatcherConfig {
  return {
    port: 3334,
    pollingIntervalMs: 250,
    storageDir: "/app/packages/batcher/batcher-data",
    walletSeed: "0".repeat(63) + "3",
    maxSlotsPerWallet: 1,
    maxRetries: undefined,
    retryDelayMs: undefined,
    dustWaitTimeoutMs: undefined,
    minSpendableDustPerCoin: undefined,
    maxInputChars: undefined,
    midnight: {
      id: "stagenet",
      indexer: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
      indexerWS: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
      node: "https://rpc.stagenet.shielded.tools",
      proofServer: "http://proof-server:6300",
    },
    sponsorship: {
      nodeApiUrl: "http://kernel:9999",
      priceTtlMs: 600_000,
      priceMaxAgeMs: 172_800_000,
      policy: "warn",
      unpriced: "allow",
      fallbackDiscountBps: 250,
    },
    celestia: {
      rpcUrl: "https://mocha.example.invalid",
      namespace: MIP6_NAMESPACE_ID_SUFFIX_HEX,
      authToken: "celestia-bearer",
      network: "devnet",
      fee: 2000,
      gasLimit: 100000,
      gasPrice: undefined,
      gas: undefined,
      maxGasPrice: undefined,
      txPriority: undefined,
    },
    ...overrides,
  };
}

const env = (): Record<string, string | undefined> => ({
  MIDNIGHT_NETWORK_ID: "stagenet",
  BATCHER_WALLET_SEED: REAL_SEED,
  BATCHER_STORAGE_DIR: "/var/lib/batcher",
  CELESTIA_RPC_URL: "https://mocha.example.invalid",
  CELESTIA_AUTH_TOKEN: "celestia-bearer",
});

describe("stagenet batcher profile (00050 FR-002)", () => {
  test("a complete env is accepted; Celestia becomes mocha and the DUST cache moves onto the volume", () => {
    const profile = resolveStagenetBatcher(env(), base());
    expect(profile.problems).toEqual([]);
    expect(profile.warnings).toEqual([]);
    expect(profile.config.celestia.network).toBe("mocha");
    expect(profile.config.storageDir).toBe("/var/lib/batcher");
    expect(profile.dustStateDir).toBe("/var/lib/batcher/dust-state");
    expect(profile.celestiaAuth).toBe("bearer-token");
    // Everything else is the loader's value, untouched.
    expect(profile.config.midnight).toEqual(base().midnight);
    expect(profile.config.sponsorship).toEqual(base().sponsorship);
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "  "],
  ])("BATCHER_WALLET_SEED %s is refused by name — the loader's …03 fallback is never used", (_label, value) => {
    const profile = resolveStagenetBatcher({ ...env(), BATCHER_WALLET_SEED: value }, base());
    expect(profile.problems).toHaveLength(1);
    expect(profile.problems[0]).toContain("BATCHER_WALLET_SEED is required on stagenet");
  });

  test.each([
    "0000000000000000000000000000000000000000000000000000000000000003",
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000000000000000000000000000000000000000000000000000021",
  ])("a public dev seed (%s) is refused by name", (seed) => {
    const profile = resolveStagenetBatcher({ ...env(), BATCHER_WALLET_SEED: seed }, base());
    expect(profile.problems).toHaveLength(1);
    expect(profile.problems[0]).toContain("BATCHER_WALLET_SEED is a public dev seed");
  });

  test("a malformed seed is refused by name; a 64-byte (mnemonic) seed is accepted", () => {
    expect(resolveStagenetBatcher({ ...env(), BATCHER_WALLET_SEED: "abc" }, base()).problems[0]).toContain(
      "BATCHER_WALLET_SEED must be 64 or 128 hex characters",
    );
    expect(resolveStagenetBatcher({ ...env(), BATCHER_WALLET_SEED: "ab".repeat(64) }, base()).problems).toEqual([]);
  });

  test("the seed never appears in a problem, a warning or the description", () => {
    const profile = resolveStagenetBatcher(env(), base());
    const text = [...profile.problems, ...profile.warnings, ...describeStagenetBatcher(profile)].join("\n");
    expect(text).not.toContain(REAL_SEED);
    expect(text).not.toContain("celestia-bearer");
  });

  test("BATCHER_STORAGE_DIR is required and must be absolute", () => {
    const missing = { ...env() };
    delete missing["BATCHER_STORAGE_DIR"];
    expect(resolveStagenetBatcher(missing, base()).problems[0]).toContain("BATCHER_STORAGE_DIR is required on stagenet");
    expect(resolveStagenetBatcher({ ...env(), BATCHER_STORAGE_DIR: "data" }, base()).problems[0]).toContain(
      "BATCHER_STORAGE_DIR must be an absolute path",
    );
  });

  test("CELESTIA_RPC_URL and the Celestia auth are required", () => {
    const e = { ...env() };
    delete e["CELESTIA_RPC_URL"];
    delete e["CELESTIA_AUTH_TOKEN"];
    const problems = resolveStagenetBatcher(e, base()).problems.join("\n");
    expect(problems).toContain("CELESTIA_RPC_URL is required on stagenet");
    expect(problems).toContain("CELESTIA_AUTH_TOKEN is required on stagenet");
  });

  test("CELESTIA_AUTH_IN_URL=true stands in for a bearer token", () => {
    const e = { ...env(), CELESTIA_AUTH_IN_URL: "true" };
    delete e["CELESTIA_AUTH_TOKEN"];
    const profile = resolveStagenetBatcher(e, base());
    expect(profile.problems).toEqual([]);
    expect(profile.celestiaAuth).toBe("in-url");
  });

  test("CELESTIA_NETWORK other than mocha is refused", () => {
    expect(resolveStagenetBatcher({ ...env(), CELESTIA_NETWORK: "mainnet" }, base()).problems[0]).toContain(
      'CELESTIA_NETWORK must be "mocha" on stagenet',
    );
  });

  test("another network id is refused", () => {
    const profile = resolveStagenetBatcher(env(), base({ midnight: { ...base().midnight, id: "preview" } }));
    expect(profile.problems).toEqual(['batcher.stagenet.ts requires MIDNIGHT_NETWORK_ID=stagenet, got "preview"']);
  });

  test("every problem is reported in one pass", () => {
    const profile = resolveStagenetBatcher({ MIDNIGHT_NETWORK_ID: "stagenet" }, base());
    expect(profile.problems).toHaveLength(4); // seed, storage, RPC URL, auth
  });

  test("a namespace override is a warning, not a refusal", () => {
    const profile = resolveStagenetBatcher(
      env(),
      base({ celestia: { ...base().celestia, namespace: "000000000000deadbeef" } }),
    );
    expect(profile.problems).toEqual([]);
    expect(profile.warnings[0]).toContain("overrides the MIP-0006 shared namespace");
  });

  test("the description shows stagenet's constants and only the RPC origin", () => {
    const profile = resolveStagenetBatcher(
      env(),
      base({ celestia: { ...base().celestia, rpcUrl: "https://abc.quiknode.pro/SECRET/" } }),
    );
    const text = describeStagenetBatcher(profile).join("\n");
    expect(text).toContain("network            : stagenet");
    expect(text).toContain("https://indexer.stagenet.shielded.tools/api/v4/graphql");
    expect(text).toContain(`${MIP6_NAMESPACE_ID_SUFFIX_HEX} (MIP-0006 mn-swap-v1)`);
    expect(text).toContain("Celestia network   : mocha");
    expect(text).toContain("DUST-state cache   : /var/lib/batcher/dust-state");
    expect(text).not.toContain("SECRET");
    expect(redactedOrigin("https://abc.quiknode.pro/SECRET/")).toBe("https://abc.quiknode.pro");
  });

  test("batcher.stagenet.ts hands the DUST-state directory to the balancing adapter", () => {
    const src = readFileSync(join(HERE, "batcher.stagenet.ts"), "utf8");
    expect(src).toContain("dustStateDir: profile.dustStateDir");
    // The --check preflight exits before any adapter (network) is created.
    expect(src.indexOf('process.argv.includes("--check")')).toBeLessThan(
      src.indexOf("createMidnightBalancingAdapter(batcherConfig"),
    );
  });
});

describe("batcher.stagenet.ts — the real entry, in a child process", () => {
  // A fresh process per case: the entry reads the environment at load time
  // (midnight-env, loadBatcherConfig). `--check` stops before any network call.
  const run = (vars: Record<string, string>, args: string[] = ["--check"]) =>
    Bun.spawnSync([process.execPath, "run", join(HERE, "batcher.stagenet.ts"), ...args], {
      cwd: HERE,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...vars },
      stdout: "pipe",
      stderr: "pipe",
    });
  const complete = (): Record<string, string> => env() as Record<string, string>;

  test("--check with a complete env prints the stagenet constants and exits 0", () => {
    const result = run(complete());
    const out = result.stdout.toString();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(out).toContain("[stagenet] network            : stagenet");
    expect(out).toContain("[stagenet] Midnight indexer   : https://indexer.stagenet.shielded.tools/api/v4/graphql");
    expect(out).toContain("[stagenet] Celestia network   : mocha");
    expect(out).toContain(`[stagenet] Celestia namespace : ${MIP6_NAMESPACE_ID_SUFFIX_HEX} (MIP-0006 mn-swap-v1)`);
    expect(out).toContain("[stagenet] DUST-state cache   : /var/lib/batcher/dust-state");
    expect(out).toContain("batcher configuration OK");
    expect(out + result.stderr.toString()).not.toContain(REAL_SEED);
  });

  test("an unset BATCHER_WALLET_SEED exits 78 naming it", () => {
    const vars = complete();
    delete vars["BATCHER_WALLET_SEED"];
    const result = run(vars, []);
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("BATCHER_WALLET_SEED is required on stagenet");
  });

  test("the public batcher dev seed exits 78 naming it", () => {
    const result = run({ ...complete(), BATCHER_WALLET_SEED: "0".repeat(63) + "3" }, []);
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("BATCHER_WALLET_SEED is a public dev seed");
  });

  test("MIDNIGHT_NETWORK_ID=undeployed is refused by the stagenet entry", () => {
    const result = run({ ...complete(), MIDNIGHT_NETWORK_ID: "undeployed" }, []);
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain('requires MIDNIGHT_NETWORK_ID=stagenet, got "undeployed"');
  });
});
