// One refresh cycle: fetch each non-fixed asset, write it, record what
// happened. Everything the cycle needs from the world — the network, the
// clock, the sleep — is injected, so the tests exercise the real control flow
// (spacing, the 429 stop, partial failure) without a network or a wall clock.

import {
  FIXED_ASSET_IDS,
  upsertAssetPriceFeed,
  upsertPriceFeedStatus,
} from "@zswap-da/database";

import {
  CoinGeckoError,
  COINGECKO_PROVIDER,
  formatRateLimit,
  type AssetQuote,
  type RateLimit,
} from "./coingecko.ts";

/**
 * The slice of a `pg.Client` the prepared queries need. Positional
 * `(text, values)` because that is the shape `@pgtyped/runtime`'s
 * `PreparedQuery.run` calls — not the `{ text, values }` object form pg also
 * accepts.
 */
export interface DbConnection {
  // `any[]` and the required rowCount are pgtyped's own IDatabaseConnection
  // shape — the prepared queries are typed against it, so narrowing here would
  // only force a cast at every call site.
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

export interface CycleDeps {
  db: DbConnection;
  fetchAsset: (assetId: string) => Promise<AssetQuote>;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface CycleOptions {
  assetIds: readonly string[];
  spacingMs: number;
  provider?: string;
}

export interface CycleFailure {
  assetId: string;
  kind: string;
  message: string;
}

export interface CycleResult {
  /** Assets whose row was rewritten, in request order. */
  updated: string[];
  /** Assets that were requested and did not land. */
  failed: CycleFailure[];
  /**
   * Assets that were never requested at all: a `fixed` peg someone put in
   * PRICE_FEED_ASSETS. Not a failure — the cycle is still "ok".
   */
  skipped: string[];
  /** True when a 429 ended the cycle early; the remaining assets were not requested. */
  stoppedOnRateLimit: boolean;
  /** Assets the cycle never reached because of the 429. */
  notRequested: string[];
  /** The last rate-limit headers seen, if the provider sends any. */
  rateLimit: RateLimit;
  /** null when every requested asset landed. */
  error: string | null;
}

/**
 * Run one cycle.
 *
 * Failure policy, in order of severity:
 *   429      stop immediately. The cycle keeps everything already written and
 *            records the error. Continuing would burn credits on calls the
 *            provider has already said it will refuse, and on the demo plan
 *            the budget is a month long — a tight retry loop is how you lose
 *            the whole month in an afternoon.
 *   other    record and CONTINUE to the next asset. One delisted id or one
 *            502 must not cost the other three their daily refresh.
 *   fixed    never requested (see FIXED_ASSET_IDS). The DB guard on
 *            upsertAssetPriceFeed is the backstop if this list is ever wrong.
 *
 * The last good prices always survive a failure: nothing is deleted, and a
 * row is only ever overwritten by a successful fetch.
 */
export async function runCycle(deps: CycleDeps, options: CycleOptions): Promise<CycleResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const provider = options.provider ?? COINGECKO_PROVIDER;

  const requestable = options.assetIds.filter((id) => !FIXED_ASSET_IDS.includes(id));
  const skipped = options.assetIds.filter((id) => FIXED_ASSET_IDS.includes(id));
  for (const id of skipped) {
    log(`[price-feed] ${id}: fixed peg — not requested`);
  }

  const updated: string[] = [];
  const failed: CycleFailure[] = [];
  let rateLimit: RateLimit = {};
  let stoppedOnRateLimit = false;
  let requestedCount = 0;

  for (const assetId of requestable) {
    // Spacing goes BEFORE every request but the first, so a one-asset cycle
    // costs no delay and an n-asset cycle waits n-1 times.
    if (requestedCount > 0) await deps.sleep(options.spacingMs);
    requestedCount++;

    let quote: AssetQuote;
    try {
      quote = await deps.fetchAsset(assetId);
    } catch (error) {
      const asCg = error instanceof CoinGeckoError ? error : null;
      if (asCg?.rateLimit !== undefined) rateLimit = asCg.rateLimit;
      const kind = asCg?.kind ?? "unknown";
      const message = String((error as Error)?.message ?? error);
      failed.push({ assetId, kind, message });
      log(`[price-feed] ${assetId}: FAILED (${kind}) ${message}`);
      if (kind === "rate_limit") {
        stoppedOnRateLimit = true;
        break;
      }
      continue;
    }

    rateLimit = quote.rateLimit;
    const written = await upsertAssetPriceFeed.run(
      {
        asset_id: assetId,
        price_usd: quote.usd,
        provider_updated_at: quote.providerUpdatedAt,
      },
      deps.db,
    );
    if (written.length === 0) {
      // The row exists and is `fixed`. Not in FIXED_ASSET_IDS, so this file's
      // list has drifted from the database's — say so rather than reporting a
      // silent success.
      skipped.push(assetId);
      log(`[price-feed] ${assetId}: refused by the database (fixed row) — price NOT written`);
      continue;
    }
    updated.push(assetId);
    log(
      `[price-feed] ${assetId} usd=${quote.usd} provider_updated_at=${quote.providerUpdatedAt ?? "-"}`,
    );
  }

  const notRequested = stoppedOnRateLimit
    ? requestable.slice(requestedCount)
    : [];

  const rateLimitLine = formatRateLimit(rateLimit);
  if (rateLimitLine !== null) log(`[price-feed] rate limit: ${rateLimitLine}`);

  const error =
    failed.length === 0
      ? null
      : failed.map((f) => `${f.assetId}: ${f.message}`).join("; ") +
        (notRequested.length > 0 ? ` (not requested: ${notRequested.join(", ")})` : "");

  const runAt = now().toISOString();
  await upsertPriceFeedStatus.run(
    {
      provider,
      last_run_at: runAt,
      last_ok_at: error === null ? runAt : null,
      last_error: error,
    },
    deps.db,
  );

  log(
    `[price-feed] cycle done: ${updated.length} updated, ${failed.length} failed` +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : "") +
      (stoppedOnRateLimit ? " — STOPPED on 429" : ""),
  );

  return { updated, failed, skipped, stoppedOnRateLimit, notRequested, rateLimit, error };
}
