import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactBlockfrostProjectId } from "@effectstream/midnight-contracts/midnight-env";
import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";
import { UNPINNED_REFERENCE_PARAMETERS } from "@zswap-da/validator/reference-parameters";

import type { BatcherConfig } from "./config.ts";
import {
  applyPublicBatcherProfile,
  describePublicBatcher,
  redactedOrigin,
  resolvePublicBatcherProblems,
} from "./public-network.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SEED = "7f".repeat(32);
const TOKEN = "preprodTestProjectId0000000000000";
const NETWORKS = ["preview", "preprod", "mainnet"] as const;
/** The refusal for a supported network whose reference ledger parameters are
 *  not pinned yet (today: mainnet). */
const NOT_PINNED = "ledger-9 reference parameters are not pinned yet";
const unpinned = (network: string) => Object.hasOwn(UNPINNED_REFERENCE_PARAMETERS, network);
/** The problems apart from the not-pinned refusal: what the env itself gets wrong. */
const envProblems = (problems: readonly string[]) => problems.filter((p) => !p.includes(NOT_PINNED));

/** What loadBatcherConfig() builds for a public network — including the devnet
 *  defaults the profile must correct (Celestia devnet, loopback RPC). */
function base(network: string = "preprod", overrides: Partial<BatcherConfig> = {}): BatcherConfig {
  return {
    port: 3334,
    pollingIntervalMs: 250,
    storageDir: "/app/packages/batcher/batcher-data",
    walletSeed: REAL_SEED,
    maxSlotsPerWallet: 1,
    maxRetries: undefined,
    retryDelayMs: undefined,
    dustWaitTimeoutMs: undefined,
    minSpendableDustPerCoin: undefined,
    maxInputChars: undefined,
    midnight: {
      id: network,
      indexer: `https://midnight-${network}.blockfrost.io/api/v0?project_id=${TOKEN}`,
      indexerWS: `wss://midnight-${network}.blockfrost.io/api/v0/ws?project_id=${TOKEN}`,
      node: `https://rpc.midnight-${network}.blockfrost.io?project_id=${TOKEN}`,
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
      rpcUrl: "https://celestia.example.invalid",
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

const env = (network: string = "preprod"): Record<string, string | undefined> => ({
  MIDNIGHT_NETWORK_ID: network,
  MIDNIGHT_BLOCKFROST_PROJECT_ID: TOKEN,
  BATCHER_WALLET_SEED: REAL_SEED,
  BATCHER_STORAGE_DIR: "/var/lib/batcher",
  CELESTIA_RPC_URL: "https://celestia.example.invalid",
  CELESTIA_AUTH_TOKEN: "celestia-bearer",
});

describe("public-network batcher — raw-environment problems", () => {
  test.each(NETWORKS)("a complete %s env has no problem (a network not pinned yet: only that one)", (network) => {
    expect(resolvePublicBatcherProblems(env(network))).toEqual(
      unpinned(network) ? [expect.stringContaining(NOT_PINNED)] : [],
    );
  });

  test("mainnet: refused only because its reference parameters are not pinned yet", () => {
    const problems = resolvePublicBatcherProblems(env("mainnet"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ${NOT_PINNED}`);
    expect(problems[0]).toContain("(pinned: undeployed, preview, preprod)");
    expect(problems[0]).not.toContain("is not supported");
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "  "],
  ])("BATCHER_WALLET_SEED %s is refused by name on every public network", (_label, value) => {
    for (const network of NETWORKS) {
      const problems = envProblems(resolvePublicBatcherProblems({ ...env(network), BATCHER_WALLET_SEED: value }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith(`BATCHER_WALLET_SEED is required on ${network}`);
    }
  });

  test.each([
    "0000000000000000000000000000000000000000000000000000000000000003",
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000000000000000000000000000000000000000000000000000021",
    "00000000000000000000000000000000000000000000000000000000000000ab", // 31 zero bytes
  ])("the public dev seed %s is refused by name on every public network", (seed) => {
    for (const network of NETWORKS) {
      const problems = envProblems(resolvePublicBatcherProblems({ ...env(network), BATCHER_WALLET_SEED: seed }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith("BATCHER_WALLET_SEED is a public dev seed");
      expect(problems[0]).not.toContain(seed.replace(/^0x/, ""));
    }
  });

  test("a malformed seed is refused by name; a 64-byte (mnemonic) seed is accepted", () => {
    expect(resolvePublicBatcherProblems({ ...env(), BATCHER_WALLET_SEED: "abc" })[0]).toContain(
      "BATCHER_WALLET_SEED must be 64 or 128 hex characters",
    );
    expect(resolvePublicBatcherProblems({ ...env(), BATCHER_WALLET_SEED: "ab".repeat(64) })).toEqual([]);
  });

  test("BATCHER_STORAGE_DIR is required and must be absolute", () => {
    expect(resolvePublicBatcherProblems({ ...env(), BATCHER_STORAGE_DIR: undefined })[0]).toContain(
      "BATCHER_STORAGE_DIR is required on preprod",
    );
    expect(resolvePublicBatcherProblems({ ...env(), BATCHER_STORAGE_DIR: "data" })[0]).toContain(
      "BATCHER_STORAGE_DIR must be an absolute path",
    );
  });

  test("Celestia: the network's chain, an explicit RPC URL and the auth are required", () => {
    expect(resolvePublicBatcherProblems({ ...env("preview"), CELESTIA_NETWORK: "mainnet" })[0]).toContain(
      'CELESTIA_NETWORK must be "mocha" on preview',
    );
    expect(resolvePublicBatcherProblems({ ...env("mainnet"), CELESTIA_NETWORK: "mocha" })[0]).toContain(
      'CELESTIA_NETWORK must be "mainnet" on mainnet',
    );
    const problems = resolvePublicBatcherProblems({
      ...env(),
      CELESTIA_RPC_URL: undefined,
      CELESTIA_AUTH_TOKEN: undefined,
    }).join("\n");
    expect(problems).toContain("CELESTIA_RPC_URL is required on preprod");
    expect(problems).toContain("CELESTIA_AUTH_TOKEN is required on preprod");
    const inUrl = resolvePublicBatcherProblems({ ...env(), CELESTIA_AUTH_TOKEN: undefined, CELESTIA_AUTH_IN_URL: "true" });
    expect(inUrl).toEqual([]);
  });

  test("Midnight endpoints: the Blockfrost token, and never a retired host", () => {
    expect(resolvePublicBatcherProblems({ ...env("mainnet"), MIDNIGHT_BLOCKFROST_PROJECT_ID: undefined })[0]).toContain(
      "MIDNIGHT_BLOCKFROST_PROJECT_ID is required on mainnet",
    );
    const retired = resolvePublicBatcherProblems({
      ...env("preprod"),
      MIDNIGHT_NODE_HTTP: "https://rpc.preprod.midnight.network",
    });
    expect(retired).toHaveLength(1);
    expect(retired[0]).toContain("MIDNIGHT_NODE_HTTP points at rpc.preprod.midnight.network");
  });

  test("stagenet and any unknown id are refused naming the supported networks; undeployed is sent to the dev entry", () => {
    for (const network of ["stagenet", "devnet", ""]) {
      expect(resolvePublicBatcherProblems(env(network))[0]).toContain(
        "(supported: undeployed, preview, preprod, mainnet)",
      );
    }
    expect(resolvePublicBatcherProblems(env("undeployed"))[0]).toContain("run packages/batcher/batcher.dev.ts");
  });

  test("every problem is reported in one pass", () => {
    const problems = resolvePublicBatcherProblems({ MIDNIGHT_NETWORK_ID: "mainnet" });
    expect(problems.map((p) => p.split(" ")[0])).toEqual([
      "BATCHER_WALLET_SEED",
      "BATCHER_STORAGE_DIR",
      "CELESTIA_RPC_URL",
      "CELESTIA_AUTH_TOKEN",
      "MIDNIGHT_BLOCKFROST_PROJECT_ID",
      'MIDNIGHT_NETWORK_ID="mainnet"',
    ]);
  });
});

describe("public-network batcher — corrections and description", () => {
  test.each([
    ["preview", "mocha"],
    ["preprod", "mocha"],
    ["mainnet", "mainnet"],
  ] as const)("%s: Celestia becomes %s and the DUST cache moves onto the volume", (network, celestia) => {
    const profile = applyPublicBatcherProfile(env(network), base(network));
    expect(profile.warnings).toEqual([]);
    expect(profile.config.celestia.network).toBe(celestia);
    expect(profile.config.storageDir).toBe("/var/lib/batcher");
    expect(profile.dustStateDir).toBe("/var/lib/batcher/dust-state");
    expect(profile.celestiaAuth).toBe("bearer-token");
    expect(profile.config.midnight).toEqual(base(network).midnight);
    expect(profile.config.sponsorship).toEqual(base(network).sponsorship);
  });

  test("a namespace override is a warning, not a refusal", () => {
    const profile = applyPublicBatcherProfile(
      env(),
      base("preprod", { celestia: { ...base().celestia, namespace: "0102030405060708090a" } }),
    );
    expect(profile.warnings[0]).toContain("overrides the MIP-0006 shared namespace");
  });

  test("the description redacts the Blockfrost token and keeps only the Celestia RPC origin", () => {
    const profile = applyPublicBatcherProfile(
      env(),
      base("preprod", { celestia: { ...base().celestia, rpcUrl: "https://abc.quiknode.pro/SECRET/" } }),
    );
    const text = describePublicBatcher(profile, redactBlockfrostProjectId).join("\n");
    expect(text).toContain("network            : preprod");
    expect(text).toContain("Midnight indexer   : https://midnight-preprod.blockfrost.io/api/v0?project_id=<redacted>");
    expect(text).toContain("Midnight indexer ws: wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=<redacted>");
    expect(text).toContain("Midnight node      : https://rpc.midnight-preprod.blockfrost.io?project_id=<redacted>");
    expect(text).toContain(`${MIP6_NAMESPACE_ID_SUFFIX_HEX} (MIP-0006 mn-swap-v1)`);
    expect(text).toContain("Celestia network   : mocha");
    expect(text).toContain("DUST-state cache   : /var/lib/batcher/dust-state");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(REAL_SEED);
    expect(text).not.toContain("celestia-bearer");
    expect(redactedOrigin("https://abc.quiknode.pro/SECRET/")).toBe("https://abc.quiknode.pro");
  });
});

describe("batcher.public.ts — the real entry, in a child process", () => {
  // A fresh process per case: the entry reads the environment at load time
  // (midnight-env, loadBatcherConfig). `--check` stops before any network call.
  const run = (vars: Record<string, string | undefined>, args: string[] = ["--check"]) => {
    const childEnv: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) childEnv[key] = value;
    return Bun.spawnSync([process.execPath, "run", join(HERE, "batcher.public.ts"), ...args], {
      cwd: HERE,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
  };

  test.each(
    ([
      ["preview", "mocha"],
      ["preprod", "mocha"],
      ["mainnet", "mainnet"],
    ] as const).filter(([network]) => !unpinned(network)),
  )("--check on %s prints the profile with REDACTED endpoints and exits 0", (network, celestia) => {
    const result = run(env(network));
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(0);
    expect(out).toContain(`[${network}] network            : ${network}`);
    expect(out).toContain(
      `[${network}] Midnight indexer   : https://midnight-${network}.blockfrost.io/api/v0?project_id=<redacted>`,
    );
    expect(out).toContain(`[${network}] Midnight node      : https://rpc.midnight-${network}.blockfrost.io?project_id=<redacted>`);
    expect(out).toContain(`[${network}] Celestia network   : ${celestia}`);
    expect(out).toContain(`[${network}] DUST-state cache   : /var/lib/batcher/dust-state`);
    expect(out).toContain("batcher configuration OK");
    expect(out + err).not.toContain(TOKEN);
    expect(out + err).not.toContain(REAL_SEED);
  });

  test.each([
    ["no BATCHER_WALLET_SEED", undefined, "BATCHER_WALLET_SEED is required on preprod"],
    ["the batcher dev seed …03", "0".repeat(63) + "3", "BATCHER_WALLET_SEED is a public dev seed"],
    ["a 31-zero-byte seed", "0".repeat(62) + "7e", "BATCHER_WALLET_SEED is a public dev seed"],
  ])("%s exits 78 naming it, never falling back", (_label, seed, message) => {
    const result = run({ ...env("preprod"), BATCHER_WALLET_SEED: seed }, []);
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain(message);
    expect(result.stdout.toString()).not.toContain("starting on");
  });

  test("no Blockfrost token exits 78 naming it (before midnight-env can throw)", () => {
    const result = run({ ...env("mainnet"), MIDNIGHT_BLOCKFROST_PROJECT_ID: undefined }, []);
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("MIDNIGHT_BLOCKFROST_PROJECT_ID is required on mainnet");
  });

  test.each([
    ["the --check preflight", ["--check"]],
    ["the entry itself", []],
  ] as const)("mainnet, %s: exits 78 because its reference parameters are not pinned yet", (_label, args) => {
    const result = run(env("mainnet"), [...args]);
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(78);
    expect(err).toContain('configuration for MIDNIGHT_NETWORK_ID="mainnet" is invalid (1 problem)');
    expect(err).toContain(`MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ${NOT_PINNED}`);
    expect(out).not.toContain("batcher configuration OK");
    expect(out).not.toContain("starting on");
    expect(out + err).not.toContain(TOKEN);
    expect(out + err).not.toContain(REAL_SEED);
  });

  test("stagenet exits 78 naming the supported networks", () => {
    const result = run(env("stagenet"), []);
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("(supported: undeployed, preview, preprod, mainnet)");
  });
});
