import { afterAll, beforeAll, expect, test } from "bun:test";

// Verifies the 002-liveness-sets migration + the created_unshielded / known_roots
// queries end-to-end against an in-memory PGlite over the pg wire protocol — no
// Docker / external Postgres. Regression guard for the hand-written pgtyped IR
// (param offsets) and the migration SQL. Mirrors spent-sets.test.ts.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  insertCreatedUnshielded,
  deleteCreatedUnshielded,
  isUnshieldedCreated,
  upsertKnownRootWithFirstSeen,
  isKnownRootLive,
  pruneKnownRoots,
} = await import("@zswap-da/database");

// The only root writer there is. The generated UpsertKnownRoot it replaced did
// not set first_seen_ms, which is now NOT NULL — so these fixtures used to seed
// a row shape production can no longer produce.
const seedRoot = (root: string, height: number, seen_ms: number) =>
  upsertKnownRootWithFirstSeen.run({ root, height, seen_ms }, client);

/** Presence in known_roots, ignoring the recency window. */
const present = async (root: string) =>
  (await client.query("SELECT 1 FROM known_roots WHERE root = $1", [root])).rows.length;

const PORT = 54331;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of migrationTable) {
    await client.query(migration.sql);
  }
});

afterAll(async () => {
  // Close server/DB without a client Terminate (PGlite WASM throws on it).
  try {
    await handle?.close();
  } catch { /* noop */ }
});

test("created_unshielded: insert, present lookup, partial-mismatch absent", async () => {
  const ref = { owner: "owner1", intent_hash: "ih1", output_no: 2 };
  await insertCreatedUnshielded.run({ ...ref, height: 11 }, client);
  expect((await isUnshieldedCreated.run(ref, client)).length).toBe(1);
  expect((await isUnshieldedCreated.run({ ...ref, output_no: 3 }, client)).length).toBe(0);
});

test("created_unshielded insert is idempotent (ON CONFLICT DO NOTHING)", async () => {
  const ref = { owner: "dup", intent_hash: "ihdup", output_no: 0 };
  await insertCreatedUnshielded.run({ ...ref, height: 1 }, client);
  await insertCreatedUnshielded.run({ ...ref, height: 2 }, client);
  expect((await isUnshieldedCreated.run(ref, client)).length).toBe(1);
});

test("deleteCreatedUnshielded: spend removes the row (liveness check fails after)", async () => {
  const ref = { owner: "spender", intent_hash: "ihspend", output_no: 0 };
  await insertCreatedUnshielded.run({ ...ref, height: 5 }, client);
  expect((await isUnshieldedCreated.run(ref, client)).length).toBe(1);
  await deleteCreatedUnshielded.run(ref, client);
  expect((await isUnshieldedCreated.run(ref, client)).length).toBe(0);
});

test("deleteCreatedUnshielded on absent row is a no-op", async () => {
  await deleteCreatedUnshielded.run({ owner: "ghost", intent_hash: "ih", output_no: 0 }, client);
  // no error thrown
});

test("known_roots: upsert, present lookup, absent lookup", async () => {
  await seedRoot("rootA", 100, 1000);
  expect(await present("rootA")).toBe(1);
  expect(await present("nope")).toBe(0);
});

test("upserting a known root refreshes height + last_seen_ms on conflict", async () => {
  await seedRoot("rootB", 5, 500);
  await seedRoot("rootB", 9, 900);
  const rows = await client.query(
    "SELECT height, last_seen_ms, first_seen_ms FROM known_roots WHERE root = 'rootB'",
  );
  expect(Number(rows.rows[0].height)).toBe(9);
  expect(Number(rows.rows[0].last_seen_ms)).toBe(900);
  // first_seen_ms is set once and never moved — the whole reason expiry is
  // derived from it rather than from last_seen_ms. Covered in depth in
  // root-first-seen.test.ts; asserted here so the two writers cannot drift.
  expect(Number(rows.rows[0].first_seen_ms)).toBe(500);
});

test("isKnownRootLive enforces the window at READ time (quiet-chain case)", async () => {
  // Pruning is write-triggered (midnight-zswap-root transition), so on a quiet
  // chain aged rows simply survive in the table. The read must not trust
  // presence alone — but it must keep the CURRENT root valid regardless of
  // age, because the ledger's past_roots re-inserts it every block while our
  // primitive only fires on root ADVANCE.
  await client.query("DELETE FROM known_roots");
  await seedRoot("aged", 10, 1_000);
  await seedRoot("fresh", 20, 5_000);
  await seedRoot("current", 30, 1_200);
  const cutoff_ms = 4_000;
  // aged: present in the table but outside the window -> NOT live.
  expect((await isKnownRootLive.run({ root: "aged", cutoff_ms }, client)).length).toBe(0);
  // fresh: inside the window -> live.
  expect((await isKnownRootLive.run({ root: "fresh", cutoff_ms }, client)).length).toBe(1);
  // current (MAX height): stale by timestamp yet still live — the escape.
  expect((await isKnownRootLive.run({ root: "current", cutoff_ms }, client)).length).toBe(1);
  // unknown root stays unknown whatever the cutoff.
  expect((await isKnownRootLive.run({ root: "nope", cutoff_ms: 0 }, client)).length).toBe(0);
});

test("pruneKnownRoots drops aged roots but never the latest height", async () => {
  await client.query("DELETE FROM known_roots");
  // old (age out), mid (age out), latest (must survive even though it's 'old')
  await seedRoot("old", 10, 1_000);
  await seedRoot("mid", 20, 2_000);
  await seedRoot("latest", 30, 1_500);
  // cutoff 1_900 → "old" (1000) and "latest" (1500) are below it, "mid" (2000) is not.
  // "latest" has MAX(height)=30 so it must be retained despite being below cutoff.
  await pruneKnownRoots.run({ cutoff_ms: 1_900 }, client);
  expect(await present("old")).toBe(0);
  expect(await present("mid")).toBe(1);
  expect(await present("latest")).toBe(1);
});
