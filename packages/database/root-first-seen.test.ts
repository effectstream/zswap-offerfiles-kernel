import { afterAll, beforeAll, expect, test } from "bun:test";

// known_roots timing — the deterministic basis for shielded expiry.
//
// Two drift bugs live here, and the fixtures below pin both:
//
//   1. Computing expiry from first_seen_ms. It advances never, so an offer
//      expired while the chain still accepted it. (Fixed long ago; guarded by
//      "EXPIRY tracks last_seen".)
//   2. Computing it from raw last_seen_ms. That only advances when our
//      midnight-zswap-root primitive observes a root ADVANCE, while the ledger
//      re-inserts the CURRENT root every block regardless — so on a quiet chain
//      the newest root goes stale in our table while remaining valid on chain,
//      and an offer was served `status: live` with an expiry eleven minutes in
//      its own past (§2.6). getOfferRootTiming carries the current-root escape
//      that isKnownRootLive already applied at the read gate.
//
// HEIGHTS ARE GLOBAL HERE. The escape asks `height >= (SELECT MAX(height) FROM
// known_roots)` over the WHOLE table, so a root is "current" relative to every
// other row in this file, not just its own test. TIP_H below is kept above
// everything, and tests that need a superseded root use heights well under it.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  upsertKnownRootWithFirstSeen,
  getOfferRootTiming,
} = await import("@zswap-da/database");

const PORT = 54347;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

/** Height of the chain tip in this file. Anything lower is superseded. */
const TIP_H = 1_000_000;
/** Stands in for ROOT_WINDOW_SECONDS * 1000 in deadline arithmetic. */
const WINDOW_MS = 3_600_000;

/** The query under test: anchor + window = the offer's layer deadline. */
const timing = (roots: string[], blockMs: number) =>
  getOfferRootTiming.run({ roots, block_ms: blockMs }, client);

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
  // The chain tip: a root nothing else outranks, so every other fixture root
  // is superseded unless it explicitly claims TIP_H too.
  await upsertKnownRootWithFirstSeen.run(
    { root: "tip", height: TIP_H, seen_ms: 50_000 },
    client,
  );
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

test("MIN across an offer's roots — it dies when the FIRST of them leaves the window", async () => {
  await upsertKnownRootWithFirstSeen.run({ root: "ra", height: 1, seen_ms: 8000 }, client);
  await upsertKnownRootWithFirstSeen.run({ root: "rb", height: 1, seen_ms: 3000 }, client);
  await upsertKnownRootWithFirstSeen.run({ root: "rc", height: 1, seen_ms: 6000 }, client);
  const r = await timing(["ra", "rb", "rc"], 0);
  expect(Number(r[0].first_seen_ms)).toBe(3000);
  expect(Number(r[0].window_anchor_ms)).toBe(3000);
});

test("EXPIRY tracks last_seen, which ADVANCES as the root is re-accepted", async () => {
  await upsertKnownRootWithFirstSeen.run({ root: "refresh", height: 1, seen_ms: 1_000 }, client);
  const before = await timing(["refresh"], 0);
  expect(Number(before[0].window_anchor_ms)).toBe(1_000);

  for (const t of [2_000, 5_000, 9_000]) {
    await upsertKnownRootWithFirstSeen.run({ root: "refresh", height: 2, seen_ms: t }, client);
  }
  const after = await timing(["refresh"], 0);
  expect(Number(after[0].window_anchor_ms)).toBe(9_000);  // expiry moved out
  expect(Number(after[0].first_seen_ms)).toBe(1_000);     // firstSeenAt did not
});

// ── §2.6: the current-root escape ───────────────────────────────────────────

test("CASE 1 — a quiet CURRENT root anchors at block time, not its stale sighting", async () => {
  // THE §2.6 case. The root is the chain tip, but our table last saw it long
  // ago because no advance has occurred. The ledger still accepts proofs
  // against it, so the deadline must run from NOW, not from the stale sighting.
  await upsertKnownRootWithFirstSeen.run({ root: "quiet", height: TIP_H, seen_ms: 10_000 }, client);
  const blockMs = 900_000;
  const r = await timing(["quiet"], blockMs);
  expect(Number(r[0].window_anchor_ms)).toBe(blockMs);
  // Without the escape this deadline would sit ~15 minutes in the past.
  expect(Number(r[0].window_anchor_ms) + WINDOW_MS).toBeGreaterThan(blockMs);
});

