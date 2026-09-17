// The CoinGecko half of the price feed: MANY assets per request.
//
// `simple/price` accepts a comma-separated `ids` list, and the feed uses it
// (Q-11): with thousands of mapped tokens, one request per asset would spend
// the 10 000-credit monthly demo budget on a single day's cycle. Credits now
// scale with ceil(assets / PRICE_FEED_BATCH_SIZE) — today's five assets are
// one call (SC-004).
//
// Batching was originally rejected because a batched call looked
// all-or-nothing. It is not, and this module is the reason: a 2xx body is
// parsed PER ID, so one delisted or malformed entry is reported as that id's
// failure and every other id in the same response is still written. Only a
// failure of the REQUEST itself (429, non-2xx, network, a body that is not an
// object) takes the whole chunk down, and the cycle then records every id in
// that chunk — never a silent partial write.

import { toDecimalString } from "@zswap-da/database";

export const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";
export const COINGECKO_PROVIDER = "coingecko";

/** What the provider told us about our remaining budget, when it says anything. */
export interface RateLimit {
  limit?: number;
  remaining?: number;
  reset?: string;
}

export interface AssetQuote {
  assetId: string;
  /** USD per coin, as an exact decimal string — it goes into a NUMERIC column. */
  usd: string;
  /** The provider's own `last_updated_at`, ISO-8601, or null if absent. */
  providerUpdatedAt: string | null;
  rateLimit: RateLimit;
}

export type CoinGeckoErrorKind =
  /** HTTP 429 — the one status that must stop the whole cycle. */
  | "rate_limit"
  /** Any other non-2xx. */
  | "http"
  /** 2xx whose body is not JSON, or not the documented shape. */
  | "malformed"
  /** 2xx JSON that simply has no entry for the id we asked about. */
  | "missing"
  /** The request never completed: DNS, connection, timeout, abort. */
  | "network";

/**
 * A failure of one REQUEST. `assetIds` is the whole chunk that request carried,
 * because a request-level failure cost every id in it — the cycle records them
 * all rather than guessing which one was to blame.
 */
export class CoinGeckoError extends Error {
  constructor(
    message: string,
    readonly kind: CoinGeckoErrorKind,
    readonly assetIds: readonly string[],
    readonly status?: number,
    readonly rateLimit?: RateLimit,
  ) {
    super(message);
    this.name = "CoinGeckoError";
  }
}

/** One id inside an otherwise good response that could not be used. */
export interface AssetFailure {
  assetId: string;
  kind: CoinGeckoErrorKind;
  message: string;
}

/** What one batched request produced. */
export interface BatchResult {
  /** Ids that parsed, in the order the chunk asked for them. */
  quotes: AssetQuote[];
  /** Ids the response answered badly, or not at all. */
  failures: AssetFailure[];
  rateLimit: RateLimit;
}

/** Short label for a chunk, so an error message does not carry 50 ids. */
export function describeIds(assetIds: readonly string[]): string {
  return assetIds.length <= 3
    ? assetIds.join(",")
    : `${assetIds.slice(0, 3).join(",")}+${assetIds.length - 3} more`;
}

