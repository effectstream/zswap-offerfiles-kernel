// Typed query wrappers for queries defined in queries.sql.
// These use dbConn.query() directly and mirror the PreparedQuery.run() interface
// so call sites are identical. Run `bun run pgtyped:update` when a live DB is
// available to regenerate queries.queries.ts with proper PreparedQuery objects,
// then move these exports there and delete this file.

import type { DateOrString, NumberOrString } from "./queries.queries.ts";

// Convert :param! style SQL to $N positional params and execute.
// Repeated occurrences of the same param reuse the same $N index.
async function runQ<P extends object, R>(
  sql: string,
  params: P,
  dbConn: any,
): Promise<R[]> {
  const seen = new Map<string, number>();
  let n = 0;
  const pgSql = sql.replace(/:(\w+)!/g, (_: string, name: string) => {
    if (!seen.has(name)) seen.set(name, ++n);
    return `$${seen.get(name)}`;
  });
  const values = [...seen.keys()].map((k) => (params as any)[k]);
  return (await dbConn.query(pgSql, values)).rows as R[];
}

async function runNoParams<R>(sql: string, dbConn: any): Promise<R[]> {
  return (await dbConn.query(sql)).rows as R[];
}

// ── Sync health — effectstream framework schema ────────────────────────────

export interface IGetNtpCurrentBlockResult {
  current: NumberOrString | null;
}
export const getNtpCurrentBlock = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetNtpCurrentBlockResult>(
      "SELECT MAX(block_height) AS current FROM effectstream.effectstream_blocks",
      dbConn,
    ),
};

export interface IGetSyncProtocolPaginationResult {
  protocol_name: string;
  merged: NumberOrString | null;
  fetched: NumberOrString | null;
}
export const getSyncProtocolPagination = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetSyncProtocolPaginationResult>(
      `SELECT protocol_name,
              MIN(page_number) AS merged,
              MAX(page_number) AS fetched
       FROM effectstream.sync_protocol_pagination
       GROUP BY protocol_name`,
      dbConn,
    ),
};

export interface IGetLatestEffectstreamBlockResult {
  block_height: NumberOrString;
  ms_timestamp: NumberOrString | null;
  effectstream_block_hash: Buffer | null;
  main_chain_block_hash: Buffer | null;
}
export const getLatestEffectstreamBlock = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetLatestEffectstreamBlockResult>(
      `SELECT block_height, ms_timestamp, effectstream_block_hash, main_chain_block_hash
       FROM effectstream.effectstream_blocks
       ORDER BY block_height DESC
       LIMIT 1`,
      dbConn,
    ),
};

export interface IGetNullifierStatsResult {
  total: number;
  latest_height: NumberOrString | null;
}
export const getNullifierStats = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetNullifierStatsResult>(
      "SELECT COUNT(*)::int AS total, MAX(height) AS latest_height FROM nullifiers",
      dbConn,
    ),
};

export interface IGetKnownRootStatsResult {
  total: number;
  latest_height: NumberOrString | null;
}
export const getKnownRootStats = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetKnownRootStatsResult>(
      "SELECT COUNT(*)::int AS total, MAX(height) AS latest_height FROM known_roots",
      dbConn,
    ),
};

export interface IGetUnshieldedStatsResult {
  total: number;
  latest_height: NumberOrString | null;
}
export const getUnshieldedStats = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetUnshieldedStatsResult>(
      "SELECT COUNT(*)::int AS total, MAX(height) AS latest_height FROM created_unshielded",
      dbConn,
    ),
};

export interface IGetLastOfferResult {
  id: number;
  celestia_height: NumberOrString;
  created_at: DateOrString | null;
}
export const getLastOffer = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetLastOfferResult>(
      `SELECT id, celestia_height, created_at
       FROM offer_file
       ORDER BY id DESC
       LIMIT 1`,
      dbConn,
    ),
};

