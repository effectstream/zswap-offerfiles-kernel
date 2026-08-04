import { afterAll, beforeAll, expect, test } from "bun:test";

// Keyset pagination (item #14): pages must cover the book exactly once —
// no duplicates, no gaps — including across rows that SHARE a created_at
// (same-block indexing), which is where a naive `created_at < ?` cursor
// silently drops rows and OFFSET pagination shifts under writes. Runs the
// real queries against in-memory PGlite with the real migrations.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  getOpenOffersPage,
  resolveOfferCursor,
} = await import("@zswap-da/database");

const PORT = 54337;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

const TOTAL = 25;
const hashOf = (i: number) => i.toString(16).padStart(64, "0");

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of migrationTable) {
    await client.query(migration.sql);
  }
  // 25 offers across 5 timestamps → every created_at is shared by 5 rows,
  // so every page boundary lands inside a tie and exercises the id tie-break.
  for (let i = 1; i <= TOTAL; i++) {
    const bucket = Math.floor((i - 1) / 5); // 0..4
    await client.query(
      `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, ttl_seconds, created_at)
       VALUES ($1, $2, $3, $4, 3600, TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($5 || ' minutes')::interval)`,
      [i, 100 + i, `blob-${i}`, hashOf(i), String(bucket)],
    );
  }
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
});

async function fetchPage(afterHash: string | null, limit: number) {
  let after_created_at: unknown = null;
  let after_id: number | null = null;
  if (afterHash) {
    const anchor = await resolveOfferCursor.run({ offer_hash: afterHash }, client);
    expect(anchor.length).toBe(1);
    after_created_at = anchor[0].created_at;
    after_id = anchor[0].id;
  }
  return getOpenOffersPage.run(
    {
      token: "",
      direction: "ANY",
      limit,
      after_created_at: after_created_at as any,
      after_id,
    },
    client,
  );
}

test("paging with limit 4 covers all 25 offers exactly once, no dupes, no gaps", async () => {
  const seen: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const rows = await fetchPage(cursor, 4);
    if (rows.length === 0) break;
    seen.push(...rows.map((r) => r.id));
    cursor = rows[rows.length - 1].offer_hash;
    pages++;
    expect(pages).toBeLessThan(20); // runaway guard
  }
  expect(seen.length).toBe(TOTAL);
  expect(new Set(seen).size).toBe(TOTAL); // exactly once
  // Global order: created_at DESC, id DESC — strictly decreasing ids within
  // this fixture because id order matches time order.
  const sorted = [...seen].sort((a, b) => b - a);
  expect(seen).toEqual(sorted);
});

test("page boundary inside a shared created_at does not skip tie siblings", async () => {
  // First page of 3 ends at id 23 — mid-tie (ids 25..21 share the newest
  // timestamp). The next page must continue at 22, not jump to the next
  // timestamp bucket.
  const page1 = await fetchPage(null, 3);
  expect(page1.map((r) => r.id)).toEqual([25, 24, 23]);
  const page2 = await fetchPage(page1[2].offer_hash, 3);
  expect(page2.map((r) => r.id)).toEqual([22, 21, 20]);
});

test("an archived anchor still resolves (cursor survives consume mid-pagination)", async () => {
  // Move offer 23 to history the way the archive queries do (same id and
  // created_at), then page from its hash — pagination continues unbroken.
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds, archive_reason, archived_at)
     SELECT id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds, 'CONSUMED', NOW()
     FROM offer_file WHERE id = 23`,
  );
  await client.query("DELETE FROM offer_file WHERE id = 23");
  const page = await fetchPage(hashOf(23), 3);
  expect(page.map((r) => r.id)).toEqual([22, 21, 20]);
  // restore for other tests
  await client.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, ttl_seconds, created_at)
     SELECT id, celestia_height, transaction_hex, offer_hash, ttl_seconds, created_at
     FROM offer_file_history WHERE id = 23`,
  );
  await client.query("DELETE FROM offer_file_history WHERE id = 23");
});

test("unknown cursor resolves to nothing (API turns this into 400)", async () => {
  const anchor = await resolveOfferCursor.run(
    { offer_hash: "f".repeat(64) },
    client,
  );
  expect(anchor.length).toBe(0);
});

test("keyset page walks idx_offer_file_created_at_id with no Sort node", async () => {
  // Regression guard for the plan shape: the whole point of keyset over
  // OFFSET is an index seek that stops at LIMIT. A Sort node means the
  // planner materialized the book.
  const r = await client.query(`EXPLAIN
    SELECT o.id FROM offer_file o
    WHERE (o.created_at, o.id) < (TIMESTAMPTZ '2026-07-01 00:03:00+00', 18)
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT 4`);
  const plan = r.rows.map((row: any) => row["QUERY PLAN"]).join("\n");
  expect(plan).toContain("idx_offer_file_created_at_id");
  expect(plan).not.toContain("Sort");
});