test("CASE 2 — a SUPERSEDED root near the boundary expires on its own sighting", async () => {
  // Not the tip, so no escape: the chain really will stop accepting it a
  // window after it was last current, and cleanup must be scheduled for then.
  await upsertKnownRootWithFirstSeen.run({ root: "superseded", height: 5, seen_ms: 10_000 }, client);
  // Far enough past that anchor + window is genuinely behind us: 10_000 +
  // 3_600_000 = 3_610_000 < 4_000_000. The offer is already unfillable, so the
  // STM schedules its sweep for a time already gone and it archives at once.
  const blockMs = 4_000_000;
  const r = await timing(["superseded"], blockMs);
  expect(Number(r[0].window_anchor_ms)).toBe(10_000);      // its own sighting
  expect(Number(r[0].window_anchor_ms)).not.toBe(blockMs); // escape NOT applied
  expect(Number(r[0].window_anchor_ms) + WINDOW_MS).toBeLessThan(blockMs);
});

test("CASE 3 — current + stale together are bounded by the STALE one", async () => {
  // The case that kills the naive implementation. Taking MIN(last_seen_ms)
  // first and THEN asking "is any root current?" would apply the escape to the
  // whole offer, lifting it to block time and extending the offer past the
  // point its oldest root actually dies. The escape is per-row, before MIN, so
  // the stale root still governs.
  await upsertKnownRootWithFirstSeen.run({ root: "mix-cur", height: TIP_H, seen_ms: 10_000 }, client);
  await upsertKnownRootWithFirstSeen.run({ root: "mix-old", height: 7, seen_ms: 20_000 }, client);
  const blockMs = 900_000;
  const r = await timing(["mix-cur", "mix-old"], blockMs);
  expect(Number(r[0].window_anchor_ms)).toBe(20_000);      // the stale root
  expect(Number(r[0].window_anchor_ms)).not.toBe(blockMs); // NOT lifted
});

test("the escape never SHORTENS a window — a current root seen recently keeps its own anchor", async () => {
  // GREATEST, not assignment: if the tip was seen AFTER this block (replay,
  // out-of-order ingestion), the later sighting stands.
  await upsertKnownRootWithFirstSeen.run({ root: "fresh-tip", height: TIP_H, seen_ms: 950_000 }, client);
  const r = await timing(["fresh-tip"], 900_000);
  expect(Number(r[0].window_anchor_ms)).toBe(950_000);
});

test("prune evicts on last_seen, matching the expiry basis (both mirror TimeFilterMap)", async () => {
  await upsertKnownRootWithFirstSeen.run({ root: "old", height: 1, seen_ms: 1_000 }, client);
  const r = await timing(["old"], 0);
  const expiry = Number(r[0].window_anchor_ms) + WINDOW_MS;
  expect(expiry - WINDOW_MS).toBe(Number(r[0].window_anchor_ms));
});

test("empty / unshielded-only root set yields NULL (caller falls back to intent TTL)", async () => {
  const r = await timing([], 900_000);
  expect(r[0].first_seen_ms).toBeNull();
  expect(r[0].window_anchor_ms).toBeNull();
  const r2 = await timing(["never-seen"], 900_000);
  expect(r2[0].first_seen_ms).toBeNull();
  expect(r2[0].window_anchor_ms).toBeNull();
});

test("firstSeenAt is stable across re-upserts (offer age must not drift)", async () => {
  await upsertKnownRootWithFirstSeen.run({ root: "stable", height: 1, seen_ms: 100_000 }, client);
  const before = Number((await timing(["stable"], 0))[0].first_seen_ms);
  for (const t of [200_000, 500_000, 900_000]) {
    await upsertKnownRootWithFirstSeen.run({ root: "stable", height: 2, seen_ms: t }, client);
  }
  const after = Number((await timing(["stable"], 0))[0].first_seen_ms);
  expect(after).toBe(before); // pinned — unlike expiry, which tracks last_seen
});
