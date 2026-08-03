import { afterAll, beforeAll, expect, test } from "bun:test";

// Verifies the nullifiers table (merged from seen_nullifiers + spent_nullifiers)
// and its queries end-to-end against an in-memory PGlite served over the pg wire
// protocol — no Docker / external Postgres needed. Regression guard for the
// hand-written pgtyped IR (param offsets) and the migration SQL.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  upsertNullifier,
  isNullifierSpent,
  markNullifierMatched,
  findUnmatchedNullifier,
} = await import("@zswap-da/database");

const PORT = 54329;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

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

test("upsertNullifier: insert then isNullifierSpent returns row, absent nullifier returns empty", async () => {
  await upsertNullifier.run({ nullifier: "deadbeef", height: 7 }, client);
  expect((await isNullifierSpent.run({ nullifier: "deadbeef" }, client)).length).toBe(1);
  expect((await isNullifierSpent.run({ nullifier: "cafe" }, client)).length).toBe(0);
});

test("upsertNullifier is idempotent (ON CONFLICT DO NOTHING)", async () => {
  await upsertNullifier.run({ nullifier: "dup", height: 1 }, client);
  await upsertNullifier.run({ nullifier: "dup", height: 2 }, client);
  expect((await isNullifierSpent.run({ nullifier: "dup" }, client)).length).toBe(1);
});

test("findUnmatchedNullifier: returns row when offer_matched=false, empty after markNullifierMatched", async () => {
  await upsertNullifier.run({ nullifier: "early", height: 5 }, client);
  expect((await findUnmatchedNullifier.run({ nullifier: "early" }, client)).length).toBe(1);
  await markNullifierMatched.run({ nullifier: "early" }, client);
  expect((await findUnmatchedNullifier.run({ nullifier: "early" }, client)).length).toBe(0);
  // isNullifierSpent still returns the row (offer_matched=true is still a spent record)
  expect((await isNullifierSpent.run({ nullifier: "early" }, client)).length).toBe(1);
});

test("nullifiers are retained regardless of age or match state (no TTL)", async () => {
  // Guards the invariant that replaced the old TTL prune: a spend is
  // permanent, so `isNullifierSpent` must still see it however old the row is
  // and whether or not it ever matched one of our offers. Deleting unmatched
  // rows used to let a long-spent coin back a freshly published offer.
  await client.query(`
    INSERT INTO nullifiers (nullifier, height, recorded_at, offer_matched)
    VALUES
      ('ancient_unmatched', 1, NOW() - INTERVAL '400 days', false),
      ('fresh_unmatched',   2, NOW(),                       false),
      ('ancient_matched',   3, NOW() - INTERVAL '400 days', true)
  `);
  for (const n of ["ancient_unmatched", "fresh_unmatched", "ancient_matched"]) {
    expect((await isNullifierSpent.run({ nullifier: n }, client)).length).toBe(1);
  }
});