export interface FetchAssetOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function readRateLimit(headers: Headers): RateLimit {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const out: RateLimit = {};
  const limit = num("x-ratelimit-limit");
  const remaining = num("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit !== undefined) out.limit = limit;
  if (remaining !== undefined) out.remaining = remaining;
  if (reset !== null) out.reset = reset;
  return out;
}

/** Human-readable rate-limit line for the logs, or null when the provider said nothing. */
export function formatRateLimit(rateLimit: RateLimit): string | null {
  const parts: string[] = [];
  if (rateLimit.remaining !== undefined) parts.push(`remaining=${rateLimit.remaining}`);
  if (rateLimit.limit !== undefined) parts.push(`limit=${rateLimit.limit}`);
  if (rateLimit.reset !== undefined) parts.push(`reset=${rateLimit.reset}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Fetch the USD price of every id in one chunk, with ONE request.
 *
 * The key travels as the `x-cg-demo-api-key` HEADER and never as a query
 * parameter, even though CoinGecko accepts `x_cg_demo_api_key=` in the URL:
 * query strings land in access logs, proxy logs, browser history and error
 * reports, and this key is shared, unrotated (Q-7) and long-lived.
 *
 * Throws `CoinGeckoError` when the REQUEST failed (the caller then treats the
 * whole chunk as failed, and stops the cycle on `rate_limit`). A resolved
 * result may still carry per-id `failures`: those ids are the only ones the
 * response could not answer.
 */
export async function fetchAssetPrices(
  assetIds: readonly string[],
  options: FetchAssetOptions,
): Promise<BatchResult> {
  if (assetIds.length === 0) return { quotes: [], failures: [], rateLimit: {} };

  const label = describeIds(assetIds);
  const baseUrl = (options.baseUrl ?? COINGECKO_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const url =
    `${baseUrl}/simple/price?ids=${assetIds.map((id) => encodeURIComponent(id)).join(",")}` +
    `&vs_currencies=usd&include_last_updated_at=true`;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-cg-demo-api-key": options.apiKey,
      },
      signal: controller.signal,
    });
  } catch (error) {
    const reason = controller.signal.aborted
      ? `no response within ${timeoutMs} ms`
      : String((error as Error)?.message ?? error);
    throw new CoinGeckoError(`${label}: request failed (${reason})`, "network", assetIds);
  } finally {
    clearTimeout(timer);
  }

  const rateLimit = readRateLimit(response.headers);

  if (response.status === 429) {
    throw new CoinGeckoError(
      `${label}: rate limited (429)${formatRateLimit(rateLimit) ? ` — ${formatRateLimit(rateLimit)}` : ""}`,
      "rate_limit",
      assetIds,
      429,
      rateLimit,
    );
  }
  if (!response.ok) {
    throw new CoinGeckoError(`${label}: HTTP ${response.status}`, "http", assetIds, response.status, rateLimit);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CoinGeckoError(`${label}: response body is not JSON`, "malformed", assetIds, response.status, rateLimit);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    // An array is checked explicitly: `[]["bitcoin"]` is undefined, so without
    // this an array body would be reported as "unknown id" for every id in the
    // chunk and send an operator looking at the asset list instead of at the
    // endpoint.
    throw new CoinGeckoError(`${label}: response is not an object`, "malformed", assetIds, response.status, rateLimit);
  }

  // From here the REQUEST succeeded. Everything else is per id: one bad entry
  // must not cost the other 49 their refresh.
  const quotes: AssetQuote[] = [];
  const failures: AssetFailure[] = [];
  const fail = (assetId: string, kind: CoinGeckoErrorKind, message: string) =>
    failures.push({ assetId, kind, message });

  for (const assetId of assetIds) {
    const entry = (body as Record<string, unknown>)[assetId];
    if (entry === undefined) {
      // A valid answer that simply does not know the id — a renamed or
      // delisted coin. Distinguished from `malformed` because the fix is a
      // config change, not a retry.
      fail(assetId, "missing", `${assetId}: not present in the response (unknown id?)`);
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      fail(assetId, "malformed", `${assetId}: entry is not an object`);
      continue;
    }

    const usdRaw = (entry as Record<string, unknown>)["usd"];
    if (typeof usdRaw !== "number" || !Number.isFinite(usdRaw) || usdRaw <= 0) {
      fail(
        assetId,
        "malformed",
        `${assetId}: usd is ${JSON.stringify(usdRaw)}, expected a positive finite number`,
      );
      continue;
    }

    const updatedRaw = (entry as Record<string, unknown>)["last_updated_at"];
    const providerUpdatedAt =
      typeof updatedRaw === "number" && Number.isFinite(updatedRaw)
        ? new Date(updatedRaw * 1000).toISOString()
        : null;

    quotes.push({
      assetId,
      // Exact decimal spelling, not toFixed: the value lands in NUMERIC and is
      // served as a string.
      usd: toDecimalString(usdRaw),
      providerUpdatedAt,
      rateLimit,
    });
  }

  return { quotes, failures, rateLimit };
}