// ── 24 h pair stats (full window, no row cap) ──────────────────────────────
//
// Computed in SQL over EVERY fill in the window. The old path derived stats
// from the display-history query and inherited its LIMIT 120, so any pair
// with >120 fills in 24 h reported understated volume, a truncated high/low
// window, and a change24 baselined on the 120th-newest trade mislabelled as
// "24 h ago". The display list keeps its cap; stats must not.
//
// One round trip, four scalar-subquery groups over a shared fills CTE:
//   last_price       — newest fill ever (not window-bound: a quiet pair still
//                      has a last traded price)
//   ref_before_24h   — newest fill at or older than the 24 h cutoff: the
//                      correct change24 baseline
//   oldest_in_24h    — fallback baseline when the pair's whole history is
//                      inside the window (change-since-inception)
//   window aggregates — high / low / volumes / fill count over ALL 24 h fills
//
// Zero-amount legs are excluded up front (price would be 0 or ∞) — same
// filter the old JS path applied per row.
export interface IGetPairStats24hParams {
  base: string;
  quote: string;
}
export interface IGetPairStats24hResult {
  last_price: string | null;
  ref_before_24h: string | null;
  oldest_in_24h: string | null;
  fills_24h: number;
  high_24h: string | null;
  low_24h: string | null;
  volume_base_24h: string | null;
  volume_quote_24h: string | null;
}
export const getPairStats24h = {
  run: (params: IGetPairStats24hParams, dbConn: any) =>
    runQ<IGetPairStats24hParams, IGetPairStats24hResult>(
      `WITH fills AS (
         SELECT h.archived_at,
                CASE WHEN g.token_color = :base!
                     THEN w.amount::numeric / g.amount::numeric
                     ELSE g.amount::numeric / w.amount::numeric END AS price,
                CASE WHEN g.token_color = :base!
                     THEN g.amount::numeric ELSE w.amount::numeric END AS base_amt,
                CASE WHEN g.token_color = :base!
                     THEN w.amount::numeric ELSE g.amount::numeric END AS quote_amt
         FROM offer_file_history h
         JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric) AS amount
               FROM offer_file_tokens_history
               WHERE direction = 'GIVING' AND token_color IN (:base!, :quote!)
               GROUP BY 1, 2) g ON g.offer_file_id = h.id
         JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric) AS amount
               FROM offer_file_tokens_history
               WHERE direction = 'WANTING' AND token_color IN (:base!, :quote!)
               GROUP BY 1, 2) w ON w.offer_file_id = h.id
         WHERE h.archive_reason = 'CONSUMED'
           AND NOT ${cancelledPredicate("h.id")}
           AND g.amount::numeric > 0
           AND w.amount::numeric > 0
           AND ((g.token_color = :base! AND w.token_color = :quote!)
             OR (g.token_color = :quote! AND w.token_color = :base!))
       )
       SELECT
         (SELECT price FROM fills ORDER BY archived_at DESC LIMIT 1)::text AS last_price,
         (SELECT price FROM fills
           WHERE archived_at <= NOW() - INTERVAL '24 hours'
           ORDER BY archived_at DESC LIMIT 1)::text AS ref_before_24h,
         (SELECT price FROM fills
           WHERE archived_at > NOW() - INTERVAL '24 hours'
           ORDER BY archived_at ASC LIMIT 1)::text AS oldest_in_24h,
         (SELECT COUNT(*)::int FROM fills
           WHERE archived_at > NOW() - INTERVAL '24 hours') AS fills_24h,
         (SELECT MAX(price) FROM fills
           WHERE archived_at > NOW() - INTERVAL '24 hours')::text AS high_24h,
         (SELECT MIN(price) FROM fills
           WHERE archived_at > NOW() - INTERVAL '24 hours')::text AS low_24h,
         (SELECT SUM(base_amt) FROM fills
           WHERE archived_at > NOW() - INTERVAL '24 hours')::text AS volume_base_24h,
         (SELECT SUM(quote_amt) FROM fills
           WHERE archived_at > NOW() - INTERVAL '24 hours')::text AS volume_quote_24h`,
      params,
      dbConn,
    ),
};

// ── Trade history ──────────────────────────────────────────────────────────
// Classified replacement for the generated GetTradeHistory: cancels must not
// render as trades. LIMIT 120 is fine HERE (display list) — stats never use
// this query (see getPairStats24h).

export interface IGetTradeHistoryParams {
  base: string;
  quote: string;
}
export interface IGetTradeHistoryResult {
  at_ms: string;
  g_color: string;
  g_amt: string;
  w_color: string;
  w_amt: string;
}
export const getTradeHistory = {
  run: (params: IGetTradeHistoryParams, dbConn: any) =>
    runQ<IGetTradeHistoryParams, IGetTradeHistoryResult>(
      `SELECT (EXTRACT(EPOCH FROM h.archived_at) * 1000)::bigint AS at_ms,
              g.token_color AS g_color, g.amount AS g_amt,
              w.token_color AS w_color, w.amount AS w_amt
       FROM offer_file_history h
       JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric)::text AS amount
             FROM offer_file_tokens_history
             WHERE direction = 'GIVING' AND token_color IN (:base!, :quote!)
             GROUP BY 1, 2) g ON g.offer_file_id = h.id
       JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric)::text AS amount
             FROM offer_file_tokens_history
             WHERE direction = 'WANTING' AND token_color IN (:base!, :quote!)
             GROUP BY 1, 2) w ON w.offer_file_id = h.id
       WHERE h.archive_reason = 'CONSUMED'
         AND NOT ${cancelledPredicate("h.id")}
         AND ((g.token_color = :base! AND w.token_color = :quote!)
           OR (g.token_color = :quote! AND w.token_color = :base!))
       ORDER BY h.archived_at DESC
       LIMIT 120`,
      params,
      dbConn,
    ),
};

