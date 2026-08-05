import { afterAll, beforeAll, expect, test } from "bun:test";

// Verifies the content-addressed offer identity added by 005-offer-hash.sql:
// hash-aware insert, hash lookups (open + archived), the blob-free list page,
// and the *WithHash archive queries that carry offer_hash into
// offer_file_history explicitly. Runs against in-memory PGlite over the pg
// wire protocol.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  insertOfferFileWithHash,
  insertOfferFileTokenWithKind,
  insertOfferFileNullifier,
  archiveOfferByNullifierWithHash,
  getOfferByHash,
  getOfferStatusByHash,
  getOfferTokensAny,
  getOpenOffersPage,
  getOfferTokensForOffers,
  insertNullifierWithTx,
} = await import("@zswap-da/database");

const PORT = 54333;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TOKEN_G = "1".repeat(64);
const TOKEN_W = "2".repeat(64);

async function insertOffer(hash: string, blob: string): Promise<number> {
  const rows = await insertOfferFileWithHash.run(
    {
      celestia_height: 100,
      transaction_hex: blob,
      offer_hash: hash,
      metadata_created_at: new Date().toISOString(),
      metadata_expires_at: null,
      ttl_seconds: 3600,
    },
    client,
  );
  const id = rows[0].id;
  await insertOfferFileTokenWithKind.run(
    { offer_file_id: id, token_color: TOKEN_G, amount: "10", direction: "GIVING", kind: "SHIELDED" },
    client,
  );
  await insertOfferFileTokenWithKind.run(
    { offer_file_id: id, token_color: TOKEN_W, amount: "5", direction: "WANTING", kind: "UNSHIELDED" },
    client,
  );
  return id;
}

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
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
});

test("insert + getOfferByHash returns the open offer with blob and legs", async () => {
  const id = await insertOffer(HASH_A, "swapoffer1testblob-a");
  const rows = await getOfferByHash.run({ offer_hash: HASH_A }, client);
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("live");
  expect(rows[0].transaction_hex).toBe("swapoffer1testblob-a");
  const legs = await getOfferTokensAny.run({ offer_file_id: id, live: true }, client);
  expect(legs.length).toBe(2);
});

test("getOpenOffersPage is blob-free but carries offer_hash + blob_chars; batched legs resolve", async () => {
  const page = await getOpenOffersPage.run(
    { token: "", direction: "ANY", limit: 10, offset: 0 },
    client,
  );
  expect(page.length).toBe(1);
  expect(page[0].offer_hash).toBe(HASH_A);
  expect(page[0].blob_chars).toBe("swapoffer1testblob-a".length);
  expect((page[0] as any).transaction_hex).toBeUndefined();
  const legs = await getOfferTokensForOffers.run(
    { offer_file_ids: page.map((o) => o.id) },
    client,
  );
  expect(legs.length).toBe(2);
});

test("token/direction filters work on the page query", async () => {
  const giving = await getOpenOffersPage.run(
    { token: TOKEN_G, direction: "GIVING", limit: 10, offset: 0 },
    client,
  );
  expect(giving.length).toBe(1);
  const wrongDir = await getOpenOffersPage.run(
    { token: TOKEN_G, direction: "WANTING", limit: 10, offset: 0 },
    client,
  );
  expect(wrongDir.length).toBe(0);
});

test("duplicate probe: getOfferStatusByHash sees the open offer", async () => {
  const rows = await getOfferStatusByHash.run({ offer_hash: HASH_A }, client);
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("live");
});

test("archiveOfferByNullifierWithHash carries offer_hash into history", async () => {
  const id = await insertOffer(HASH_B, "swapoffer1testblob-b");
  await insertOfferFileNullifier.run(
    { offer_file_id: id, nullifier: "null-b" },
    client,
  );
  // Mirror the real transition order: the spend (with its tx hash) is
  // recorded BEFORE the archive fires. Without it the classifier correctly
  // reports `cancelled` (a partial/unrecorded spend can never be a fill).
  await insertNullifierWithTx.run(
    { nullifier: "null-b", height: 1, tx_hash: "settletx" },
    client,
  );
  const archived = await archiveOfferByNullifierWithHash.run(
    { nullifier: "null-b", archived_at: new Date("2026-01-02T03:04:05Z") },
    client,
  );
  expect(archived.length).toBe(1);

  const hist = await client.query(
    "SELECT offer_hash, archive_reason, archived_at FROM offer_file_history WHERE id = $1",
    [id],
  );
  expect(hist.rows[0].offer_hash).toBe(HASH_B);
  // archived_at is exactly the timestamp the caller passed (the L2 block time
  // at the state machine) — never a DB-side NOW().
  expect(new Date(hist.rows[0].archived_at).toISOString()).toBe("2026-01-02T03:04:05.000Z");

  const status = await getOfferStatusByHash.run({ offer_hash: HASH_B }, client);
  expect(status.length).toBe(1);
  expect(status[0].status).toBe("consumed");

  // Detail lookup still resolves after archiving, with history legs.
  const detail = await getOfferByHash.run({ offer_hash: HASH_B }, client);
  expect(detail[0].status).toBe("consumed");
  const legs = await getOfferTokensAny.run({ offer_file_id: id, live: false }, client);
  expect(legs.length).toBe(2);
});

test("spec-removed columns are gone from the schema (auth block, maker note)", async () => {
  // MIP-0006 removed wrapper auth (unsound, privacy-harming) and maker
  // messages (phishing surface; no ledger field for an authenticated one).
  // Negative assertion so the columns cannot quietly return.
  const r = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_name IN ('offer_file', 'offer_file_history')
       AND (column_name LIKE 'auth_%' OR column_name = 'metadata_maker_note')`,
  );
  expect(r.rows).toEqual([]);
});

test("unique index rejects a second open offer with the same hash", async () => {
  await expect(insertOffer(HASH_A, "swapoffer1testblob-a2")).rejects.toThrow();
});

test("page query uses the created_at index path, not a join scan (EXISTS plan)", async () => {
  // Regression guard for the EXISTS rewrite: the unfiltered page must be a
  // plain index scan on idx_offer_file_created_at with no join/unique node
  // (the old DISTINCT + LEFT JOIN shape was ~12× slower and got worse with
  // book size).
  const r = await client.query(`EXPLAIN
    SELECT o.id FROM offer_file o
    WHERE ('' = '' OR EXISTS (
      SELECT 1 FROM offer_file_tokens oft
      WHERE oft.offer_file_id = o.id AND oft.token_color = ''))
    ORDER BY o.created_at DESC LIMIT 100`);
  const plan = r.rows.map((row: any) => row["QUERY PLAN"]).join("\n");
  expect(plan).toContain("idx_offer_file_created_at");
  expect(plan).not.toContain("Unique");
});
