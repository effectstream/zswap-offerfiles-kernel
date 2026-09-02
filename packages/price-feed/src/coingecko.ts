// The CoinGecko half of the price feed: ONE asset per request.
//
// `simple/price` accepts a comma-separated `ids` list, and one batched call
// would obviously be cheaper. It is deliberately not used. The demo plan bills
// in credits whose per-call cost is not documented per endpoint, the whole
// budget is 10 000 a month, and a batched call is all-or-nothing: one bad id,
// one truncated body, and the cycle updates nothing. Per-asset requests spaced
// a second apart cost 5 calls a day (SC-004), keep a partial failure partial,
// and stay two orders of magnitude under the 100 req/min ceiling.

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

export class CoinGeckoError extends Error {
  constructor(
    message: string,
    readonly kind: CoinGeckoErrorKind,
    readonly assetId: string,
    readonly status?: number,
    readonly rateLimit?: RateLimit,
  ) {
    super(message);
    this.name = "CoinGeckoError";
  }
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
 * Fetch one asset's USD price.
 *
 * The key travels as the `x-cg-demo-api-key` HEADER and never as a query
 * parameter, even though CoinGecko accepts `x_cg_demo_api_key=` in the URL:
 * query strings land in access logs, proxy logs, browser history and error
 * reports, and this key is shared, unrotated (Q-7) and long-lived.
 */
export async function fetchAssetPrice(
  assetId: string,
  options: FetchAssetOptions,
): Promise<AssetQuote> {
  const baseUrl = (options.baseUrl ?? COINGECKO_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const url =
    `${baseUrl}/simple/price?ids=${encodeURIComponent(assetId)}` +
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
    throw new CoinGeckoError(`${assetId}: request failed (${reason})`, "network", assetId);
  } finally {
    clearTimeout(timer);
  }

  const rateLimit = readRateLimit(response.headers);

  if (response.status === 429) {
    throw new CoinGeckoError(
      `${assetId}: rate limited (429)${formatRateLimit(rateLimit) ? ` — ${formatRateLimit(rateLimit)}` : ""}`,
      "rate_limit",
      assetId,
      429,
      rateLimit,
    );
  }
  if (!response.ok) {
    throw new CoinGeckoError(
      `${assetId}: HTTP ${response.status}`,
      "http",
      assetId,
      response.status,
      rateLimit,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CoinGeckoError(`${assetId}: response body is not JSON`, "malformed", assetId, response.status, rateLimit);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    // An array is checked explicitly: `[]["bitcoin"]` is undefined, so without
    // this an array body would be reported as "unknown id" and send an
    // operator looking at the asset list instead of at the endpoint.
    throw new CoinGeckoError(`${assetId}: response is not an object`, "malformed", assetId, response.status, rateLimit);
  }
  const entry = (body as Record<string, unknown>)[assetId];
  if (entry === undefined) {
    // A valid answer that simply does not know the id — a renamed or delisted
    // coin. Distinguished from `malformed` because the fix is a config change,
    // not a retry.
    throw new CoinGeckoError(
      `${assetId}: not present in the response (unknown id?)`,
      "missing",
      assetId,
      response.status,
      rateLimit,
    );
  }
  if (entry === null || typeof entry !== "object") {
    throw new CoinGeckoError(`${assetId}: entry is not an object`, "malformed", assetId, response.status, rateLimit);
  }

  const usdRaw = (entry as Record<string, unknown>)["usd"];
  if (typeof usdRaw !== "number" || !Number.isFinite(usdRaw) || usdRaw <= 0) {
    throw new CoinGeckoError(
      `${assetId}: usd is ${JSON.stringify(usdRaw)}, expected a positive finite number`,
      "malformed",
      assetId,
      response.status,
      rateLimit,
    );
  }

  const updatedRaw = (entry as Record<string, unknown>)["last_updated_at"];
  const providerUpdatedAt =
    typeof updatedRaw === "number" && Number.isFinite(updatedRaw)
      ? new Date(updatedRaw * 1000).toISOString()
      : null;

  return {
    assetId,
    // Exact decimal spelling, not toFixed: the value lands in NUMERIC and is
    // served as a string.
    usd: toDecimalString(usdRaw),
    providerUpdatedAt,
    rateLimit,
  };
}