export interface IGetOpenLegsParams {
  base: string;
  quote: string;
}
export interface IGetOpenLegsResult {
  g_color: string;
  g_amt: string;
  w_color: string;
  w_amt: string;
}
export const getOpenLegs = {
  run: (params: IGetOpenLegsParams, dbConn: any) =>
    runQ<IGetOpenLegsParams, IGetOpenLegsResult>(
      `SELECT g.token_color AS g_color, g.amount AS g_amt,
              w.token_color AS w_color, w.amount AS w_amt
       FROM offer_file o
       JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric)::text AS amount
             FROM offer_file_tokens
             WHERE direction = 'GIVING' AND token_color IN (:base!, :quote!)
             GROUP BY 1, 2) g ON g.offer_file_id = o.id
       JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric)::text AS amount
             FROM offer_file_tokens
             WHERE direction = 'WANTING' AND token_color IN (:base!, :quote!)
             GROUP BY 1, 2) w ON w.offer_file_id = o.id
       WHERE ((g.token_color = :base! AND w.token_color = :quote!)
           OR (g.token_color = :quote! AND w.token_color = :base!))`,
      params,
      dbConn,
    ),
};

// ── Token prices ───────────────────────────────────────────────────────────

export interface IGetTokenPriceParams { token_color: string }
export interface IGetTokenPriceResult { price_usd: string }
export const getTokenPrice = {
  run: (params: IGetTokenPriceParams, dbConn: any) =>
    runQ<IGetTokenPriceParams, IGetTokenPriceResult>(
      "SELECT price_usd FROM token_prices WHERE token_color = :token_color!",
      params,
      dbConn,
    ),
};

export interface IUpsertTokenPriceParams { token_color: string; price_usd: number }
export type IUpsertTokenPriceResult = void;
export const upsertTokenPrice = {
  run: (params: IUpsertTokenPriceParams, dbConn: any) =>
    runQ<IUpsertTokenPriceParams, IUpsertTokenPriceResult>(
      `INSERT INTO token_prices (token_color, price_usd)
       VALUES (:token_color!, :price_usd!)
       ON CONFLICT (token_color) DO NOTHING`,
      params,
      dbConn,
    ),
};

// ── Known tokens (duplicate-check queries) ─────────────────────────────────

export interface ICheckTokenNameExistsParams { name: string }
export interface ICheckTokenNameExistsResult { present: number }
export const checkTokenNameExists = {
  run: (params: ICheckTokenNameExistsParams, dbConn: any) =>
    runQ<ICheckTokenNameExistsParams, ICheckTokenNameExistsResult>(
      "SELECT 1 AS present FROM known_tokens WHERE name = :name! LIMIT 1",
      params,
      dbConn,
    ),
};

export interface IGetTokenByColorParams { token_color: string }
export interface IGetTokenByColorResult { name: string }
export const getTokenByColor = {
  run: (params: IGetTokenByColorParams, dbConn: any) =>
    runQ<IGetTokenByColorParams, IGetTokenByColorResult>(
      "SELECT name FROM known_tokens WHERE token_color = :token_color! LIMIT 1",
      params,
      dbConn,
    ),
};

// ── Pair stats ─────────────────────────────────────────────────────────────

export interface IUpsertPairStatsByOfferIdParams { offer_id: number }
export type IUpsertPairStatsByOfferIdResult = void;
export const upsertPairStatsByOfferId = {
  run: (params: IUpsertPairStatsByOfferIdParams, dbConn: any) =>
    runQ<IUpsertPairStatsByOfferIdParams, IUpsertPairStatsByOfferIdResult>(
      `INSERT INTO pair_stats (pair_key, base_color, quote_color, trade_count, last_price, last_traded_at)
       SELECT
           LEAST(g.token_color, w.token_color) || '|' || GREATEST(g.token_color, w.token_color),
           LEAST(g.token_color, w.token_color),
           GREATEST(g.token_color, w.token_color),
           1,
           w.amount::numeric / NULLIF(g.amount::numeric, 0),
           NOW()
       FROM (SELECT offer_file_id, token_color, SUM(amount::numeric) AS amount
             FROM offer_file_tokens_history
             WHERE direction = 'GIVING' AND offer_file_id = :offer_id!
             GROUP BY 1, 2) g
       JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric) AS amount
             FROM offer_file_tokens_history
             WHERE direction = 'WANTING' AND offer_file_id = :offer_id!
             GROUP BY 1, 2) w ON w.offer_file_id = g.offer_file_id
       WHERE g.offer_file_id = :offer_id!
         AND NOT ${cancelledPredicate("g.offer_file_id")}
       ON CONFLICT (pair_key) DO UPDATE SET
           trade_count    = pair_stats.trade_count + 1,
           last_price     = EXCLUDED.last_price,
           last_traded_at = EXCLUDED.last_traded_at`,
      params,
      dbConn,
    ),
};

