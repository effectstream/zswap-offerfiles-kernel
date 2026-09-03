import { expect, test } from "bun:test";

// The name→asset map and the per-base-unit conversion. Pure functions, no DB:
// the DB half (that the seeds match this map) is asset-prices.test.ts.
import {
  DEFAULT_NAME_ASSET_MAP,
  SEEDED_ASSET_IDS,
  parsePriceMapEnv,
  priceMapKey,
  resolveAssetId,
  toDecimalString,
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
    ["usdm", "usdm-2"],
    ["night", "midnight-3"],
  ] as const) {
    expect(resolveAssetId({ name })?.assetId).toBe(assetId);
  }
});

test("an unmapped name resolves to nothing (test tokens stay unpriced)", () => {
  expect(resolveAssetId({ name: "TESTTOKENA" })).toBeNull();
  expect(resolveAssetId({ name: "" })).toBeNull();
});

test("decimals default to 6 and come from the token row otherwise", () => {
  // 00024 FR-001: the registry default. Reached only for a PARTIAL token — the
  // column is NOT NULL, so a real row always states its own value.
  expect(resolveAssetId({ name: "WBTC" })?.decimals).toBe(6);
  expect(resolveAssetId({ name: "USDM", decimals: 6 })?.decimals).toBe(6);
  // A token that genuinely is 0 still says so and is believed.
  expect(resolveAssetId({ name: "WBTC", decimals: 0 })?.decimals).toBe(0);
});

test("a name-priced faucet token prices at the asset price / 10^6", () => {
  // WBTC is faucet-minted: no asset_id, priced BY NAME through
  // DEFAULT_NAME_ASSET_MAP, and since 00024 registered with 6 decimals. One
  // base unit is therefore a millionth of a coin.
  const mapped = resolveAssetId({ name: "WBTC", decimals: 6, asset_id: null })!;
  expect(mapped).toEqual({ assetId: "bitcoin", decimals: 6 });
  expect(tokenPriceFromAsset("77387", mapped.decimals)).toBe("0.077387");
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
  const env = parsePriceMapEnv("USDM=usdm-2:8");
  const resolved = resolveAssetId({ name: "USDM", asset_id: "usdm-2", decimals: 6 }, env);
  expect(resolved).toEqual({ assetId: "usdm-2", decimals: 8 });
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
  // 0 decimals: base unit == coin. Nothing this stack mints is 0 any more
  // (00024), but the arithmetic must still be exact for a token that is.
  expect(tokenPriceFromAsset("77387", 0)).toBe("77387");
  expect(tokenPriceFromAsset("2393.28", 0)).toBe("2393.28");
  // 6 decimals: USDM's shape. The asset is near a dollar but not on it, and
  // the division must carry that through instead of rounding it away.
  expect(tokenPriceFromAsset("1.001", 6)).toBe("0.000001001");
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

test("toDecimalString keeps the provider's spelling, without exponents", () => {
  expect(toDecimalString(77387)).toBe("77387");
  expect(toDecimalString(0.01918181)).toBe("0.01918181");
  expect(toDecimalString(0.999818)).toBe("0.999818");
  expect(toDecimalString(1e-7)).toBe("0.0000001");
  expect(toDecimalString("2393.2800")).toBe("2393.28");
  expect(() => toDecimalString("")).toThrow(/not a decimal number/);
});

test("tokenPriceFromAsset rejects nonsense rather than returning NaN", () => {
  expect(() => tokenPriceFromAsset("abc", 0)).toThrow(/not a decimal number/);
  expect(() => tokenPriceFromAsset("1", -1)).toThrow(/\[0, 38\]/);
  expect(() => tokenPriceFromAsset("1", 39)).toThrow(/\[0, 38\]/);
  expect(() => tokenPriceFromAsset("1", 1.5)).toThrow(/\[0, 38\]/);
});

// ── asset id lists ─────────────────────────────────────────────────────────

test("every seeded asset is fetched — the list is one list, in request order", () => {
  expect(SEEDED_ASSET_IDS).toEqual([
    "bitcoin",
    "ethereum",
    "usd-coin",
    "midnight-3",
    "usdm-2",
  ]);
});

test("every asset the default map points at is seeded", () => {
  for (const entry of DEFAULT_NAME_ASSET_MAP.values()) {
    expect(SEEDED_ASSET_IDS).toContain(entry.assetId);
  }
});
