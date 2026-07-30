import { afterAll, beforeAll, expect, test } from "bun:test";

// The framework persists every fetched Celestia blob in
// effectstream.primitive_accounting forever. Because the namespace is
// permissionless, that is attacker-controlled storage, so the STM deletes the
// row whenever it rejects an offer and records the rejection as a bounded
// per-(height, code) counter instead.
//
// These tests run the real SQL against the real table shape (mirrored from the
// framework's system-up-v-0.0.1/0.0.2 migrations, generated payload_hash and
// UNIQUE index included).
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  deleteRejectedAccountingRow,
  recordOfferRejection,
  getRecentRejections,
} = await import("@zswap-da/database");

const PORT = 54335;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

const BIG_BLOB = "swapoffer1" + "q".repeat(24_000);
const OTHER_BLOB = "swapoffer1" + "p".repeat(24_000);

const accountingPayload = (blob: string, commitment: string, blobIndex: number) =>
  JSON.stringify({
    payload: {
      suppliedValue: blob,
      namespace: "000000000000deadbeef",
      commitment,
      blobIndex,
    },
  });

async function insertBlob(height: number, blob: string, commitment: string, idx: number) {
  await client.query(
    `INSERT INTO effectstream.primitive_accounting
       (primitive_name, effectstream_block_height, payload_type, payload)
     VALUES ('celestia-zswap', $1, 'celestia-generic', $2::json)
     ON CONFLICT (primitive_name, effectstream_block_height, payload_hash) DO NOTHING`,
    [height, accountingPayload(blob, commitment, idx)],
  );
}

const suppliedValues = async (height: number): Promise<string[]> => {
  const r = await client.query(
    `SELECT payload->'payload'->>'suppliedValue' AS v
     FROM effectstream.primitive_accounting
     WHERE effectstream_block_height = $1
     ORDER BY payload->'payload'->>'blobIndex'`,
    [height],
  );
  return r.rows.map((row: any) => row.v);
};

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
  await client.query("CREATE SCHEMA IF NOT EXISTS effectstream");
  await client.query(`
    CREATE TABLE effectstream.primitive_accounting (
      primitive_name TEXT NOT NULL,
      id SERIAL,
      effectstream_block_height INTEGER NOT NULL,
      payload_type TEXT NOT NULL,
      payload JSON NOT NULL,
      payload_hash TEXT GENERATED ALWAYS AS (md5(payload::text)) STORED,
      PRIMARY KEY (primitive_name, id)
    )`);
  await client.query(`
    CREATE UNIQUE INDEX primitive_accounting_unique_payload_per_block
    ON effectstream.primitive_accounting
       (primitive_name, effectstream_block_height, payload_hash)`);
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
});

test("rejecting a blob removes its stored body entirely", async () => {
  await insertBlob(100, BIG_BLOB, "commit-a", 0);
  await deleteRejectedAccountingRow.run(
    { block_height: 100, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(100)).toEqual([]);
});

test("delete only touches the matching blob, leaving accepted offers intact", async () => {
  await insertBlob(300, BIG_BLOB, "commit-d", 0);
  await insertBlob(300, OTHER_BLOB, "commit-e", 1);
  await deleteRejectedAccountingRow.run(
    { block_height: 300, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(300)).toEqual([OTHER_BLOB]);
});

test("delete is scoped to its block — the same blob at another height survives", async () => {
  await insertBlob(400, BIG_BLOB, "commit-f", 0);
  await insertBlob(401, BIG_BLOB, "commit-g", 0);
  await deleteRejectedAccountingRow.run(
    { block_height: 400, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(400)).toEqual([]);
  expect(await suppliedValues(401)).toEqual([BIG_BLOB]);
});

test("delete is idempotent (replay re-fetches, re-rejects, re-deletes)", async () => {
  await deleteRejectedAccountingRow.run(
    { block_height: 100, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(100)).toEqual([]);
});

test("many rejected blobs in one block all delete (no unique-index interference)", async () => {
  // Deleting sidesteps the UNIQUE(primitive_name, height, md5(payload))
  // constraint that any in-place rewrite would have to avoid colliding with.
  for (let i = 0; i < 10; i++) {
    await insertBlob(500, `${BIG_BLOB}${i}`, `commit-${i}`, i);
  }
  expect((await suppliedValues(500)).length).toBe(10);
  for (let i = 0; i < 10; i++) {
    await deleteRejectedAccountingRow.run(
      { block_height: 500, supplied_value: `${BIG_BLOB}${i}` },
      client,
    );
  }
  expect(await suppliedValues(500)).toEqual([]);
});

test("rejection counters aggregate per (height, code)", async () => {
  for (let i = 0; i < 5; i++) {
    await recordOfferRejection.run({ celestia_height: 700, code: "BAD_ENCODING" }, client);
  }
  await recordOfferRejection.run({ celestia_height: 700, code: "ROOT_UNKNOWN" }, client);
  await recordOfferRejection.run({ celestia_height: 701, code: "BAD_ENCODING" }, client);

  const rows = await getRecentRejections.run({ limit: 10 }, client);
  const at700 = rows.filter((r) => String(r.celestia_height) === "700");
  expect(at700.find((r) => r.code === "BAD_ENCODING")!.count).toBe(5);
  expect(at700.find((r) => r.code === "ROOT_UNKNOWN")!.count).toBe(1);
  expect(rows[0].celestia_height.toString()).toBe("701"); // newest height first
});

test("counter rows are bounded by heights × codes, not by blob count", async () => {
  // The property that makes keeping this table safe: spam inflates counts,
  // never row count. 1000 junk blobs in one block => still one row.
  const before = (await getRecentRejections.run({ limit: 1000 }, client)).length;
  for (let i = 0; i < 1000; i++) {
    await recordOfferRejection.run({ celestia_height: 800, code: "BAD_ENCODING" }, client);
  }
  const after = await getRecentRejections.run({ limit: 1000 }, client);
  expect(after.length).toBe(before + 1);
  expect(after.find((r) => String(r.celestia_height) === "800")!.count).toBe(1000);
});