export interface IGetPairsResult {
  pair_key: string;
  base_color: string;
  quote_color: string;
  trade_count: number;
  last_price: string | null;
  last_traded_at: DateOrString | null;
  open_count: number;
}
export const getPairs = {
  run: (_: void, dbConn: any) =>
    runNoParams<IGetPairsResult>(
      `SELECT
           COALESCE(ps.pair_key, live.pair_key) AS pair_key,
           COALESCE(ps.base_color, split_part(live.pair_key, '|', 1)) AS base_color,
           COALESCE(ps.quote_color, split_part(live.pair_key, '|', 2)) AS quote_color,
           COALESCE(ps.trade_count, 0) AS trade_count,
           ps.last_price,
           ps.last_traded_at,
           COALESCE(live.open_count, 0) AS open_count
       FROM pair_stats ps
       FULL OUTER JOIN (
           SELECT
               LEAST(g.token_color, w.token_color) || '|' || GREATEST(g.token_color, w.token_color) AS pair_key,
               COUNT(*)::int AS open_count
           FROM offer_file_tokens g
           JOIN offer_file_tokens w ON w.offer_file_id = g.offer_file_id AND w.direction = 'WANTING'
           WHERE g.direction = 'GIVING'
           GROUP BY 1
       ) live ON live.pair_key = ps.pair_key
       ORDER BY open_count DESC, last_traded_at DESC NULLS LAST`,
      dbConn,
    ),
};

// ── Offer hash (content-addressed lookups, MIP-0006 offerId) ───────────────
// offer_hash = hex sha256 of the raw MIP-0005 transaction bytes. These
// supersede the generated InsertOfferFile / GetOfferFiles for call sites that
// carry the hash; fold them into queries.sql on the next pgtyped regeneration.

export interface IInsertOfferFileWithHashParams {
  celestia_height: NumberOrString;
  transaction_hex: string;
  offer_hash: string;
  metadata_created_at: DateOrString | null;
  metadata_expires_at: DateOrString | null;
  first_seen_at: DateOrString | null;
  ttl_seconds: NumberOrString | null;
}
export interface IInsertOfferFileWithHashResult { id: number }
export const insertOfferFileWithHash = {
  run: (params: IInsertOfferFileWithHashParams, dbConn: any) =>
    runQ<IInsertOfferFileWithHashParams, IInsertOfferFileWithHashResult>(
      `INSERT INTO offer_file (
           celestia_height,
           transaction_hex,
           offer_hash,
           metadata_created_at,
           metadata_expires_at,
           first_seen_at,
           ttl_seconds
       ) VALUES (
           :celestia_height!,
           :transaction_hex!,
           :offer_hash!,
           :metadata_created_at!,
           :metadata_expires_at!,
           :first_seen_at!,
           COALESCE(:ttl_seconds!, 3600)
       ) RETURNING id`,
      params,
      dbConn,
    ),
};

// ── Fill vs cancel (read-time classification, phase 1) ─────────────────────
//
// Settlement is atomic: a fill consumes ALL of an offer's inputs in ONE
// Midnight transaction. So an archived-CONSUMED offer is CANCELLED — with
// certainty — when either
//   (a) some of its nullifiers were never spent at all (the maker moved one
//       coin elsewhere; the rest can now never settle), or
//   (b) its nullifiers were spent across MORE THAN ONE transaction.
// Everything else stays `consumed`. All-in-one-tx is a heuristic (a maker
// consolidating the same coins in one personal tx looks identical) until
// phase 2 adds output-commitment tracking; offers with no shielded inputs
// (unshielded-only) have no nullifiers to group and classify as `consumed`.
//
// Read-time on purpose: the archive fires on the FIRST nullifier event of a
// block, before its same-tx siblings are processed — but the whole block
// commits in one DB transaction, so readers only ever see complete state.
//
// `idExpr` is the SQL expression for the archived offer's id in the caller's
// scope (e.g. "offer_file_history.id" or "h.id").
const cancelledPredicate = (idExpr: string) => `(
  EXISTS (SELECT 1 FROM offer_file_nullifiers_history cnx
          LEFT JOIN nullifiers cnn ON cnn.nullifier = cnx.nullifier
          WHERE cnx.offer_file_id = ${idExpr} AND cnn.nullifier IS NULL)
  OR (SELECT COUNT(DISTINCT cnn.tx_hash)
      FROM offer_file_nullifiers_history cnx
      JOIN nullifiers cnn ON cnn.nullifier = cnx.nullifier
      WHERE cnx.offer_file_id = ${idExpr}) > 1
)`;

// Status of an archived row: expired (TTL) / cancelled / consumed.
const archivedStatusCase = (tableIdExpr: string) => `
  CASE WHEN archive_reason <> 'CONSUMED' THEN 'expired'
       WHEN ${cancelledPredicate(tableIdExpr)} THEN 'cancelled'
       ELSE 'consumed'
  END`;

