import { afterAll, beforeAll, expect, test } from "bun:test";

// The framework persists every fetched Celestia blob in
// effectstream.primitive_accounting forever. Because the namespace is
// permissionless, that is attacker-controlled storage, so the STM scrubs the
// stored body whenever it rejects an offer. These tests run the real scrub SQL
// against the real table shape (mirrored from the framework's
// system-up-v-0.0.1/0.0.2 migrations, including the generated payload_hash and
// its UNIQUE index — the constraint the scrub has to survive).
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { scrubPrimitiveAccountingPayload } = await import("@zswap-da/database");

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
     VALUES ('celestia-zswap', $1, 'celestia-generic', $2::json)`,
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

test("scrub replaces the rejected blob body with the [JUNK] marker", async () => {
  await insertBlob(100, BIG_BLOB, "commit-a", 0);
  await scrubPrimitiveAccountingPayload.run(
    { block_height: 100, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(100)).toEqual(["[JUNK]"]);
});

test("scrub keeps the audit fields (namespace, commitment, blobIndex)", async () => {
  const r = await client.query(
    `SELECT payload->'payload'->>'commitment' AS c,
            payload->'payload'->>'namespace'  AS n,
            payload->'payload'->>'blobIndex'  AS i
     FROM effectstream.primitive_accounting WHERE effectstream_block_height = 100`,
  );
  expect(r.rows[0].c).toBe("commit-a");
  expect(r.rows[0].n).toBe("000000000000deadbeef");
  expect(r.rows[0].i).toBe("0");
});

test("two rejected blobs in the SAME block both scrub without violating the unique payload index", async () => {
  // The regression this table's UNIQUE(primitive_name, height, md5(payload))
  // invites: scrubbing both bodies to the same marker must not collide. It
  // doesn't, because commitment and blobIndex still differ.
  await insertBlob(200, BIG_BLOB, "commit-b", 0);
  await insertBlob(200, OTHER_BLOB, "commit-c", 1);

  await scrubPrimitiveAccountingPayload.run(
    { block_height: 200, supplied_value: BIG_BLOB },
    client,
  );
  await scrubPrimitiveAccountingPayload.run(
    { block_height: 200, supplied_value: OTHER_BLOB },
    client,
  );

  expect(await suppliedValues(200)).toEqual(["[JUNK]", "[JUNK]"]);
  const hashes = await client.query(
    `SELECT COUNT(DISTINCT payload_hash)::int AS n
     FROM effectstream.primitive_accounting WHERE effectstream_block_height = 200`,
  );
  expect(hashes.rows[0].n).toBe(2);
});

test("scrub only touches the matching blob, leaving accepted offers intact", async () => {
  await insertBlob(300, BIG_BLOB, "commit-d", 0);
  await insertBlob(300, OTHER_BLOB, "commit-e", 1);
  await scrubPrimitiveAccountingPayload.run(
    { block_height: 300, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(300)).toEqual(["[JUNK]", OTHER_BLOB]);
});

test("scrub is scoped to its block — same blob at another height is untouched", async () => {
  await insertBlob(400, BIG_BLOB, "commit-f", 0);
  await insertBlob(401, BIG_BLOB, "commit-g", 0);
  await scrubPrimitiveAccountingPayload.run(
    { block_height: 400, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(400)).toEqual(["[JUNK]"]);
  expect(await suppliedValues(401)).toEqual([BIG_BLOB]);
});

test("scrub is idempotent (re-running on an already-scrubbed row is a no-op)", async () => {
  await scrubPrimitiveAccountingPayload.run(
    { block_height: 100, supplied_value: BIG_BLOB },
    client,
  );
  expect(await suppliedValues(100)).toEqual(["[JUNK]"]);
});
