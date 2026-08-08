import { afterAll, beforeAll, expect, test } from "bun:test";

// Keyset pagination: pages must cover the book exactly once — no duplicates,
// no gaps — including across rows that SHARE a celestia_height (offers
// published in the same Celestia block), which is where a naive
// `height < ?` cursor silently drops rows and OFFSET pagination shifts under
// writes. Runs the real queries against in-memory PGlite with the real schema.
//
// The cursor key is (celestia_height, offer_hash) — the PUBLICATION tuple. Two
// earlier keys were replaced for the same underlying reason, that a sort key
// must be a fact every replica agrees on:
//
//   created_at    — DEFAULT NOW(), node-local wall clock.
//   first_seen_at — chain-derived, but for a shielded offer it comes from when
//                   THIS NODE first saw the proof root, so replicas with
//                   different sync starts disagree.
//
// Neither was catchable by the determinism replay: created_at is in
// DIFF_EXCLUDED_COLUMNS, and both grand-e2e instances start at height 1, so
// first_seen_at agrees between them by construction rather than by guarantee.
// "failover order is identical under different sync starts" below is the test
// p7a structurally cannot perform.
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
const PORT_REPLICA = 54338;
let handle: { close: () => Promise<void> };
let replicaHandle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;
let replica: InstanceType<typeof pg.Client>;

const TOTAL = 25;
// Zero-padded hex, so lexicographic order matches numeric order — the DB sorts
// these as text, and the fixture's expectations are written numerically.
const hashOf = (i: number) => i.toString(16).padStart(64, "0");
// 5 offers per Celestia height: every page boundary lands inside a tie, so the
// offer_hash tie-break is exercised on every single page.
const heightOf = (i: number) => 100 + Math.floor((i - 1) / 5);

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
  for (let i = 1; i <= TOTAL; i++) {
    await client.query(
      // created_at and first_seen_at are deliberately set to values that
      // DISAGREE with publication order (both run backwards relative to
      // celestia_height). Under either former key this fixture would page in
      // the opposite direction, so the ordering assertions below now fail if
      // the cursor ever regresses to one of them.
      `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, ttl_seconds,
         created_at, first_seen_at)
       VALUES ($1, $2, $3, $4, 3600,
         TIMESTAMPTZ '2026-07-01 00:00:00+00' - ($5 || ' minutes')::interval,
         TIMESTAMPTZ '2026-07-01 00:00:00+00' - ($5 || ' minutes')::interval)`,
      [i, heightOf(i), `blob-${i}`, hashOf(i), String(i)],
    );
  }
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
  try {
    await replicaHandle?.close();
  } catch { /* noop */ }
});

async function pageFrom(
  conn: InstanceType<typeof pg.Client>,
  afterHash: string | null,
  limit: number,
) {
  let after_height: string | null = null;
  let after_hash: string | null = null;
  if (afterHash) {
    const anchor = await resolveOfferCursor.run({ offer_hash: afterHash }, conn);
    expect(anchor.length).toBe(1);
    after_height = String(anchor[0].celestia_height);
    after_hash = anchor[0].offer_hash;
  }
  return getOpenOffersPage.run(
    { token: "", direction: "ANY", limit, after_height, after_hash },
    conn,
  );
}

const fetchPage = (afterHash: string | null, limit: number) =>
  pageFrom(client, afterHash, limit);

/** Walk every page, returning the offer_hash sequence in served order. */
async function walkAll(conn: InstanceType<typeof pg.Client>, limit: number) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const rows = await pageFrom(conn, cursor, limit);
    if (rows.length === 0) return seen;
    seen.push(...rows.map((r) => r.offer_hash as string));
    cursor = rows[rows.length - 1].offer_hash as string;
  }
  throw new Error("runaway pagination");
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
  // Publication order: (celestia_height DESC, offer_hash DESC). Both run WITH
  // id here and AGAINST created_at/first_seen_at, so this equality also proves
  // the cursor is not silently using a timestamp column.
  expect(seen).toEqual([...seen].sort((a, b) => b - a));
});

test("page boundary inside a shared celestia_height does not skip tie siblings", async () => {
  // ids 25..21 all published at height 104. A page of 3 ends mid-tie, and the
  // next page must continue at 22 rather than jumping to the next height.
  const page1 = await fetchPage(null, 3);
  expect(page1.map((r) => r.id)).toEqual([25, 24, 23]);
  expect(new Set(page1.map((r) => String(r.celestia_height))).size).toBe(1);
  const page2 = await fetchPage(page1[2].offer_hash, 3);
  expect(page2.map((r) => r.id)).toEqual([22, 21, 20]);
});

