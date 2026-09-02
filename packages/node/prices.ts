// Where a token's USD price comes from, in one place.
//
// Resolution order (D6 of the master plan), highest first:
//
//   1. token_prices row with source='manual'   an operator's override. Wins
//      over everything and is never rewritten by anything.
//   2. the token's ASSET price ÷ 10^decimals   asset_prices, reached through
//      known_tokens.asset_id or the NAME map in @zswap-da/database. Source is
//      the asset's own: feed | seed.
//   3. token_prices row with source='fallback' the deterministic demo price,
//      already written by an earlier quote.
//   4. write the deterministic demo price once and use it.
//
// (2) before (3) matters and is a real behaviour change: a token that was
// quoted before it had a mapping carries a `fallback` row forever, and under
// the old "any row wins" rule that row would keep a WBTC registered after its
// first quote on a hash price for the life of the database.
//
// Step 4 is the only step that writes, and only the quote path takes it —
// listing prices must never create rows for tokens nobody asked about.

import {
  getAssetPrices,
  getKnownTokenByColor,
  getKnownTokensWithAssets,
  getPriceFeedStatus,
  getTokenPriceRow,
  getTokenPriceRows,
  resolveAssetId,
  toDecimalString,
  tokenPriceFromAsset,
  upsertTokenPrice,
  type PriceMapEntry,
} from "@zswap-da/database";

import { priceMapOverrides, sponsorDiscount } from "./env.ts";
import { priceOf } from "./market-mock.ts";

/** The provider the price feed writes. One provider today; the field is not a guess. */
const DEFAULT_PROVIDER = "coingecko";

export type TokenPriceSource = "feed" | "seed" | "manual" | "fallback";

export interface ResolvedTokenPrice {
  /** USD per BASE UNIT, as an exact decimal string. */
  price_usd: string;
  source: TokenPriceSource;
  updated_at: string;
}

interface AssetRow {
  asset_id: string;
  price_usd: string;
  source: string;
  provider_updated_at: string | null;
  updated_at: string;
}

interface TokenRow {
  token_color: string;
  name: string;
  kind: string;
  decimals: number;
  asset_id: string | null;
}

/**
 * Everything that is the same for every token in one request: the five asset
 * rows and the parsed PRICE_FEED_MAP. Loaded once so a quote costs two
 * per-token reads rather than two full scans, and so /v1/prices is not N+1.
 */