// Nullifier insert that captures the spending transaction's hash. Supersedes
// the generated UpsertNullifier (which predates the tx_hash column) at the
// STM call site; ON CONFLICT keeps the FIRST-seen hash — a nullifier can only
// be spent once, so a second event for it is a replay, not new information.
export interface IInsertNullifierWithTxParams {
  nullifier: string;
  height: NumberOrString;
  tx_hash: string | null;
}
export type IInsertNullifierWithTxResult = void;
export const insertNullifierWithTx = {
  run: (params: IInsertNullifierWithTxParams, dbConn: any) =>
    runQ<IInsertNullifierWithTxParams, IInsertNullifierWithTxResult>(
      `INSERT INTO nullifiers (nullifier, height, tx_hash)
       VALUES (:nullifier!, :height!, :tx_hash!)
       ON CONFLICT (nullifier) DO NOTHING`,
      params,
      dbConn,
    ),
};

// Leg insert carrying the MIP-0006 layer tag. Supersedes the generated
// InsertOfferFileToken (which predates the kind column) at the STM call site.
export interface IInsertOfferFileTokenWithKindParams {
  offer_file_id: number;
  token_color: string;
  amount: string;
  direction: string;
  kind: string;
}
export type IInsertOfferFileTokenWithKindResult = void;
export const insertOfferFileTokenWithKind = {
  run: (params: IInsertOfferFileTokenWithKindParams, dbConn: any) =>
    runQ<IInsertOfferFileTokenWithKindParams, IInsertOfferFileTokenWithKindResult>(
      `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
       VALUES (:offer_file_id!, :token_color!, :amount!, :direction!, :kind!)`,
      params,
      dbConn,
    ),
};

// Open + archived in one probe: dedup gate at ingestion/submit, and the
// status half of GET /api/zswaps/:hash.
export interface IGetOfferStatusByHashParams { offer_hash: string }
export interface IGetOfferStatusByHashResult {
  id: number;
  status: string;
  archive_reason: string | null;
}
export const getOfferStatusByHash = {
  run: (params: IGetOfferStatusByHashParams, dbConn: any) =>
    runQ<IGetOfferStatusByHashParams, IGetOfferStatusByHashResult>(
      `SELECT id, 'live' AS status, NULL::text AS archive_reason
       FROM offer_file
       WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT id,
           (${archivedStatusCase("offer_file_history.id")}) AS status,
           archive_reason
       FROM offer_file_history
       WHERE offer_hash = :offer_hash!`,
      params,
      dbConn,
    ),
};

export interface IGetOfferByHashParams { offer_hash: string }
export interface IGetOfferByHashResult {
  id: number;
  celestia_height: NumberOrString;
  transaction_hex: string;
  offer_hash: string;
  metadata_created_at: DateOrString | null;
  metadata_expires_at: DateOrString | null;
  first_seen_at: DateOrString | null;
  ttl_seconds: NumberOrString | null;
  created_at: DateOrString | null;
  status: string;
  archive_reason: string | null;
}
export const getOfferByHash = {
  run: (params: IGetOfferByHashParams, dbConn: any) =>
    runQ<IGetOfferByHashParams, IGetOfferByHashResult>(
      `SELECT id, celestia_height, transaction_hex, offer_hash,
              metadata_created_at, metadata_expires_at, first_seen_at,
              ttl_seconds, created_at,
              'live' AS status, NULL::text AS archive_reason
       FROM offer_file
       WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT id, celestia_height, transaction_hex, offer_hash,
              metadata_created_at, metadata_expires_at, first_seen_at,
              ttl_seconds, created_at,
              (${archivedStatusCase("offer_file_history.id")}) AS status,
              archive_reason
       FROM offer_file_history
       WHERE offer_hash = :offer_hash!
       LIMIT 1`,
      params,
      dbConn,
    ),
};

// Legs for one archived-or-open offer; `live` picks the table.
export interface IGetOfferTokensAnyParams { offer_file_id: number; live: boolean }
export interface IGetOfferTokensAnyResult {
  token_color: string;
  amount: string;
  direction: string;
  kind: string;
}
export const getOfferTokensAny = {
  run: (params: IGetOfferTokensAnyParams, dbConn: any) =>
    runQ<IGetOfferTokensAnyParams, IGetOfferTokensAnyResult>(
      `SELECT token_color, amount, direction, kind FROM offer_file_tokens
       WHERE :live! AND offer_file_id = :offer_file_id!
       UNION ALL
       SELECT token_color, amount, direction, kind FROM offer_file_tokens_history
       WHERE NOT :live! AND offer_file_id = :offer_file_id!`,
      params,
      dbConn,
    ),
};

// Batched nullifiers for a page of offers — computed.inputNullifiers in the
// MIP-0006 payload (the keys an indexer watches to mark an offer consumed).
export interface IGetOfferNullifiersForOffersParams { offer_file_ids: number[]; live: boolean }
export interface IGetOfferNullifiersForOffersResult { offer_file_id: number; nullifier: string }
export const getOfferNullifiersForOffers = {
  run: (params: IGetOfferNullifiersForOffersParams, dbConn: any) =>
    runQ<IGetOfferNullifiersForOffersParams, IGetOfferNullifiersForOffersResult>(
      `SELECT offer_file_id, nullifier FROM offer_file_nullifiers
       WHERE :live! AND offer_file_id = ANY(:offer_file_ids!)
       UNION ALL
       SELECT offer_file_id, nullifier FROM offer_file_nullifiers_history
       WHERE NOT :live! AND offer_file_id = ANY(:offer_file_ids!)`,
      params,
      dbConn,
    ),
};

