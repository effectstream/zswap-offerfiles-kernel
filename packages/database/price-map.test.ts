import { expect, test } from "bun:test";

// The name→asset map and the per-base-unit conversion. Pure functions, no DB:
// the DB half (that the seeds match this map) is asset-prices.test.ts.
import {
  DEFAULT_NAME_ASSET_MAP,
  FEED_ASSET_IDS,
  FIXED_ASSET_IDS,
  SEEDED_ASSET_IDS,
  parsePriceMapEnv,
  priceMapKey,
  resolveAssetId,
  tokenPriceFromAsset,
} from "./price-map.ts";

const COLOR_USDC = "1".repeat(64);
const COLOR_TEST = "a".repeat(64);

// ── name matching ──────────────────────────────────────────────────────────

test("default map matches names case-insensitively", () => {
  for (const [name, assetId] of [
    ["WBTC", "bitcoin"],
    ["wbtc", "bitcoin"],
    ["wsBTC", "bitcoin"],
    ["BTC", "bitcoin"],
    ["WETH", "ethereum"],
    ["weth", "ethereum"],
    ["wsETH", "ethereum"],
    ["ETH", "ethereum"],
    ["USDC", "usd-coin"],
    ["usdm", "usdm"],
    ["night", "midnight-3"],
  ] as const) {
    expect(resolveAssetId({ name })?.assetId).toBe(assetId);
  }
});

test("an unmapped name resolves to nothing (test tokens stay unpriced)", () => {
  expect(resolveAssetId({ name: "TESTTOKENA" })).toBeNull();
  expect(resolveAssetId({ name: "" })).toBeNull();
});

test("decimals default to 0 and come from the token row otherwise", () => {
  expect(resolveAssetId({ name: "WBTC" })?.decimals).toBe(0);
  expect(resolveAssetId({ name: "USDM", decimals: 6 })?.decimals).toBe(6);
});

// ── precedence ─────────────────────────────────────────────────────────────

test("known_tokens.asset_id wins over the env map and over the default map", () => {
  const env = parsePriceMapEnv("WBTC=ethereum");
  expect(resolveAssetId({ name: "WBTC", asset_id: "usd-coin" }, env)?.assetId).toBe("usd-coin");
});

test("the env map wins over the default map", () => {
  const env = parsePriceMapEnv("WBTC=ethereum");
  expect(resolveAssetId({ name: "WBTC" }, env)?.assetId).toBe("ethereum");
});

test("an env entry keyed by colour wins over one keyed by name", () => {
  const env = parsePriceMapEnv(`WBTC=ethereum,${COLOR_TEST.toUpperCase()}=usd-coin`);
  expect(
    resolveAssetId({ name: "WBTC", token_color: COLOR_TEST }, env)?.assetId,
  ).toBe("usd-coin");
});

test("env decimals override the registered decimals even when the DB set the asset", () => {
  const env = parsePriceMapEnv("USDM=usdm:8");
  const resolved = resolveAssetId({ name: "USDM", asset_id: "usdm", decimals: 6 }, env);
  expect(resolved).toEqual({ assetId: "usdm", decimals: 8 });
});

test("the env map can price a token the default map never heard of", () => {
  const env = parsePriceMapEnv(` TESTTOKENA = bitcoin : 8 `);
  expect(resolveAssetId({ name: "TESTTOKENA" }, env)).toEqual({
    assetId: "bitcoin",
    decimals: 8,
  });
});

// ── env parsing ────────────────────────────────────────────────────────────

test("an empty or absent PRICE_FEED_MAP is an empty map, not an error", () => {
  expect(parsePriceMapEnv(undefined).size).toBe(0);
  expect(parsePriceMapEnv(null).size).toBe(0);
  expect(parsePriceMapEnv("").size).toBe(0);
  expect(parsePriceMapEnv("   ").size).toBe(0);
  expect(parsePriceMapEnv("WBTC=bitcoin,,").size).toBe(1);
});

test("a malformed entry throws — a typo must not silently price nothing", () => {
  expect(() => parsePriceMapEnv("WBTC")).toThrow(/NAME_OR_COLOR=asset_id/);
  expect(() => parsePriceMapEnv("=bitcoin")).toThrow(/NAME_OR_COLOR=asset_id/);
  expect(() => parsePriceMapEnv("WBTC=")).toThrow(/empty asset id/);
  expect(() => parsePriceMapEnv("WBTC=bitcoin:x")).toThrow(/non-integer decimals/);
  expect(() => parsePriceMapEnv("WBTC=bitcoin:99")).toThrow(/decimals > 38/);
});

test("colours are keyed lower-case, names upper-case", () => {
  expect(priceMapKey(COLOR_USDC.toUpperCase())).toBe(COLOR_USDC);
  expect(priceMapKey(" wbtc ")).toBe("WBTC");
});

// ── per-base-unit conversion ───────────────────────────────────────────────

test("tokenPriceFromAsset divides exactly, with no float noise and no toFixed", () => {
  // 0 decimals: base unit == coin, the faucet's shape.
  expect(tokenPriceFromAsset("77387", 0)).toBe("77387");
  expect(tokenPriceFromAsset("2393.28", 0)).toBe("2393.28");
  // 6 decimals: USDM's shape — one base unit of a $1 peg.
  expect(tokenPriceFromAsset("1", 6)).toBe("0.000001");
  expect(tokenPriceFromAsset("0.999818", 6)).toBe("0.000000999818");
  // 8 decimals: what a wrapped-BTC bridge would use. 77387/1e8 in doubles is
  // 0.0007738700000000001 — the string result must not carry that tail.
  expect(tokenPriceFromAsset("77387", 8)).toBe("0.00077387");
  expect(Number(tokenPriceFromAsset("77387", 8))).toBeCloseTo(77387 / 1e8, 20);
  // 18 decimals: toFixed(8) would render this as "0.00000000".
  expect(tokenPriceFromAsset("2393.28", 18)).toBe("0.00000000000000239328");
});

test("tokenPriceFromAsset accepts numbers, including exponent spellings", () => {
  expect(tokenPriceFromAsset(0.01918181, 0)).toBe("0.01918181");
  expect(tokenPriceFromAsset(1e-7, 0)).toBe("0.0000001");
  expect(tokenPriceFromAsset(1e21, 0)).toBe("1000000000000000000000");
  expect(tokenPriceFromAsset(0, 6)).toBe("0");
});

test("tokenPriceFromAsset rejects nonsense rather than returning NaN", () => {
  expect(() => tokenPriceFromAsset("abc", 0)).toThrow(/not a decimal number/);
  expect(() => tokenPriceFromAsset("1", -1)).toThrow(/\[0, 38\]/);
  expect(() => tokenPriceFromAsset("1", 39)).toThrow(/\[0, 38\]/);
  expect(() => tokenPriceFromAsset("1", 1.5)).toThrow(/\[0, 38\]/);
});

// ── asset id lists ─────────────────────────────────────────────────────────

test("the feed asset list is the seeded list minus the pegs", () => {
  expect(FIXED_ASSET_IDS).toEqual(["usdm"]);
  expect(FEED_ASSET_IDS).toEqual(["bitcoin", "ethereum", "usd-coin", "midnight-3"]);
  expect(new Set(SEEDED_ASSET_IDS)).toEqual(
    new Set([...FEED_ASSET_IDS, ...FIXED_ASSET_IDS]),
  );
});

test("every asset the default map points at is seeded", () => {
  for (const entry of DEFAULT_NAME_ASSET_MAP.values()) {
    expect(SEEDED_ASSET_IDS).toContain(entry.assetId);
  }
});