export interface PricingContext {
  assets: Map<string, AssetRow>;
  overrides: ReadonlyMap<string, PriceMapEntry>;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

export async function loadPricingContext(dbConn: any): Promise<PricingContext> {
  const rows = (await getAssetPrices.run(undefined, dbConn)) as unknown as AssetRow[];
  return {
    assets: new Map(rows.map((row) => [row.asset_id, row])),
    overrides: priceMapOverrides(),
  };
}

/**
 * Steps 1-3 only: the read-only half of the order above. Returns null when the
 * token has no price at all — the caller decides whether that means "write the
 * demo price" (a quote) or "leave it out of the list" (/v1/prices).
 */
function resolveWithoutWriting(
  token: TokenRow | undefined,
  existing: { price_usd: string; source: string; updated_at: unknown } | undefined,
  ctx: PricingContext,
): ResolvedTokenPrice | null {
  if (existing?.source === "manual") {
    return { price_usd: existing.price_usd, source: "manual", updated_at: iso(existing.updated_at) };
  }

  if (token !== undefined) {
    const mapped = resolveAssetId(token, ctx.overrides);
    const asset = mapped === null ? undefined : ctx.assets.get(mapped.assetId);
    if (mapped !== null && asset !== undefined) {
      return {
        price_usd: tokenPriceFromAsset(asset.price_usd, mapped.decimals),
        // 'seed' | 'feed', constrained by the CHECK on asset_prices.
        source: asset.source as TokenPriceSource,
        updated_at: iso(asset.updated_at),
      };
    }
  }

  if (existing !== undefined) {
    return { price_usd: existing.price_usd, source: "fallback", updated_at: iso(existing.updated_at) };
  }
  return null;
}

/**
 * The quote path's resolution: always answers, writing the deterministic demo
 * price once if it has to. That write is the pre-existing behaviour and is
 * kept so repeated quotes for an unmapped registered token stay consistent and
 * an operator can override the row by hand.
 */
export async function resolveTokenPrice(
  dbConn: any,
  color: string,
  ctx: PricingContext,
): Promise<ResolvedTokenPrice> {
  const existing = (await getTokenPriceRow.run({ token_color: color }, dbConn))[0];
  const token = (await getKnownTokenByColor.run({ token_color: color }, dbConn))[0] as
    | TokenRow
    | undefined;

  const resolved = resolveWithoutWriting(token, existing, ctx);
  if (resolved !== null) return resolved;

  const fallback = priceOf(color);
  await upsertTokenPrice.run({ token_color: color, price_usd: fallback }, dbConn);
  return {
    price_usd: toDecimalString(fallback),
    source: "fallback",
    updated_at: new Date().toISOString(),
  };
}

export interface PricesResponse {
  sponsor_discount: number;
  feed: {
    provider: string;
    last_run_at: string | null;
    last_ok_at: string | null;
    last_error: string | null;
  };
  assets: {
    asset_id: string;
    price_usd: string;
    source: string;
    provider_updated_at: string | null;
    updated_at: string;
  }[];
  tokens: {
    token_color: string;
    name: string;
    kind: string;
    decimals: number;
    asset_id: string | null;
    price_usd: string;
    source: TokenPriceSource;
    updated_at: string;
  }[];
}

/**
 * GET /v1/prices' whole body. Read-only: a token with no price at all is
 * simply absent from `tokens` rather than being given a demo row here — this
 * endpoint is polled (by the batcher, every ten minutes), and an endpoint that
 * writes on read would fill token_prices with demo rows for colours nobody
 * ever traded.
 */
export async function listPrices(dbConn: any): Promise<PricesResponse> {
  const ctx = await loadPricingContext(dbConn);
  // Sequential, not Promise.all: `dbConn` is ONE pg client (PGLITE=true is
  // single-connection mode), and pg queues concurrent queries on a client with
  // a deprecation warning rather than running them in parallel. Three
  // small reads in a row cost nothing and keep the connection honest.
  const statusRows = await getPriceFeedStatus.run(undefined, dbConn);
  const tokenRows = await getKnownTokensWithAssets.run(undefined, dbConn);
  const priceRows = await getTokenPriceRows.run(undefined, dbConn);

  const overrides = new Map(
    (priceRows as unknown as { token_color: string; price_usd: string; source: string; updated_at: unknown }[]).map(
      (row) => [row.token_color, row],
    ),
  );

  const status = statusRows[0];
  const tokens: PricesResponse["tokens"] = [];
  for (const token of tokenRows as unknown as TokenRow[]) {
    const resolved = resolveWithoutWriting(token, overrides.get(token.token_color), ctx);
    if (resolved === null) continue;
    tokens.push({
      token_color: token.token_color,
      name: token.name,
      kind: token.kind,
      decimals: token.decimals,
      asset_id: token.asset_id,
      ...resolved,
    });
  }

  return {
    sponsor_discount: sponsorDiscount(),
    feed: {
      provider: status?.provider ?? DEFAULT_PROVIDER,
      last_run_at: isoOrNull(status?.last_run_at),
      last_ok_at: isoOrNull(status?.last_ok_at),
      last_error: status?.last_error ?? null,
    },
    assets: [...ctx.assets.values()].map((asset) => ({
      asset_id: asset.asset_id,
      price_usd: asset.price_usd,
      source: asset.source,
      provider_updated_at: isoOrNull(asset.provider_updated_at),
      updated_at: iso(asset.updated_at),
    })),
    tokens,
  };
}
