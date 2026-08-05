// Direct-DB observation helpers. Effects (rows), never logs — STF errors are
// telemetry-only (HANDOFF gotcha #2), so row counts vs primitive_accounting
// are the only trustworthy evidence the STM actually executed.

import type { Client } from "pg";

export interface OfferRow {
  id: number;
  offer_hash: string | null;
  celestia_height: string;
  transaction_hex: string;
  created_at: Date | null;
  archive_reason?: string | null;
  archived_at?: Date | null;
}

export async function offerRowByHash(db: Client, hash: string): Promise<OfferRow | null> {
  const live = await db.query<OfferRow>(
    `SELECT id, offer_hash, celestia_height, transaction_hex, created_at FROM offer_file WHERE offer_hash = $1`,
    [hash],
  );
  return live.rows[0] ?? null;
}

export async function historyRowByHash(db: Client, hash: string): Promise<OfferRow | null> {
  const hist = await db.query<OfferRow>(
    `SELECT id, offer_hash, celestia_height, transaction_hex, created_at, archive_reason, archived_at
     FROM offer_file_history WHERE offer_hash = $1`,
    [hash],
  );
  return hist.rows[0] ?? null;
}

export async function tableCount(db: Client, table: string, schema = "public"): Promise<number> {
  // identifiers come from our own audit lists, never user input
  const r = await db.query(`SELECT count(*)::int AS n FROM ${schema}.${table}`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function rejectionRows(
  db: Client,
): Promise<{ celestia_height: string; code: string; count: number }[]> {
  const r = await db.query(
    `SELECT celestia_height, code, count FROM offer_rejections ORDER BY celestia_height, code`,
  );
  return r.rows as any;
}

/**
 * Rejections summed per code, across all heights.
 *
 * Heights cannot be matched: `offer_rejections.celestia_height` holds an
 * EffectstreamBlockNumber, not the height blob.Submit reported (see ISSUES.md).
 * But the per-code totals diff cleanly, which is what lets a fixture assert
 * WHICH rejection it earned instead of merely that the count went up — the
 * difference between "the ladder rejected it" and "the ladder rejected it for
 * the reason we are testing".
 */
export async function rejectionTotalsByCode(db: Client): Promise<Record<string, number>> {
  const r = await db.query(
    `SELECT code, SUM(count)::int AS n FROM offer_rejections GROUP BY code`,
  );
  return Object.fromEntries(
    (r.rows as { code: string; n: number }[]).map((x) => [x.code, Number(x.n)]),
  );
}

/** Legs as stored, in the same canonical form lib/verify.ts derives them. */
export async function legsFor(db: Client, offerFileId: number, live: boolean): Promise<string[]> {
  const table = live ? "offer_file_tokens" : "offer_file_tokens_history";
  const r = await db.query(
    `SELECT token_color, amount, direction, kind FROM ${table} WHERE offer_file_id = $1`,
    [offerFileId],
  );
  return (r.rows as { token_color: string; amount: string; direction: string; kind: string }[])
    .map((x) => `${x.direction === "GIVING" ? "G" : "W"}|${x.token_color.toLowerCase()}|${x.amount}|${x.kind}`)
    .sort();
}

export interface StoredBlobRow {
  id: number;
  offer_hash: string;
  transaction_hex: string;
  live: boolean;
}

/** Every blob this node holds, live and archived — the audit's full surface. */
export async function storedBlobs(db: Client): Promise<StoredBlobRow[]> {
  const r = await db.query(
    `SELECT id, offer_hash, transaction_hex, TRUE  AS live FROM offer_file
     UNION ALL
     SELECT id, offer_hash, transaction_hex, FALSE AS live FROM offer_file_history
     ORDER BY id`,
  );
  return r.rows as StoredBlobRow[];
}

export async function primitiveCount(db: Client, primitiveName: string, where = ""): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM effectstream.primitive_accounting WHERE primitive_name = $1 ${where}`,
    [primitiveName],
  );
  return Number(r.rows[0]?.n ?? 0);
}
