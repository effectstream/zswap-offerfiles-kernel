// Configuration unit tests. Pure: the only I/O `parsePosterConfig` performs is
// the contract-address file read, and that is injected.
//
// The two properties worth the most here are the ones an operator cannot see
// until it is too late: a poster silently sharing another service's wallet
// (FR-001), and a seed reaching a log line (FR-015).

import { describe, expect, test } from "bun:test";

import { mnemonicToSeed } from "@scure/bip39";

import {
  COLLIDING_SEED_VARS,
  ConfigError,
  configDump,
  type ConfigIO,
  type EnvMap,
  parsePosterConfig,
  readEnv,
  redactConfig,
  resolveContractAddress,
  resolveSeed,
} from "./poster-config.ts";

// Preprod's deployed offer-files contract, and the two colours it derives —
// the same vector `faucet-mint.test.ts` pins, so a change in either derivation
// path fails here too.
const PREPROD_CONTRACT = "6fc44c272d866574cefc14e25474fdfa144e6427f299a8222a8ad8a7b374bb7c";
const WBTC = "e7580bfcf04c05cbec44572d122f526ba35d5b6442fa6429e42e9b9fca22a912";
const WETH = "fda14e2e04b8389ab82891c761e1d36501a4c79baa7b87b30fbbdc4814c5a0a5";

const POSTER_SEED = "0000000000000000000000000000000000000000000000000000000000000077";

/** No file anywhere — every test that needs an address passes it by env. */
const noFiles: ConfigIO = { readFile: () => undefined };

const baseEnv = (extra: EnvMap = {}): EnvMap => ({
  POSTER_SEED,
  MIDNIGHT_CONTRACT_ADDRESS: PREPROD_CONTRACT,
  ...extra,
});

const parse = (extra: EnvMap = {}, io: ConfigIO = noFiles) => parsePosterConfig(baseEnv(extra), io);

// ---------------------------------------------------------------------------

describe('readEnv — "" is not a value', () => {
  test("absent, empty and whitespace-only all read as undefined", () => {
    expect(readEnv({}, "X")).toBeUndefined();
    expect(readEnv({ X: "" }, "X")).toBeUndefined();
    expect(readEnv({ X: "   " }, "X")).toBeUndefined();
    expect(readEnv({ X: undefined }, "X")).toBeUndefined();
  });

  test("a real value is trimmed", () => {
    expect(readEnv({ X: "  hi  " }, "X")).toBe("hi");
  });
});

