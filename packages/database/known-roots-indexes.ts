// Startup-ensured known_roots indexes.
//
// The Effectstream runtime applies migrationTable by block height, so a
// schema change in 000-init.sql never reaches a database that already synced
// past it. An index a live database must gain goes through this path instead:
// idempotent, and a no-op until 000-init.sql has created the table (a fresh
// database gets the same index from 000-init.sql itself).
//
// idx_known_roots_last_seen_height keeps the per-block prune fast at the
// 14-day root window (up to ~201,600 roots) when the planner has no table
// statistics — see the comment above it in 000-init.sql.

export const KNOWN_ROOTS_PRUNE_INDEX = "idx_known_roots_last_seen_height";

export const ENSURE_KNOWN_ROOTS_INDEXES_SQL = `DO $$
BEGIN
  IF to_regclass('known_roots') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_known_roots_last_seen_height
      ON known_roots (last_seen_ms, height);
  END IF;
END
$$`;

export async function ensureKnownRootsIndexes(
  dbConn: { query(sql: string): Promise<unknown> },
): Promise<void> {
  await dbConn.query(ENSURE_KNOWN_ROOTS_INDEXES_SQL);
}
