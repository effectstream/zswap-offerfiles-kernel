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

export async function primitiveCount(db: Client, primitiveName: string, where = ""): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM effectstream.primitive_accounting WHERE primitive_name = $1 ${where}`,
    [primitiveName],
  );
  return Number(r.rows[0]?.n ?? 0);
}