// Batched legs for a page of open offers (kills the per-offer N+1 in the list).
export interface IGetOfferTokensForOffersParams { offer_file_ids: number[] }
export interface IGetOfferTokensForOffersResult {
  offer_file_id: number;
  token_color: string;
  amount: string;
  direction: string;
  kind: string;
}
export const getOfferTokensForOffers = {
  run: (params: IGetOfferTokensForOffersParams, dbConn: any) =>
    runQ<IGetOfferTokensForOffersParams, IGetOfferTokensForOffersResult>(
      `SELECT offer_file_id, token_color, amount, direction, kind
       FROM offer_file_tokens
       WHERE offer_file_id = ANY(:offer_file_ids!)`,
      params,
      dbConn,
    ),
};

// List page without the ~24 KB blob; blob_chars lets UIs size downloads.
// EXISTS instead of JOIN + DISTINCT: the join duplicated each offer per leg
// and forced a 9-column dedup before the sort; EXISTS lets the planner walk
// the (created_at, id) index and stop at LIMIT (measured 12× faster at 5k
// offers, and the gap widens with book size). When :token is '' the OR
// short-circuits — no probe at all on the unfiltered path.
//
// Pagination is KEYSET, not OFFSET: the caller resolves an `after_hash`
// cursor to the anchor row's (created_at, id) via resolveOfferCursor and
// passes both here (or nulls for the first page). The row-value comparison
// seeks straight to the anchor position in idx_offer_file_created_at_id —
// no O(offset) discard, and concurrent inserts/archives cannot shift the
// page window. `id` tie-breaks offers sharing a created_at; it stays
// server-side (the public cursor is the offer_hash).
export interface IGetOpenOffersPageParams {
  token: string;
  direction: string;
  limit: number;
  after_created_at: DateOrString | null;
  after_id: number | null;
}
export interface IGetOpenOffersPageResult {
  id: number;
  celestia_height: NumberOrString;
  offer_hash: string | null;
  blob_chars: number;
  metadata_created_at: DateOrString | null;
  metadata_expires_at: DateOrString | null;
  first_seen_at: DateOrString | null;
  ttl_seconds: NumberOrString | null;
  created_at: DateOrString | null;
}
export const getOpenOffersPage = {
  run: (params: IGetOpenOffersPageParams, dbConn: any) =>
    runQ<IGetOpenOffersPageParams, IGetOpenOffersPageResult>(
      `SELECT o.id, o.celestia_height, o.offer_hash,
              LENGTH(o.transaction_hex)::int AS blob_chars,
              o.metadata_created_at, o.metadata_expires_at, o.first_seen_at,
              o.ttl_seconds, o.created_at
       FROM offer_file o
       WHERE
         (:token! = '' OR EXISTS (
           SELECT 1 FROM offer_file_tokens oft
           WHERE oft.offer_file_id = o.id
             AND oft.token_color = :token!
             AND (:direction! = 'ANY' OR oft.direction = :direction!)))
         AND (:after_id!::int IS NULL
              OR (o.created_at, o.id) < (:after_created_at!::timestamptz, :after_id!::int))
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT :limit!`,
      params,
      dbConn,
    ),
};

// Resolve an `after_hash` cursor to its keyset anchor. Checks history too:
// if the anchor offer was consumed/expired mid-pagination its row moved
// tables, but (created_at, id) is copied on archive, so the cursor stays
// valid and the reader continues exactly where they left off.
export interface IResolveOfferCursorParams { offer_hash: string }
export interface IResolveOfferCursorResult {
  id: number;
  created_at: DateOrString | null;
}
export const resolveOfferCursor = {
  run: (params: IResolveOfferCursorParams, dbConn: any) =>
    runQ<IResolveOfferCursorParams, IResolveOfferCursorResult>(
      `SELECT id, created_at FROM offer_file WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT id, created_at FROM offer_file_history WHERE offer_hash = :offer_hash!
       LIMIT 1`,
      params,
      dbConn,
    ),
};

// Hash-aware archive queries. These supersede the generated
// ArchiveOfferBy* queries: the history insert names offer_hash explicitly,
// because a BEFORE INSERT trigger reading the live row proved unreliable
// inside the archiving wCTE (sub-statement snapshot ordering — see
// migrations/005-offer-hash.sql). The three variants differ only in how
// offers are matched and the archive_reason recorded.
const HISTORY_COLUMNS = `
        id,
        celestia_height,
        transaction_hex,
        offer_hash,
        metadata_created_at,
        metadata_expires_at,
        first_seen_at,
        created_at,
        ttl_seconds`;

