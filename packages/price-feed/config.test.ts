import { describe, expect, test } from "bun:test";
import { parsePriceMapEnv, SEEDED_ASSET_IDS } from "@zswap-da/database";

import { CoinGeckoError, COINGECKO_BASE_URL, fetchAssetPrices } from "./src/coingecko.ts";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SPACING_MS,
  loadPriceFeedConfig,
} from "./src/config.ts";
import { optionalString } from "./src/env.ts";

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

const optionalPriceFeedEnv = (value: string | undefined) => ({
  COINGECKO_BASE_URL: value,
  PRICE_FEED_INTERVAL_MS: value,
  PRICE_FEED_BATCH_SIZE: value,
  PRICE_FEED_REQUEST_SPACING_MS: value,
  PRICE_FEED_REQUEST_TIMEOUT_MS: value,
  PRICE_FEED_ASSETS: value,
});

describe("optionalString", () => {
  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", " \t "],
  ])("%s selects the fallback", (_label, value) => {
    expect(withEnv({ OPTIONAL_STRING_TEST: value }, () => optionalString("OPTIONAL_STRING_TEST", "fallback")))
      .toBe("fallback");
  });

  test("a nonblank value is trimmed and preserved", () => {
    expect(withEnv({ OPTIONAL_STRING_TEST: "  custom  " }, () => optionalString("OPTIONAL_STRING_TEST", "fallback")))
      .toBe("custom");
  });
});

describe("loadPriceFeedConfig blank-as-unset behavior", () => {
  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", " \t "],
  ])("%s optional provider values select their existing defaults", (_label, value) => {
    const config = withEnv(optionalPriceFeedEnv(value), loadPriceFeedConfig);
    expect(config.baseUrl).toBe(COINGECKO_BASE_URL);
    expect(config.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(config.batchSize).toBe(DEFAULT_BATCH_SIZE);
    expect(config.spacingMs).toBe(DEFAULT_SPACING_MS);
    expect(config.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(config.assetIds).toEqual([...SEEDED_ASSET_IDS]);
  });

  test.each([
    [undefined],
    [""],
    [" \t "],
  ])("PRICE_FEED_MAP=%p remains an empty override map", (value) => {
    expect(parsePriceMapEnv(value)).toEqual(new Map());
  });

  test("a custom base URL is trimmed and nonblank numeric values retain ENV.getNumber parsing", () => {
    const config = withEnv(
      {
        ...optionalPriceFeedEnv(undefined),
        COINGECKO_BASE_URL: "  https://prices.example.test/api/v3/  ",
        PRICE_FEED_INTERVAL_MS: " 1234 ",
        PRICE_FEED_BATCH_SIZE: " 12 ",
        PRICE_FEED_REQUEST_SPACING_MS: " 45 ",
        PRICE_FEED_REQUEST_TIMEOUT_MS: " 6789 ",
      },
      loadPriceFeedConfig,
    );
    expect(config.baseUrl).toBe("https://prices.example.test/api/v3/");
    expect(config.intervalMs).toBe(1234);
    expect(config.batchSize).toBe(12);
    expect(config.spacingMs).toBe(45);
    expect(config.requestTimeoutMs).toBe(6789);
  });

  test("nonblank malformed values are preserved and fail downstream instead of becoming defaults", async () => {
    const config = withEnv(
      {
        ...optionalPriceFeedEnv(undefined),
        COINGECKO_BASE_URL: " not a URL ",
        PRICE_FEED_BATCH_SIZE: "many",
      },
      loadPriceFeedConfig,
    );
    expect(config.baseUrl).toBe("not a URL");
    expect(config.baseUrl).not.toBe(COINGECKO_BASE_URL);
    expect(config.batchSize).toBeNaN();

    const validatingFetch = (async (input: RequestInfo | URL) => {
      new URL(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const error = await fetchAssetPrices(["bitcoin"], {
      apiKey: "not-a-real-key",
      baseUrl: config.baseUrl,
      fetchImpl: validatingFetch,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CoinGeckoError);
    expect((error as CoinGeckoError).kind).toBe("network");
  });

  test("blank optional DB names default while a deliberately blank password stays blank", () => {
    const config = withEnv(
      {
        DB_HOST: " ",
        DB_USER: " ",
        DB_NAME: " ",
        DB_PW: "",
      },
      loadPriceFeedConfig,
    );
    expect(config.db).toEqual({
      host: "127.0.0.1",
      port: 5432,
      user: "postgres",
      password: "",
      database: "postgres",
    });
  });
});