test("an archived anchor still resolves (cursor survives consume mid-pagination)", async () => {
  // Move offer 23 to history the way the archive queries do — celestia_height
  // and offer_hash are both copied, which is what keeps the cursor valid.
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash, created_at,
       first_seen_at, ttl_seconds, archive_reason, archived_at)
     SELECT id, celestia_height, transaction_hex, offer_hash, created_at,
       first_seen_at, ttl_seconds, 'CONSUMED', NOW()
     FROM offer_file WHERE id = 23`,
  );
  await client.query("DELETE FROM offer_file WHERE id = 23");
  const page = await fetchPage(hashOf(23), 3);
  expect(page.map((r) => r.id)).toEqual([22, 21, 20]);
  // restore for other tests
  await client.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, ttl_seconds,
       created_at, first_seen_at)
     SELECT id, celestia_height, transaction_hex, offer_hash, ttl_seconds, created_at, first_seen_at
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

test("failover: a replica with different serial ids and sync start serves the SAME order", async () => {
  // THE test p7a cannot do. Both grand-e2e instances replay from height 1 with
  // identical ingestion order, so they agree on `id` and on first_seen_at by
  // construction. A real replica does not: it may have been started at a later
  // MIDNIGHT_START_BLOCK (later first_seen_at) and it will have indexed offers
  // in a different order (different SERIAL ids). If either leaks into the sort
  // key, a client failing over mid-pagination skips or repeats rows — exactly
  // what a keyset cursor exists to prevent.
  replicaHandle = await startPglite(PORT_REPLICA);
  replica = new pg.Client({
    host: "127.0.0.1",
    port: PORT_REPLICA,
    user: "postgres",
    database: "postgres",
  });
  await replica.connect();
  for (const migration of migrationTable) await replica.query(migration.sql);

  // Same offers, three things deliberately different:
  //   - inserted in REVERSE order, so SERIAL ids are mirrored
  //   - first_seen_at 9 days later, as a later sync start would record
  //   - created_at "now", as a node that indexed them today would have
  for (let i = TOTAL; i >= 1; i--) {
    await replica.query(
      `INSERT INTO offer_file (celestia_height, transaction_hex, offer_hash, ttl_seconds,
         created_at, first_seen_at)
       VALUES ($1, $2, $3, 3600, NOW(),
         TIMESTAMPTZ '2026-07-10 00:00:00+00' + ($4 || ' minutes')::interval)`,
      [heightOf(i), `blob-${i}`, hashOf(i), String(i)],
    );
  }

  // Ids really are mirrored — otherwise this test proves nothing.
  const primaryFirst = (await client.query(
    "SELECT id FROM offer_file WHERE offer_hash = $1", [hashOf(1)],
  )).rows[0].id;
  const replicaFirst = (await replica.query(
    "SELECT id FROM offer_file WHERE offer_hash = $1", [hashOf(1)],
  )).rows[0].id;
  expect(primaryFirst).not.toBe(replicaFirst);

  // Paginated through 4 at a time, the two nodes serve byte-identical order.
  expect(await walkAll(replica, 4)).toEqual(await walkAll(client, 4));
});

test("keyset page walks idx_offer_file_height_hash with no Sort node", async () => {
  // Regression guard for the plan shape: the whole point of keyset over OFFSET
  // is an index seek that stops at LIMIT. A Sort node means the planner
  // materialized the book.
  //
  // This EXPLAIN must mirror getOpenOffersPage's WHERE/ORDER BY exactly. The
  // previous version of this test did NOT — it still explained
  // (created_at, id) against idx_offer_file_created_at_id long after production
  // had moved to first_seen_at, so it would have passed with the production
  // index dropped entirely. If you change the cursor key, change it here too;
  // the ordering tests above use the real query and will catch you if you
  // change one without the other.
  const r = await client.query(`EXPLAIN
    SELECT o.id FROM offer_file o
    WHERE (o.celestia_height, o.offer_hash) < (104::bigint, '${hashOf(23)}'::text)
    ORDER BY o.celestia_height DESC, o.offer_hash DESC
    LIMIT 4`);
  const plan = r.rows.map((row: any) => row["QUERY PLAN"]).join("\n");
  expect(plan).toContain("idx_offer_file_height_hash");
  expect(plan).not.toContain("Sort");
});