const archiveOfferSql = (matched: string, reason: "CONSUMED" | "TTL") => `
WITH matched AS (
${matched}
),
archived_offer AS (
    INSERT INTO offer_file_history (${HISTORY_COLUMNS},
        archive_reason
    )
    SELECT${HISTORY_COLUMNS},
        '${reason}'
    FROM offer_file
    WHERE id IN (SELECT offer_file_id FROM matched)
    RETURNING id
),
archived_tokens AS (
    INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind)
    SELECT offer_file_id, token_color, amount, direction, kind
    FROM offer_file_tokens
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
),
archived_nullifiers AS (
    INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier)
    SELECT offer_file_id, nullifier
    FROM offer_file_nullifiers
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
),
archived_unshielded_spends AS (
    INSERT INTO offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no)
    SELECT offer_file_id, owner, intent_hash, output_no
    FROM offer_file_unshielded_spends
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
)
DELETE FROM offer_file
WHERE id IN (SELECT offer_file_id FROM matched)
RETURNING id`;

export interface IArchiveOfferResult { id: number }

export interface IArchiveOfferByNullifierWithHashParams { nullifier: string }
export const archiveOfferByNullifierWithHash = {
  run: (params: IArchiveOfferByNullifierWithHashParams, dbConn: any) =>
    runQ<IArchiveOfferByNullifierWithHashParams, IArchiveOfferResult>(
      archiveOfferSql(
        `    SELECT DISTINCT offer_file_id
    FROM offer_file_nullifiers
    WHERE nullifier = :nullifier!`,
        "CONSUMED",
      ),
      params,
      dbConn,
    ),
};

export interface IArchiveOfferByUnshieldedSpendWithHashParams {
  owner: string;
  intent_hash: string;
  output_no: number;
}
export const archiveOfferByUnshieldedSpendWithHash = {
  run: (params: IArchiveOfferByUnshieldedSpendWithHashParams, dbConn: any) =>
    runQ<IArchiveOfferByUnshieldedSpendWithHashParams, IArchiveOfferResult>(
      archiveOfferSql(
        `    SELECT DISTINCT offer_file_id
    FROM offer_file_unshielded_spends
    WHERE owner = :owner!
      AND intent_hash = :intent_hash!
      AND output_no = :output_no!`,
        "CONSUMED",
      ),
      params,
      dbConn,
    ),
};

export interface IArchiveOfferByIdTtlWithHashParams { offer_file_id: number }
export const archiveOfferByIdTtlWithHash = {
  run: (params: IArchiveOfferByIdTtlWithHashParams, dbConn: any) =>
    runQ<IArchiveOfferByIdTtlWithHashParams, IArchiveOfferResult>(
      archiveOfferSql(
        `    SELECT id AS offer_file_id
    FROM offer_file
    WHERE id = :offer_file_id!
    LIMIT 1`,
        "TTL",
      ),
      params,
      dbConn,
    ),
};

// ── Rejected-blob cleanup (framework table) ────────────────────────────────
//
// The framework persists EVERY blob it fetches from the namespace into
// effectstream.primitive_accounting, permanently — the STM's own scheduled
// input is deleted after processing, but this accounting row is not. Since
// the Celestia namespace is permissionless, that is unbounded,
// attacker-controlled storage: anyone can park megabytes in our DB for the
// price of a blob fee, and every byte is copied again into the generated
// md5(payload) column.
//
// So when the STM rejects an offer, it DELETEs the row in the same block
// transaction that created it. Blanking the body in place was the other
// option; deleting wins because the row's only remaining value would have
// been "a blob was seen here" — which offer_rejections records in bounded,
// aggregated form, along with the reject reason the accounting row never
// carried. Deleting also sidesteps the table's UNIQUE index on
// (primitive_name, height, md5(payload)), which any in-place rewrite has to
// avoid colliding with.
//
// Safe to delete: the insert is ON CONFLICT DO NOTHING, no foreign key
// references the table, and nothing in the framework's production path reads
// it back (only its own reproduction tests do). Deterministic: a replay
// re-fetches, re-rejects, and re-deletes identically.
//
// The table's only usable index is
// (primitive_name, effectstream_block_height, payload_hash), so BOTH leading
// columns must be constrained: filtering on height alone still "uses" the
// index but walks all of it, across every primitive's rows — measured 137×
// the cost, and it grows with total node activity rather than with blob
// volume. With primitive_name it is a two-column prefix seek down to the
// handful of blobs at that height, and only then the body comparison.
export interface IDeleteRejectedAccountingRowParams {
  primitive_name: string;
  block_height: number;
  supplied_value: string;
}
export type IDeleteRejectedAccountingRowResult = void;
export const deleteRejectedAccountingRow = {
  run: (params: IDeleteRejectedAccountingRowParams, dbConn: any) =>
    runQ<IDeleteRejectedAccountingRowParams, IDeleteRejectedAccountingRowResult>(
      `DELETE FROM effectstream.primitive_accounting
       WHERE primitive_name = :primitive_name!
         AND effectstream_block_height = :block_height!
         AND payload->'payload'->>'suppliedValue' = :supplied_value!`,
      params,
      dbConn,
    ),
};

