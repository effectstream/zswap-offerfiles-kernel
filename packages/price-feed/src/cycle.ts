// One refresh cycle: fetch every asset in CHUNKS, write what came back, record
// what happened. Every asset is fetched — USD is the numeraire and nothing is
// pinned to it, so there is no "skip this one, it is a peg" case. Everything
// the cycle needs from the world — the network, the clock, the sleep — is
// injected, so the tests exercise the real control flow (chunking, spacing,
// the 429 stop, partial failure) without a network or a wall clock.

import { upsertAssetPriceFeed, upsertPriceFeedStatus } from "@zswap-da/database";

import {
  CoinGeckoError,
  COINGECKO_PROVIDER,
  describeIds,
  formatRateLimit,
  type BatchResult,
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
  /** One provider request for a whole chunk of ids. */
  fetchAssets: (assetIds: readonly string[]) => Promise<BatchResult>;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface CycleOptions {
  assetIds: readonly string[];
  spacingMs: number;
  /** Ids per provider request. Defaults to DEFAULT_BATCH_SIZE. */
  batchSize?: number;
  provider?: string;
}

/** Ids per `simple/price` call. CoinGecko accepts far more; 50 is the ruled default (Q-11). */
export const DEFAULT_BATCH_SIZE = 50;

/** Split ids into chunks of at most `size`, preserving order. */
export function chunkIds(assetIds: readonly string[], size: number): string[][] {
  const step = Number.isInteger(size) && size > 0 ? size : DEFAULT_BATCH_SIZE;
  const out: string[][] = [];
  for (let i = 0; i < assetIds.length; i += step) out.push(assetIds.slice(i, i + step));
  return out;
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
 * Assets are requested in CHUNKS of `batchSize` ids — one `simple/price` call
 * each — with `spacingMs` between chunks. Credits scale with the number of
 * chunks, not with the number of assets (Q-11).
 *
 * Failure policy, in order of severity:
 *   429        stop immediately. The cycle keeps everything already written and
 *              records the error. Continuing would burn credits on calls the
 *              provider has already said it will refuse, and on the demo plan
 *              the budget is a month long — a tight retry loop is how you lose
 *              the whole month in an afternoon.
 *   chunk      any other request-level failure (non-2xx, network, a body that
 *              is not an object) is recorded for EVERY id in that chunk, and
 *              the next chunk is still requested. Blaming one id would be a
 *              guess; skipping the rest would turn one 502 into a whole day
 *              without prices.
 *   one id     a 2xx response that cannot answer for a single id (delisted,
 *              malformed entry) fails only that id. The other ids in the same
 *              response are written normally — this is what makes batching
 *              safe rather than all-or-nothing.
 *
 * The last good prices always survive a failure: nothing is deleted, and a
 * row is only ever overwritten by a successful fetch.
 */
export async function runCycle(deps: CycleDeps, options: CycleOptions): Promise<CycleResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const provider = options.provider ?? COINGECKO_PROVIDER;

  const chunks = chunkIds(options.assetIds, options.batchSize ?? DEFAULT_BATCH_SIZE);

  const updated: string[] = [];
  const failed: CycleFailure[] = [];
  let rateLimit: RateLimit = {};
  let stoppedOnRateLimit = false;
  let requestedIds = 0;

  for (const [index, chunk] of chunks.entries()) {
    // Spacing goes BEFORE every request but the first, so a one-chunk cycle
    // costs no delay and an n-chunk cycle waits n-1 times.
    if (index > 0) await deps.sleep(options.spacingMs);
    requestedIds += chunk.length;

    let batch: BatchResult;
    try {
      batch = await deps.fetchAssets(chunk);
    } catch (error) {
      const asCg = error instanceof CoinGeckoError ? error : null;
      if (asCg?.rateLimit !== undefined) rateLimit = asCg.rateLimit;
      const kind = asCg?.kind ?? "unknown";
      const message = String((error as Error)?.message ?? error);
      // The request carried the whole chunk, so the whole chunk failed.
      for (const assetId of chunk) failed.push({ assetId, kind, message });
      log(`[price-feed] ${describeIds(chunk)}: REQUEST FAILED (${kind}) ${message}`);
      if (kind === "rate_limit") {
        stoppedOnRateLimit = true;
        break;
      }
      continue;
    }

    rateLimit = batch.rateLimit;

    for (const failure of batch.failures) {
      failed.push(failure);
      log(`[price-feed] ${failure.assetId}: FAILED (${failure.kind}) ${failure.message}`);
    }

    for (const quote of batch.quotes) {
      const written = await upsertAssetPriceFeed.run(
        {
          asset_id: quote.assetId,
          price_usd: quote.usd,
          provider_updated_at: quote.providerUpdatedAt,
        },
        deps.db,
      );
      if (written.length === 0) {
        // The upsert RETURNs the row it wrote, so no row means the database
        // refused the write. There is no rule left that can refuse one, so this
        // is a real anomaly (a schema that has drifted from this code) and must
        // be reported, not counted as a silent success.
        const message = "the database wrote no row for this asset";
        failed.push({ assetId: quote.assetId, kind: "not_written", message });
        log(`[price-feed] ${quote.assetId}: FAILED (not_written) ${message}`);
        continue;
      }
      updated.push(quote.assetId);
      log(
        `[price-feed] ${quote.assetId} usd=${quote.usd} provider_updated_at=${quote.providerUpdatedAt ?? "-"}`,
      );
    }
  }

  const notRequested = stoppedOnRateLimit ? options.assetIds.slice(requestedIds) : [];

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
      ` in ${chunks.length} request(s)` +
      (stoppedOnRateLimit ? " — STOPPED on 429" : ""),
  );

  return { updated, failed, stoppedOnRateLimit, notRequested, rateLimit, error };
}
