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
  insertOfferFileToken,
  insertOfferFileNullifier,
  archiveOfferByNullifierWithHash,
  getOfferByHash,
  getOfferStatusByHash,
  getOfferTokensAny,
  getOpenOffersPage,
  getOfferTokensForOffers,
  getOffersMissingHash,
  setOpenOfferHash,
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
      metadata_maker_note: null,
      auth_signer_public_key: null,
      auth_signature: null,
      auth_scheme: null,
      ttl_seconds: 3600,
    },
    client,
  );
  const id = rows[0].id;
  await insertOfferFileToken.run(
    { offer_file_id: id, token_color: TOKEN_G, amount: "10", direction: "GIVING" },
    client,
  );
  await insertOfferFileToken.run(
    { offer_file_id: id, token_color: TOKEN_W, amount: "5", direction: "WANTING" },
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
  expect(rows[0].status).toBe("open");
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
  expect(rows[0].status).toBe("open");
});

test("archiveOfferByNullifierWithHash carries offer_hash into history", async () => {
  const id = await insertOffer(HASH_B, "swapoffer1testblob-b");
  await insertOfferFileNullifier.run(
    { offer_file_id: id, nullifier: "null-b" },
    client,
  );
  const archived = await archiveOfferByNullifierWithHash.run(
    { nullifier: "null-b" },
    client,
  );
  expect(archived.length).toBe(1);

  const hist = await client.query(
    "SELECT offer_hash, archive_reason FROM offer_file_history WHERE id = $1",
    [id],
  );
  expect(hist.rows[0].offer_hash).toBe(HASH_B);

  const status = await getOfferStatusByHash.run({ offer_hash: HASH_B }, client);
  expect(status.length).toBe(1);
  expect(status[0].status).toBe("completed");

  // Detail lookup still resolves after archiving, with history legs.
  const detail = await getOfferByHash.run({ offer_hash: HASH_B }, client);
  expect(detail[0].status).toBe("completed");
  const legs = await getOfferTokensAny.run({ offer_file_id: id, live: false }, client);
  expect(legs.length).toBe(2);
});

test("unique index rejects a second open offer with the same hash", async () => {
  await expect(insertOffer(HASH_A, "swapoffer1testblob-a2")).rejects.toThrow();
});

test("backfill queries find and fix rows missing a hash", async () => {
  await client.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, ttl_seconds)
     VALUES (901, 1, 'swapoffer1legacy', 3600)`,
  );
  const missing = await getOffersMissingHash.run(undefined, client);
  expect(missing.some((r) => r.id === 901 && r.live)).toBe(true);
  await setOpenOfferHash.run({ id: 901, offer_hash: "c".repeat(64) }, client);
  const after = await getOffersMissingHash.run(undefined, client);
  expect(after.some((r) => r.id === 901)).toBe(false);
});
