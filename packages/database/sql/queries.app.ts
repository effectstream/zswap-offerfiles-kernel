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

// ── Trade history ──────────────────────────────────────────────────────────

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
       JOIN offer_file_tokens_history g ON g.offer_file_id = h.id AND g.direction = 'GIVING'
       JOIN offer_file_tokens_history w ON w.offer_file_id = h.id AND w.direction = 'WANTING'
       WHERE h.archive_reason = 'CONSUMED'
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
       JOIN offer_file_tokens g ON g.offer_file_id = o.id AND g.direction = 'GIVING'
       JOIN offer_file_tokens w ON w.offer_file_id = o.id AND w.direction = 'WANTING'
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
       FROM offer_file_tokens_history g
       JOIN offer_file_tokens_history w ON w.offer_file_id = g.offer_file_id AND w.direction = 'WANTING'
       WHERE g.direction = 'GIVING' AND g.offer_file_id = :offer_id!
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
  metadata_maker_note: string | null;
  auth_signer_public_key: string | null;
  auth_signature: string | null;
  auth_scheme: string | null;
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
           metadata_maker_note,
           auth_signer_public_key,
           auth_signature,
           auth_scheme,
           ttl_seconds
       ) VALUES (
           :celestia_height!,
           :transaction_hex!,
           :offer_hash!,
           :metadata_created_at!,
           :metadata_expires_at!,
           :metadata_maker_note!,
           :auth_signer_public_key!,
           :auth_signature!,
           :auth_scheme!,
           COALESCE(:ttl_seconds!, 3600)
       ) RETURNING id`,
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
      `SELECT id, 'open' AS status, NULL::text AS archive_reason
       FROM offer_file
       WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT id,
           CASE archive_reason WHEN 'CONSUMED' THEN 'completed' ELSE 'expired' END AS status,
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
  metadata_maker_note: string | null;
  ttl_seconds: NumberOrString | null;
  created_at: DateOrString | null;
  status: string;
  archive_reason: string | null;
}
export const getOfferByHash = {
  run: (params: IGetOfferByHashParams, dbConn: any) =>
    runQ<IGetOfferByHashParams, IGetOfferByHashResult>(
      `SELECT id, celestia_height, transaction_hex, offer_hash,
              metadata_created_at, metadata_expires_at, metadata_maker_note,
              ttl_seconds, created_at,
              'open' AS status, NULL::text AS archive_reason
       FROM offer_file
       WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT id, celestia_height, transaction_hex, offer_hash,
              metadata_created_at, metadata_expires_at, metadata_maker_note,
              ttl_seconds, created_at,
              CASE archive_reason WHEN 'CONSUMED' THEN 'completed' ELSE 'expired' END AS status,
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
}
export const getOfferTokensAny = {
  run: (params: IGetOfferTokensAnyParams, dbConn: any) =>
    runQ<IGetOfferTokensAnyParams, IGetOfferTokensAnyResult>(
      `SELECT token_color, amount, direction FROM offer_file_tokens
       WHERE :live! AND offer_file_id = :offer_file_id!
       UNION ALL
       SELECT token_color, amount, direction FROM offer_file_tokens_history
       WHERE NOT :live! AND offer_file_id = :offer_file_id!`,
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
}
export const getOfferTokensForOffers = {
  run: (params: IGetOfferTokensForOffersParams, dbConn: any) =>
    runQ<IGetOfferTokensForOffersParams, IGetOfferTokensForOffersResult>(
      `SELECT offer_file_id, token_color, amount, direction
       FROM offer_file_tokens
       WHERE offer_file_id = ANY(:offer_file_ids!)`,
      params,
      dbConn,
    ),
};

// List page without the ~24 KB blob; blob_chars lets UIs size downloads.
// EXISTS instead of JOIN + DISTINCT: the join duplicated each offer per leg
// and forced a 9-column dedup before the sort; EXISTS lets the planner walk
// idx_offer_file_created_at and stop at LIMIT (measured 12× faster at 5k
// offers, and the gap widens with book size). When :token is '' the OR
// short-circuits — no probe at all on the unfiltered path.
export interface IGetOpenOffersPageParams {
  token: string;
  direction: string;
  limit: number;
  offset: number;
}
export interface IGetOpenOffersPageResult {
  id: number;
  celestia_height: NumberOrString;
  offer_hash: string | null;
  blob_chars: number;
  metadata_created_at: DateOrString | null;
  metadata_expires_at: DateOrString | null;
  metadata_maker_note: string | null;
  ttl_seconds: NumberOrString | null;
  created_at: DateOrString | null;
}
export const getOpenOffersPage = {
  run: (params: IGetOpenOffersPageParams, dbConn: any) =>
    runQ<IGetOpenOffersPageParams, IGetOpenOffersPageResult>(
      `SELECT o.id, o.celestia_height, o.offer_hash,
              LENGTH(o.transaction_hex)::int AS blob_chars,
              o.metadata_created_at, o.metadata_expires_at, o.metadata_maker_note,
              o.ttl_seconds, o.created_at
       FROM offer_file o
       WHERE
         (:token! = '' OR EXISTS (
           SELECT 1 FROM offer_file_tokens oft
           WHERE oft.offer_file_id = o.id
             AND oft.token_color = :token!
             AND (:direction! = 'ANY' OR oft.direction = :direction!)))
       ORDER BY o.created_at DESC
       LIMIT :limit!
       OFFSET :offset!`,
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
        metadata_maker_note,
        auth_signer_public_key,
        auth_signature,
        auth_scheme,
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
    INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction)
    SELECT offer_file_id, token_color, amount, direction
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

// NOTE: status-by-blob lookups go through offerHashFromBlob() + the
// getOfferStatusByHash index probe — never a literal transaction_hex
// comparison. A TEXT-equality query here would seq-scan both offer tables
// against ~24 KB strings and hand attackers a cheap DoS (POST junk blobs →
// full scans); btree can't index the column anyway (rows exceed the ~2.7 KB
// entry limit). Undecodable blobs must be answered without touching the DB.
