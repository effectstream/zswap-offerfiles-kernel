import type { Client } from "pg";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Allowed tables for count() — keeps SQL identifiers from being free-form. */
const COUNTABLE = new Set([
  "offer_file",
  "offer_file_history",
  "nullifiers",
  "known_roots",
  "created_unshielded",
  "offer_file_tokens",
  "known_tokens",
]);

export async function count(db: Client, table: string): Promise<number> {
  if (!COUNTABLE.has(table)) {
    throw new Error(`count(): table "${table}" not in allow-list`);
  }
  const res = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function waitFor(
  name: string,
  fn: () => Promise<boolean>,
  tries = 36,
  ms = 5000,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(ms);
  }
  console.log(`  (waitFor "${name}" timed out after ${(tries * ms) / 1000}s)`);
  return false;
}

/** True when nullifiers row count is at least `before + delta`. */
export async function nullifiersGrew(
  db: Client,
  before: number,
  delta = 1,
): Promise<boolean> {
  return (await count(db, "nullifiers")) >= before + delta;
}

/** Offer gone from offer_file and present in history with archive_reason CONSUMED. */
export async function offerArchivedConsumed(
  db: Client,
  id: number,
): Promise<boolean> {
  const active = await db.query(`SELECT id FROM offer_file WHERE id = $1`, [id]);
  const hist = await db.query(
    `SELECT id FROM offer_file_history WHERE id = $1 AND archive_reason = 'CONSUMED'`,
    [id],
  );
  return active.rows.length === 0 && hist.rows.length === 1;
}

/** All of the given offer ids are absent from offer_file. */
export async function offersGone(db: Client, ids: number[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const res = await db.query(
    `SELECT id FROM offer_file WHERE id = ANY($1::int[])`,
    [ids],
  );
  return res.rows.length === 0;
}