describe("seed resolution (FR-001)", () => {
  test("POSTER_SEED and POSTER_MNEMONIC are mutually exclusive", async () => {
    await expect(
      resolveSeed({ POSTER_SEED, POSTER_MNEMONIC: "abandon abandon about" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("neither is a MISSING error naming both variables", async () => {
    const err = await resolveSeed({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe("MISSING");
    expect((err as ConfigError).message).toContain("POSTER_SEED");
    expect((err as ConfigError).message).toContain("POSTER_MNEMONIC");
  });

  test("a BLANK POSTER_SEED does not count as set, so the mnemonic is used", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const { seed, source } = await resolveSeed({ POSTER_SEED: "", POSTER_MNEMONIC: phrase });
    expect(source).toBe("POSTER_MNEMONIC");
    expect(seed).toHaveLength(128);
  });

  test("mnemonic derivation matches @scure/bip39 mnemonicToSeed exactly", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const { seed } = await resolveSeed({ POSTER_MNEMONIC: phrase });
    // The published BIP-39 vector for this phrase with an empty passphrase.
    expect(seed).toBe(
      "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1" +
        "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
    );
    // …and it is byte-for-byte what `@effectstream/midnight-contracts`'
    // `midnight-env.ts:70-72` computes for MIDNIGHT_WALLET_MNEMONIC.
    expect(seed).toBe(Buffer.from(await mnemonicToSeed(phrase)).toString("hex"));
  });

  test("odd whitespace in the mnemonic is normalised, not rejected", async () => {
    const phrase =
      "  abandon   abandon abandon abandon abandon abandon\tabandon abandon abandon abandon abandon about ";
    const { seed } = await resolveSeed({ POSTER_MNEMONIC: phrase });
    expect(seed).toBe(
      "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1" +
        "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
    );
  });

  test("a short mnemonic is refused before any derivation", async () => {
    await expect(resolveSeed({ POSTER_MNEMONIC: "abandon about" })).rejects.toMatchObject({
      code: "MALFORMED",
      variable: "POSTER_MNEMONIC",
    });
  });

  test("a truncated or non-hex seed is refused rather than becoming another wallet", async () => {
    await expect(resolveSeed({ POSTER_SEED: "00ff" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(resolveSeed({ POSTER_SEED: `${"0".repeat(63)}z` })).rejects.toMatchObject({
      code: "MALFORMED",
    });
  });

  test("64- and 128-character seeds are both accepted; 0x and case are normalised", async () => {
    expect((await resolveSeed({ POSTER_SEED: "AB".repeat(32) })).seed).toBe("ab".repeat(32));
    expect((await resolveSeed({ POSTER_SEED: `0x${"cd".repeat(32)}` })).seed).toBe("cd".repeat(32));
    expect((await resolveSeed({ POSTER_SEED: "ef".repeat(64) })).seed).toHaveLength(128);
  });

  test("the four seeds FR-001 names are all refused as collisions", async () => {
    for (const name of [
      "MIDNIGHT_WALLET_SEED",
      "BATCHER_WALLET_SEED",
      "SOLVER_SEED",
      "MAKER_OFFER_SEED",
    ]) {
      const err = await resolveSeed({ POSTER_SEED, [name]: POSTER_SEED }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("SEED_COLLISION");
      expect((err as ConfigError).variable).toBe(name);
    }
  });

  test("the collision list also covers the genesis/maker/taker dev seeds", () => {
    expect(COLLIDING_SEED_VARS).toContain("MIDNIGHT_GENESIS_SEED");
    expect(COLLIDING_SEED_VARS).toContain("MAKER_SEED");
    expect(COLLIDING_SEED_VARS).toContain("TAKER_SEED");
  });

  test("a collision is detected across 0x prefixes and case", async () => {
    await expect(
      resolveSeed({ POSTER_SEED, SOLVER_SEED: `0x${POSTER_SEED.toUpperCase()}` }),
    ).rejects.toMatchObject({ code: "SEED_COLLISION" });
  });

  test("a DIFFERENT seed in the same environment is fine", async () => {
    const { seed } = await resolveSeed({
      POSTER_SEED,
      SOLVER_SEED: "0000000000000000000000000000000000000000000000000000000000000021",
      MIDNIGHT_WALLET_SEED: "0000000000000000000000000000000000000000000000000000000000000001",
    });
    expect(seed).toBe(POSTER_SEED);
  });

  test("a poster mnemonic that derives the stack's wallet is refused too", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await expect(
      resolveSeed({ POSTER_MNEMONIC: phrase, MIDNIGHT_WALLET_MNEMONIC: phrase }),
    ).rejects.toMatchObject({ code: "SEED_COLLISION", variable: "MIDNIGHT_WALLET_MNEMONIC" });
  });
});

describe("contract address", () => {
  test("MIDNIGHT_CONTRACT_ADDRESS wins and is normalised", () => {
    const r = resolveContractAddress(
      { MIDNIGHT_CONTRACT_ADDRESS: `0x${PREPROD_CONTRACT.toUpperCase()}` },
      "undeployed",
      noFiles,
    );
    expect(r.address).toBe(PREPROD_CONTRACT);
    expect(r.source).toBe("MIDNIGHT_CONTRACT_ADDRESS");
  });

  test("falls back to CONTRACT_SHARE_DIR, with the NETWORK ID in the file name", () => {
    const seen: string[] = [];
    const io: ConfigIO = {
      readFile(path) {
        seen.push(path);
        return path.endsWith("/srv/share/contract-offer-files.preprod.json")
          ? JSON.stringify({ contractAddress: PREPROD_CONTRACT })
          : undefined;
      },
    };
    const r = resolveContractAddress({ CONTRACT_SHARE_DIR: "/srv/share" }, "preprod", io);
    expect(r.address).toBe(PREPROD_CONTRACT);
    expect(r.source).toBe("/srv/share/contract-offer-files.preprod.json");
    expect(seen[0]).toBe("/srv/share/contract-offer-files.preprod.json");
  });

  test("then the packages/contracts-midnight copy the entrypoint installs", () => {
    const io: ConfigIO = {
      readFile: (path) =>
        path.endsWith("packages/contracts-midnight/contract-offer-files.undeployed.json")
          ? JSON.stringify({ contractAddress: PREPROD_CONTRACT })
          : undefined,
    };
    const r = resolveContractAddress({}, "undeployed", io);
    expect(r.address).toBe(PREPROD_CONTRACT);
    expect(r.source).toContain("packages/contracts-midnight");
  });

  test("no source at all is a NO_CONTRACT error naming both paths", () => {
    const err = (() => {
      try {
        resolveContractAddress({}, "undeployed", noFiles);
        return null;
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err?.code).toBe("NO_CONTRACT");
    expect(err?.message).toContain("MIDNIGHT_CONTRACT_ADDRESS");
    expect(err?.message).toContain("contract-offer-files.undeployed.json");
  });

  test("a file without a contractAddress is an error, not a silent skip", () => {
    const io: ConfigIO = { readFile: () => JSON.stringify({ note: "wrong file" }) };
    expect(() => resolveContractAddress({}, "undeployed", io)).toThrow(/no string "contractAddress"/);
  });
});

describe("legs", () => {
  test("preset NAMES derive this deployment's colours (preprod vector)", async () => {
    const cfg = await parse();
    expect(cfg.giveToken).toBe("WBTC");
    expect(cfg.giveTokenName).toBe("WBTC");
    expect(cfg.giveColour).toBe(WBTC);
    expect(cfg.wantColour).toBe(WETH);
  });

  test("a 64-hex WANT_TOKEN is taken as a colour, with no name to register", async () => {
    const colour = "11".repeat(32);
    const cfg = await parse({ WANT_TOKEN: `0x${colour.toUpperCase()}` });
    expect(cfg.wantColour).toBe(colour);
    expect(cfg.wantTokenName).toBeUndefined();
  });

  test("an unshielded preset on either leg is refused (US4 scenario 3)", async () => {
    for (const token of ["NIGHT", "ATOKEN", "BTOKEN", "night"]) {
      await expect(parse({ WANT_TOKEN: token })).rejects.toMatchObject({
        code: "UNSUPPORTED_TOKEN",
        variable: "WANT_TOKEN",
      });
    }
    await expect(parse({ GIVE_TOKEN: "ATOKEN" })).rejects.toMatchObject({
      code: "UNSUPPORTED_TOKEN",
      variable: "GIVE_TOKEN",
    });
  });

  test("the all-zero NIGHT colour is refused even spelled as hex", async () => {
    await expect(parse({ WANT_TOKEN: "0".repeat(64) })).rejects.toMatchObject({
      code: "UNSUPPORTED_TOKEN",
    });
  });

  test("a raw-colour GIVE_TOKEN is refused — the faucet mints from a NAME", async () => {
    await expect(parse({ GIVE_TOKEN: "22".repeat(32) })).rejects.toMatchObject({
      code: "UNSUPPORTED_TOKEN",
      variable: "GIVE_TOKEN",
    });
  });

  test("give and want must differ (the kernel 400s on an equal-leg quote)", async () => {
    await expect(parse({ WANT_TOKEN: "WBTC" })).rejects.toMatchObject({
      code: "UNSUPPORTED_TOKEN",
      variable: "WANT_TOKEN",
    });
  });

  test("a non-preset name is allowed — the derivation is defined for any name", async () => {
    const cfg = await parse({ GIVE_TOKEN: "TESTTOKEN" });
    expect(cfg.giveTokenName).toBe("TESTTOKEN");
    expect(cfg.giveColour).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("knobs and defaults (FR-014)", () => {
  test("every default matches the spec", async () => {
    const cfg = await parse();
    expect(cfg.giveAmount).toBe(1000n);
    expect(cfg.forcedWantAmount).toBeUndefined();
    expect(cfg.postIntervalMs).toBe(60_000);
    expect(cfg.offerTtlMinutes).toBe(60);
    expect(cfg.coinVisibleTimeoutMs).toBe(120_000);
    expect(cfg.reconcileIntervalMs).toBe(60_000);
    expect(cfg.maxReoffersPerTick).toBe(1);
    expect(cfg.shutdownGraceMs).toBe(15_000);
    expect(cfg.healthStaleTicks).toBe(3);
    expect(cfg.healthPort).toBe(9977);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.journalReset).toBe(false);
    expect(cfg.journalFile).toBe("/var/lib/offer-poster/journal.json");
    expect(cfg.kernelBase).toBe("http://kernel:9999");
    expect(cfg.networkId).toBe("undeployed");
    expect(cfg.minDust).toBe(1n);
  });

  test("BLANK knobs fall back to the defaults, they do not override them", async () => {
    const cfg = await parse({
      GIVE_AMOUNT: "",
      POST_INTERVAL_MS: "  ",
      WANT_AMOUNT: "",
      ZSWAP_API: "",
      DRY_RUN: "",
      POSTER_JOURNAL_FILE: "",
    });
    expect(cfg.giveAmount).toBe(1000n);
    expect(cfg.postIntervalMs).toBe(60_000);
    expect(cfg.forcedWantAmount).toBeUndefined();
    expect(cfg.kernelBase).toBe("http://kernel:9999");
    expect(cfg.dryRun).toBe(false);
    expect(cfg.journalFile).toBe("/var/lib/offer-poster/journal.json");
  });

  test("knobs are honoured when set", async () => {
    const cfg = await parse({
      GIVE_AMOUNT: "250000",
      WANT_AMOUNT: "7",
      POST_INTERVAL_MS: "120000",
      OFFER_TTL_MINUTES: "2",
      DRY_RUN: "TRUE",
      POSTER_JOURNAL_RESET: "yes",
      POSTER_HEALTH_PORT: "10123",
      POSTER_MIN_DUST: "100000000000000000",
      ZSWAP_API: "http://kernel:9999/",
    });
    expect(cfg.giveAmount).toBe(250_000n);
    expect(cfg.forcedWantAmount).toBe(7n);
    expect(cfg.postIntervalMs).toBe(120_000);
    expect(cfg.offerTtlMinutes).toBe(2);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.journalReset).toBe(true);
    expect(cfg.healthPort).toBe(10_123);
    expect(cfg.minDust).toBe(100_000_000_000_000_000n);
    expect(cfg.kernelBase).toBe("http://kernel:9999"); // trailing slash stripped
  });

  test("a malformed number or boolean is a startup error, never a silent default", async () => {
    await expect(parse({ POST_INTERVAL_MS: "soon" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ POST_INTERVAL_MS: "0" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ GIVE_AMOUNT: "0" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ GIVE_AMOUNT: "-5" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ DRY_RUN: "maybe" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ POSTER_HEALTH_PORT: "70000" })).rejects.toMatchObject({ code: "MALFORMED" });
  });

  test("network endpoints follow MIDNIGHT_NETWORK_ID, and explicit values win", async () => {
    const undeployed = await parse();
    expect(undeployed.networkUrls.indexer).toContain("127.0.0.1:8088");
    expect(undeployed.networkUrls.node).toBe("http://127.0.0.1:9944");

    const preprod = await parse({ MIDNIGHT_NETWORK_ID: "preprod" });
    expect(preprod.networkUrls.indexer).toBe(
      "https://indexer.preprod.midnight.network/api/v4/graphql",
    );
    expect(preprod.networkUrls.node).toBe("https://rpc.preprod.midnight.network");
    expect(preprod.networkUrls.proofServer).toBe("http://127.0.0.1:6300");

    const explicit = await parse({
      MIDNIGHT_NETWORK_ID: "preprod",
      MIDNIGHT_INDEXER_HTTP: "https://preprod.api-zswap.zkdojo.com/graphql",
      MIDNIGHT_PROOF_SERVER: "http://proof:6300",
    });
    expect(explicit.networkUrls.indexer).toBe("https://preprod.api-zswap.zkdojo.com/graphql");
    expect(explicit.networkUrls.proofServer).toBe("http://proof:6300");
  });
});

describe("redaction (FR-015)", () => {
  test("redactConfig replaces the seed and keeps everything else", async () => {
    const cfg = await parse();
    const redacted = redactConfig(cfg);
    expect(redacted.seed).toBe("[redacted 64 hex chars]");
    expect(redacted.seed).not.toContain(POSTER_SEED);
    expect(redacted.seedSource).toBe("POSTER_SEED");
    expect(redacted.giveColour).toBe(cfg.giveColour);
  });

  test("configDump contains no seed material and survives bigints", async () => {
    const cfg = await parse({ GIVE_AMOUNT: "250000" });
    const dump = configDump(cfg);
    expect(dump).not.toContain(POSTER_SEED);
    expect(dump).not.toContain(POSTER_SEED.slice(-16));
    expect(dump).toContain("[redacted 64 hex chars]");
    expect(JSON.parse(dump).giveAmount).toBe("250000");
  });

  test("a mnemonic never reaches the dump either", async () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const cfg = await parsePosterConfig(
      { POSTER_MNEMONIC: phrase, MIDNIGHT_CONTRACT_ADDRESS: PREPROD_CONTRACT },
      noFiles,
    );
    const dump = configDump(cfg);
    expect(dump).not.toContain("abandon");
    expect(dump).toContain("[redacted 128 hex chars]");
    expect(dump).toContain("POSTER_MNEMONIC"); // the SOURCE is safe to log
  });
});
