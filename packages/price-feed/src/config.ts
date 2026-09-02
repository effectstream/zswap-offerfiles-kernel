import { ENV } from "@effectstream/utils/node-env";
import { SEEDED_ASSET_IDS } from "@zswap-da/database";

import { COINGECKO_BASE_URL } from "./coingecko.ts";

export interface PriceFeedDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface PriceFeedConfig {
  /** null when COINGECKO_API_KEY is unset — the two modes handle that differently. */
  apiKey: string | null;
  baseUrl: string;
  /** Loop mode only: how long between cycles. Default 24 h. */
  intervalMs: number;
  /** Minimum gap between two requests. Default 1000 ms. */
  spacingMs: number;
  /** Asset ids per provider request. Default 50. */
  batchSize: number;
  /** Per-request timeout. */
  requestTimeoutMs: number;
  assetIds: string[];
  db: PriceFeedDbConfig;
}

export const DEFAULT_INTERVAL_MS = 86_400_000; // 24 h
export const DEFAULT_SPACING_MS = 1_000;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * DB_* rather than a DATABASE_URL, matching packages/tests/seed-market.ts and
 * the compose stack (DB_HOST: pglite). This process is the only writer of
 * asset_prices and needs nothing else from the kernel.
 */
export function loadPriceFeedConfig(): PriceFeedConfig {
  const key = ENV.getString("COINGECKO_API_KEY", "").trim();
  const assets = ENV.getString("PRICE_FEED_ASSETS", "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return {
    apiKey: key === "" ? null : key,
    baseUrl: ENV.getString("COINGECKO_BASE_URL", COINGECKO_BASE_URL),
    intervalMs: ENV.getNumber("PRICE_FEED_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    spacingMs: ENV.getNumber("PRICE_FEED_REQUEST_SPACING_MS", DEFAULT_SPACING_MS),
    batchSize: ENV.getNumber("PRICE_FEED_BATCH_SIZE", DEFAULT_BATCH_SIZE),
    requestTimeoutMs: ENV.getNumber("PRICE_FEED_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
    assetIds: assets.length > 0 ? assets : [...SEEDED_ASSET_IDS],
    db: {
      host: ENV.getString("DB_HOST", "127.0.0.1"),
      port: ENV.getNumber("DB_PORT", 5432),
      user: ENV.getString("DB_USER", "postgres"),
      password: ENV.getString("DB_PW", "postgres"),
      database: ENV.getString("DB_NAME", "postgres"),
    },
  };
}

/** One line describing the effective configuration. Never prints the key. */
export function describeConfig(config: PriceFeedConfig): string {
  return (
    `[price-feed] provider=coingecko base=${config.baseUrl} ` +
    `assets=${config.assetIds.join(",")} ` +
    `batch=${config.batchSize} ` +
    `requests/cycle=${Math.ceil(config.assetIds.length / Math.max(1, config.batchSize))} ` +
    `spacing=${config.spacingMs}ms ` +
    `interval=${config.intervalMs}ms db=${config.db.host}:${config.db.port}/${config.db.database} ` +
    `key=${config.apiKey === null ? "ABSENT" : "present"}`
  );
}
