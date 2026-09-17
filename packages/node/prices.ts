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
  getKnownTokensByColors,
  getPriceFeedStatus,
  getTokenPriceRow,
  getTokenPriceRows,
  resolveAssetId,
  toDecimalString,
  tokenPriceFromAsset,
  upsertTokenPrice,
  type PriceMapEntry,
} from "@zswap-da/database";

import type { PriceRow } from "@zswap-da/offer-guard";

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
): (ResolvedTokenPrice & { asset_used: string | null }) | null {
  if (existing?.source === "manual") {
    return {
      price_usd: existing.price_usd,
      source: "manual",
      updated_at: iso(existing.updated_at),
      // A manual override wins over the asset, so no asset explains this
      // price and /v1/prices must not list one as if it did.
      asset_used: null,
    };
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
        asset_used: asset.asset_id,
      };
    }
  }

  if (existing !== undefined) {
    return {
      price_usd: existing.price_usd,
      source: "fallback",
      updated_at: iso(existing.updated_at),
      asset_used: null,
    };
  }
  return null;
}

/**
 * Steps 1-3 for ONE colour, without writing anything. Returns null when the
 * token has no price at all.
 *
 * This is what the fee-sponsorship pre-check uses. It must NOT take the quote's
 * step 4 (write the demo price): a submission that is about to be refused would
 * otherwise leave a permanent `fallback` row behind for a colour nobody ever
 * traded, and — worse — the FIRST submission of an unmapped token would create
 * the row that makes the SECOND one look priced.
 */
export async function resolveTokenPriceReadOnly(
  dbConn: any,
  color: string,
  ctx: PricingContext,
): Promise<ResolvedTokenPrice | null> {
  const existing = (await getTokenPriceRow.run({ token_color: color }, dbConn))[0];
  const token = (await getKnownTokenByColor.run({ token_color: color }, dbConn))[0] as
    | TokenRow
    | undefined;
  return resolveWithoutWriting(token, existing, ctx);
}

/**
 * Price rows for a set of colours, in the shape `evaluateSponsorship` wants —
 * and by exactly the same resolution order the quote and `/v1/prices` use, so
 * the node's pre-check, the maker's quote and the batcher's gate all price a
 * token identically (D4/D6).
 *
 * A colour with no price at all is simply ABSENT from the map, which
 * `evaluateSponsorship` reads as unpriced — the same verdict a `fallback` row
 * produces. Reads are sequential and deduped: `dbConn` is one pg client, which
 * queues concurrent queries rather than running them in parallel.
 */
export async function pricesForColors(
  dbConn: any,
  colors: readonly string[],
): Promise<Map<string, PriceRow>> {
  const wanted = [...new Set(colors.map((color) => color.toLowerCase()))];
  const ctx = await loadPricingContext(dbConn);
  const prices = new Map<string, PriceRow>();
  for (const color of wanted) {
    const resolved = await resolveTokenPriceReadOnly(dbConn, color, ctx);
    if (resolved !== null) {
      prices.set(color, { price_usd: resolved.price_usd, source: resolved.source });
    }
  }
  return prices;
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
  if (resolved !== null) {
    const { asset_used: _unused, ...price } = resolved;
    return price;
  }

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

/** The most colours one `GET /v1/prices?tokens=` may name (Q-11). */
export const MAX_PRICE_TOKENS = 50;

/** A rejected `?tokens=` value, with the reason the 400 should carry. */
export interface TokensParamError {
  reason: string;
}

/**
 * Parse and validate the required `tokens` query parameter: 1-50 64-hex
 * colours, comma-separated. Returns the deduplicated, lower-cased list or the
 * reason it is not acceptable.
 *
 * Colours are NORMALISED to lower case rather than refused in upper case,
 * exactly as GET /v1/quote already treats `from_token`/`to_token`. Two routes
 * in one API disagreeing about the case of the same 64 hex characters would be
 * a trap, not a contract; the response always spells them lower case.
 */
export function parseTokensParam(raw: unknown): string[] | TokensParamError {
  if (raw === undefined || raw === null) {
    return { reason: `tokens is required: 1-${MAX_PRICE_TOKENS} comma-separated 64-hex token colors` };
  }
  if (typeof raw !== "string") {
    return { reason: "tokens must be a single comma-separated string" };
  }
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) {
    return { reason: `tokens is required: 1-${MAX_PRICE_TOKENS} comma-separated 64-hex token colors` };
  }
  // Bound BEFORE validating each entry: the length check is what stops a
  // megabyte of commas from costing 60 000 regex tests.
  if (parts.length > MAX_PRICE_TOKENS) {
    return { reason: `tokens accepts at most ${MAX_PRICE_TOKENS} colors, got ${parts.length}` };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const color = part.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(color)) {
      return { reason: `tokens entry "${part}" is not a 64-hex token color` };
    }
    if (seen.has(color)) continue;
    seen.add(color);
    out.push(color);
  }
  return out;
}

/**
 * GET /v1/prices' body for a BOUNDED set of colours.
 *
 * `tokens` is required (Q-11): the unfiltered form scaled with the size of the
 * registry, and both callers — the batcher's gate and the UI's Market header —
 * only ever want the two colours of the pair in front of them. A colour that
 * resolves to no price is silently absent rather than an error, because "this
 * token has no reference price" is an answer, not a client mistake. `assets`
 * carries only the assets that actually BACKED one of the returned prices, so
 * every row in it explains a row in `tokens`.
 *
 * Read-only: a token with no price at all is not given a demo row here. The
 * quote path still writes one (Q-11 keeps that deliberately, so an operator
 * can inspect and override it), but a lookup must not create state.
 */
export async function listPricesForTokens(
  dbConn: any,
  colors: readonly string[],
): Promise<PricesResponse> {
  const ctx = await loadPricingContext(dbConn);
  // Sequential, not Promise.all: `dbConn` is ONE pg client (PGLITE=true is
  // single-connection mode), and pg queues concurrent queries on a client with
  // a deprecation warning rather than running them in parallel. Three
  // small reads in a row cost nothing and keep the connection honest.
  const statusRows = await getPriceFeedStatus.run(undefined, dbConn);
  const wanted = [...colors];
  const tokenRows = await getKnownTokensByColors.run({ token_colors: wanted }, dbConn);
  const priceRows = await getTokenPriceRows.run({ token_colors: wanted }, dbConn);

  const overrides = new Map(
    (priceRows as unknown as { token_color: string; price_usd: string; source: string; updated_at: unknown }[]).map(
      (row) => [row.token_color, row],
    ),
  );

  const status = statusRows[0];
  const tokens: PricesResponse["tokens"] = [];
  const assetsUsed = new Set<string>();
  for (const token of tokenRows as unknown as TokenRow[]) {
    const resolved = resolveWithoutWriting(token, overrides.get(token.token_color), ctx);
    if (resolved === null) continue;
    const { asset_used: assetUsed, ...price } = resolved;
    if (assetUsed !== null) assetsUsed.add(assetUsed);
    tokens.push({
      token_color: token.token_color,
      name: token.name,
      kind: token.kind,
      decimals: token.decimals,
      asset_id: token.asset_id,
      ...price,
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
    assets: [...ctx.assets.values()]
      .filter((asset) => assetsUsed.has(asset.asset_id))
      .map((asset) => ({
        asset_id: asset.asset_id,
        price_usd: asset.price_usd,
        source: asset.source,
        provider_updated_at: isoOrNull(asset.provider_updated_at),
        updated_at: iso(asset.updated_at),
      })),
    tokens,
  };
}
