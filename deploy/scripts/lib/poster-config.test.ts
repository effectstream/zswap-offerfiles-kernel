import { describe, expect, test } from "bun:test";

import {
  ConfigError,
  configDump,
  parseGiveRange,
  parsePosterConfig,
  readEnv,
  resolveSeed,
} from "./poster-config.ts";

const SEED = "ab".repeat(32);
const GIVE = "12".repeat(32);
const WANT = "34".repeat(32);

const parse = (extra: Record<string, string | undefined> = {}) =>
  parsePosterConfig({ POSTER_SEED: SEED, GIVE_TOKEN: GIVE, WANT_TOKEN: WANT, ...extra });

describe("explicit externally issued token inventory", () => {
  test("requires both 64-hex token IDs and normalises case/prefix", async () => {
    await expect(parsePosterConfig({ POSTER_SEED: SEED })).rejects.toMatchObject({
      code: "MISSING",
      variable: "GIVE_TOKEN",
    });
    await expect(parse({ WANT_TOKEN: "not-a-token" })).rejects.toMatchObject({
      code: "MALFORMED",
      variable: "WANT_TOKEN",
    });
    const cfg = await parse({ GIVE_TOKEN: `0x${GIVE.toUpperCase()}` });
    expect(cfg.giveColour).toBe(GIVE);
    expect(cfg.wantColour).toBe(WANT);
    expect(cfg).not.toHaveProperty("contractAddress");
  });

  test("rejects equal legs and native NIGHT", async () => {
    await expect(parse({ WANT_TOKEN: GIVE })).rejects.toMatchObject({ code: "UNSUPPORTED_TOKEN" });
    await expect(parse({ GIVE_TOKEN: "0".repeat(64) })).rejects.toMatchObject({
      code: "UNSUPPORTED_TOKEN",
      variable: "GIVE_TOKEN",
    });
  });

  test("accepts arbitrary valid token IDs without a deployment file", async () => {
    const cfg = await parse({ MIDNIGHT_NETWORK_ID: "preprod" });
    expect(cfg.networkId).toBe("preprod");
    expect(cfg.networkUrls.node).toBe("https://rpc.preprod.midnight.network");
  });
});

describe("prefunded coin-size filters", () => {
  test("uses base units without assuming token decimals", async () => {
    const cfg = await parse({ GIVE_AMOUNT: "1000000000000000000" });
    expect(cfg.giveAmount).toBe(1_000_000_000_000_000_000n);
  });

  test("accepts a base-unit interval and rejects partial/conflicting ranges", async () => {
    expect(parseGiveRange({ GIVE_MIN: "100000000", GIVE_MAX: "1000000000000000000" })).toEqual({
      minBase: 100_000_000n,
      maxBase: 1_000_000_000_000_000_000n,
    });
    await expect(parse({ GIVE_MIN: "1" })).rejects.toMatchObject({ code: "MISSING" });
    await expect(parse({ GIVE_AMOUNT: "10", GIVE_MIN: "1", GIVE_MAX: "20" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
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

  test("blank values are absent and malformed values fail", async () => {
    expect(readEnv({ X: "  " }, "X")).toBeUndefined();
    await expect(parse({ GIVE_AMOUNT: "1.5" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ GIVE_MIN: "0", GIVE_MAX: "1" })).rejects.toMatchObject({
      code: "MALFORMED",
      variable: "GIVE_MIN",
    });
  });
});

describe("wallet and logging", () => {
  test("requires one wallet input and rejects seed collisions", async () => {
    await expect(resolveSeed({})).rejects.toBeInstanceOf(ConfigError);
    await expect(resolveSeed({ POSTER_SEED: SEED, SOLVER_SEED: SEED })).rejects.toMatchObject({
      code: "SEED_COLLISION",
    });
  });

  test("redacts the wallet seed and serialises bigint settings", async () => {
    const dump = configDump(await parse({ GIVE_AMOUNT: "250000" }));
    expect(dump).not.toContain(SEED);
    expect(JSON.parse(dump).giveAmount).toBe("250000");
  });

  test("honours endpoint and runtime overrides", async () => {
    const cfg = await parse({
      ZSWAP_API: "http://kernel:9999/",
      POST_INTERVAL_MS: "120000",
      DRY_RUN: "true",
    });
    expect(cfg.kernelBase).toBe("http://kernel:9999");
    expect(cfg.postIntervalMs).toBe(120_000);
    expect(cfg.dryRun).toBe(true);
  });

  test("normalises direct seeds and derives a valid mnemonic while enforcing XOR", async () => {
    expect(await resolveSeed({ POSTER_SEED: `0x${SEED.toUpperCase()}` })).toMatchObject({
      seed: SEED,
      source: "POSTER_SEED",
    });
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const derived = await resolveSeed({ POSTER_MNEMONIC: `  ${phrase.replaceAll(" ", "  ")}  ` });
    expect(derived.source).toBe("POSTER_MNEMONIC");
    expect(derived.seed).toMatch(/^[0-9a-f]{128}$/);
    await expect(resolveSeed({ POSTER_SEED: SEED, POSTER_MNEMONIC: phrase })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  test("rejects truncated seeds and collisions across prefixes/case", async () => {
    await expect(resolveSeed({ POSTER_SEED: "ab" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(resolveSeed({ POSTER_SEED: `0x${SEED.toUpperCase()}`, TAKER_SEED: SEED })).rejects.toMatchObject({
      code: "SEED_COLLISION",
      variable: "TAKER_SEED",
    });
  });

  test("retains documented runtime defaults with explicit external tokens", async () => {
    const cfg = await parse();
    expect(cfg).toMatchObject({
      networkId: "undeployed",
      giveAmount: 1n,
      postIntervalMs: 60_000,
      offerTtlMinutes: 60,
      reconcileIntervalMs: 60_000,
      maxReoffersPerTick: 1,
      shutdownGraceMs: 15_000,
      healthStaleTicks: 3,
      healthPort: 9977,
      dryRun: false,
      journalReset: false,
      postRetries: 24,
      liveTries: 40,
    });
  });

  test("blank optional knobs fall back but malformed numeric/boolean knobs fail", async () => {
    expect((await parse({ POST_INTERVAL_MS: " ", DRY_RUN: "" })).postIntervalMs).toBe(60_000);
    await expect(parse({ POST_INTERVAL_MS: "0" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ DRY_RUN: "perhaps" })).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(parse({ POSTER_HEALTH_PORT: "65536" })).rejects.toMatchObject({ code: "MALFORMED" });
  });

  test("honours all network endpoint overrides and the NODE_URL fallback", async () => {
    const cfg = await parse({
      MIDNIGHT_NETWORK_ID: "custom",
      MIDNIGHT_NODE_HTTP: "http://node",
      MIDNIGHT_INDEXER_HTTP: "http://indexer/graphql",
      MIDNIGHT_INDEXER_WS: "ws://indexer/graphql/ws",
      MIDNIGHT_PROOF_SERVER: "http://proof",
      NODE_URL: "http://kernel-alt/",
    });
    expect(cfg.networkUrls).toEqual({
      id: "custom",
      node: "http://node",
      indexer: "http://indexer/graphql",
      indexerWS: "ws://indexer/graphql/ws",
      proofServer: "http://proof",
    });
    expect(cfg.kernelBase).toBe("http://kernel-alt");
  });
});