// Aggregated rejection counter — what survives a discarded blob. Bounded by
// (heights with a rejection) × (distinct codes), never by blob count, so it
// cannot itself be inflated by spam. See migrations/006-offer-rejections.sql.
export interface IRecordOfferRejectionParams {
  celestia_height: NumberOrString;
  code: string;
}
export type IRecordOfferRejectionResult = void;
export const recordOfferRejection = {
  run: (params: IRecordOfferRejectionParams, dbConn: any) =>
    runQ<IRecordOfferRejectionParams, IRecordOfferRejectionResult>(
      `INSERT INTO offer_rejections (celestia_height, code, count)
       VALUES (:celestia_height!, :code!, 1)
       ON CONFLICT (celestia_height, code)
       DO UPDATE SET count = offer_rejections.count + 1`,
      params,
      dbConn,
    ),
};

// Recent rejection activity, newest height first — the ops view of "is
// something spamming the namespace, and with what?".
export interface IGetRecentRejectionsParams { limit: number }
export interface IGetRecentRejectionsResult {
  celestia_height: NumberOrString;
  code: string;
  count: number;
}
export const getRecentRejections = {
  run: (params: IGetRecentRejectionsParams, dbConn: any) =>
    runQ<IGetRecentRejectionsParams, IGetRecentRejectionsResult>(
      `SELECT celestia_height, code, count
       FROM offer_rejections
       ORDER BY celestia_height DESC, code
       LIMIT :limit!`,
      params,
      dbConn,
    ),
};

// Root upsert that pins first_seen_ms on the FIRST insert and never moves it
// (COALESCE keeps the existing value on conflict) while still advancing
// last_seen_ms for the prune. Supersedes the generated UpsertKnownRoot at the
// STM call site.
export interface IUpsertKnownRootWithFirstSeenParams {
  root: string;
  height: NumberOrString;
  seen_ms: NumberOrString;
}
export type IUpsertKnownRootWithFirstSeenResult = void;
export const upsertKnownRootWithFirstSeen = {
  run: (params: IUpsertKnownRootWithFirstSeenParams, dbConn: any) =>
    runQ<IUpsertKnownRootWithFirstSeenParams, IUpsertKnownRootWithFirstSeenResult>(
      `INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms)
       VALUES (:root!, :height!, :seen_ms!, :seen_ms!)
       ON CONFLICT (root) DO UPDATE
         SET height = EXCLUDED.height,
             last_seen_ms = EXCLUDED.last_seen_ms,
             first_seen_ms = COALESCE(known_roots.first_seen_ms, EXCLUDED.first_seen_ms)`,
      params,
      dbConn,
    ),
};

// Root timing for a set of shielded input roots. Called at ingestion with
// the offer's just-validated inputRoots (all already in known_roots).
// NULL for an unshielded-only offer (empty root list).
//
// TWO DIFFERENT MINIMA, for two different questions — do not conflate them:
//
//   first_seen_ms — when the chain FIRST held this tree state. An offer
//     cannot predate its own proof root, so this is a deterministic lower
//     bound on the offer's age → computed.firstSeenAt.
//
//   last_seen_ms  — when the root was LAST current. This is the expiry
//     basis, because the ledger's `past_roots` is a TimeFilterMap that
//     RE-INSERTS the current root every block and evicts entries older than
//     `tblock − window` (zswap/src/ledger.rs). On a chain segment with no
//     new coin commitments the same root keeps being refreshed, so the
//     window runs from the last block whose tree state the offer proved
//     against — NOT from when the root (or the offer) first appeared.
//     Our pruneKnownRoots already mirrors this (`last_seen_ms < cutoff`).
//
// MIN across the offer's roots either way: the offer dies when the FIRST of
// its roots leaves the window.
export interface IGetEarliestRootFirstSeenParams { roots: string[] }
export interface IGetEarliestRootFirstSeenResult {
  first_seen_ms: NumberOrString | null;
  last_seen_ms: NumberOrString | null;
}
export const getEarliestRootFirstSeen = {
  run: (params: IGetEarliestRootFirstSeenParams, dbConn: any) =>
    runQ<IGetEarliestRootFirstSeenParams, IGetEarliestRootFirstSeenResult>(
      `SELECT MIN(first_seen_ms) AS first_seen_ms,
              MIN(last_seen_ms)  AS last_seen_ms
       FROM known_roots WHERE root = ANY(:roots!)`,
      params,
      dbConn,
    ),
};

// NOTE: status-by-blob lookups go through offerHashFromBlob() + the
// getOfferStatusByHash index probe — never a literal transaction_hex
// comparison. A TEXT-equality query here would seq-scan both offer tables
// against ~24 KB strings and hand attackers a cheap DoS (POST junk blobs →
// full scans); btree can't index the column anyway (rows exceed the ~2.7 KB
// entry limit). Undecodable blobs must be answered without touching the DB.
