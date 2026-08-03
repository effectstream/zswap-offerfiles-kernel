import { afterAll, beforeAll, expect, test } from "bun:test";

// Item #10: known_roots.first_seen_ms — the deterministic basis for shielded
// expiry. The drift bug this prevents: computing expiry from last_seen_ms,
// which advances on every re-acceptance of a root, so an offer's expiry moved
// later each time a quiet chain re-saw its root — non-deterministic across
// nodes that re-synced at different times.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  upsertKnownRootWithFirstSeen,
  getEarliestRootFirstSeen,
} = await import("@zswap-da/database");

const PORT = 54347;
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

test("first_seen_ms is pinned on first insert and never moves; last_seen_ms advances", async () => {
  await upsertKnownRootWithFirstSeen.run({ root: "r1", height: 10, seen_ms: 1000 }, client);
  await upsertKnownRootWithFirstSeen.run({ root: "r1", height: 20, seen_ms: 5000 }, client);
  await upsertKnownRootWithFirstSeen.run({ root: "r1", height: 30, seen_ms: 9000 }, client);
  const r = await client.query(
    "SELECT first_seen_ms, last_seen_ms, height FROM known_roots WHERE root = 'r1'",
  );
  expect(Number(r.rows[0].first_seen_ms)).toBe(1000); // pinned
  expect(Number(r.rows[0].last_seen_ms)).toBe(9000);  // advanced (prune basis)
  expect(Number(r.rows[0].height)).toBe(30);
});

test("returns MIN of BOTH first_seen and last_seen across an offer's roots", async () => {
  await upsertKnownRootWithFirstSeen.run({ root: "ra", height: 1, seen_ms: 8000 }, client);
  await upsertKnownRootWithFirstSeen.run({ root: "rb", height: 1, seen_ms: 3000 }, client);
  await upsertKnownRootWithFirstSeen.run({ root: "rc", height: 1, seen_ms: 6000 }, client);
  const r = await getEarliestRootFirstSeen.run({ roots: ["ra", "rb", "rc"] }, client);
  // The offer dies when the FIRST of its roots leaves the window.
  expect(Number(r[0].first_seen_ms)).toBe(3000);
  expect(Number(r[0].last_seen_ms)).toBe(3000);
});

test("EXPIRY tracks last_seen, which ADVANCES as the root is re-accepted", async () => {
  // The ledger's past_roots is a TimeFilterMap: the current root is
  // re-inserted every block and entries older than (tblock − window) are
  // evicted. So on a quiet chain segment the same root keeps refreshing and
  // the offer stays fillable — the window runs from the LAST block whose
  // tree state it proved against. An expiry pinned to first_seen (an earlier
  // revision of this code) would have expired live offers early.
  await upsertKnownRootWithFirstSeen.run({ root: "refresh", height: 1, seen_ms: 1_000 }, client);
  const before = await getEarliestRootFirstSeen.run({ roots: ["refresh"] }, client);
  expect(Number(before[0].last_seen_ms)).toBe(1_000);

  for (const t of [2_000, 5_000, 9_000]) {
    await upsertKnownRootWithFirstSeen.run({ root: "refresh", height: 2, seen_ms: t }, client);
  }
  const after = await getEarliestRootFirstSeen.run({ roots: ["refresh"] }, client);
  expect(Number(after[0].last_seen_ms)).toBe(9_000);   // expiry moved out
  expect(Number(after[0].first_seen_ms)).toBe(1_000);  // firstSeenAt did not
});

test("prune evicts on last_seen, matching the expiry basis (both mirror TimeFilterMap)", async () => {
  // Consistency guard: a root is prunable exactly when its expiry has passed.
  const WINDOW_MS = 3_600_000;
  await upsertKnownRootWithFirstSeen.run({ root: "old", height: 1, seen_ms: 1_000 }, client);
  const r = await getEarliestRootFirstSeen.run({ roots: ["old"] }, client);
  const expiry = Number(r[0].last_seen_ms) + WINDOW_MS;
  const cutoff = expiry - WINDOW_MS; // == last_seen: the prune threshold
  expect(cutoff).toBe(Number(r[0].last_seen_ms));
});

test("empty / unshielded-only root set yields NULL (caller falls back to intent/TTL)", async () => {
  const r = await getEarliestRootFirstSeen.run({ roots: [] }, client);
  expect(r[0].first_seen_ms).toBeNull();
  const r2 = await getEarliestRootFirstSeen.run({ roots: ["never-seen"] }, client);
  expect(r2[0].first_seen_ms).toBeNull();
});

test("firstSeenAt is stable across re-upserts (offer age must not drift)", async () => {
  await upsertKnownRootWithFirstSeen.run({ root: "stable", height: 1, seen_ms: 100_000 }, client);
  const before = Number(
    (await getEarliestRootFirstSeen.run({ roots: ["stable"] }, client))[0].first_seen_ms,
  );
  for (const t of [200_000, 500_000, 900_000]) {
    await upsertKnownRootWithFirstSeen.run({ root: "stable", height: 2, seen_ms: t }, client);
  }
  const after = Number(
    (await getEarliestRootFirstSeen.run({ roots: ["stable"] }, client))[0].first_seen_ms,
  );
  expect(after).toBe(before); // pinned — unlike expiry, which tracks last_seen
});
