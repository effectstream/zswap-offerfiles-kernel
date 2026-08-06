import { afterAll, beforeAll, expect, test } from "bun:test";

// Item #15 regression proof: 24 h chart stats must aggregate over EVERY fill
// in the window, not the display query's LIMIT 120. Seeds >120 fills at known
// prices and asserts volume/high/low cover ALL of them and change24 baselines
// on the fill just older than 24 h — both of which fail against the old
// implementation. Runs realStats() itself (not a copy) over in-memory PGlite.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const { realStats, realHistory } = await import("./trade-data.ts");

const PORT = 54341;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

const BASE = "b".repeat(64);
const QUOTE = "q".repeat(64);
// Other pair, to prove isolation.
const OTHER = "0".repeat(64);

let nextId = 1;

// One CONSUMED fill: maker gives `baseAmt` BASE, wants `quoteAmt` QUOTE
// (price = quoteAmt / baseAmt), archived `minutesAgo` before now.
async function seedFill(
  baseAmt: number,
  quoteAmt: number,
  minutesAgo: number,
  colors: [string, string] = [BASE, QUOTE],
) {
  const id = nextId++;
  await client.query(
    `INSERT INTO offer_file_history
       (id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds,
        archive_reason, archived_at, first_seen_at)
     VALUES ($1, $2, $3, $5, NOW() - ($4 || ' minutes')::interval, 3600, 'CONSUMED',
             NOW() - ($4 || ' minutes')::interval, NOW())`,
    // offer_hash and first_seen_at are both NOT NULL: the archive queries copy
    // them from the live row, so a history row missing either is a shape
    // production cannot produce.
    [id, 1000 + id, `fill-${id}`, String(minutesAgo), id.toString(16).padStart(64, "0")],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, $3, 'GIVING', 'SHIELDED', NOW() - ($6 || ' minutes')::interval),
            ($1, $4, $5, 'WANTING', 'SHIELDED', NOW() - ($6 || ' minutes')::interval)`,
    [id, colors[0], String(baseAmt), colors[1], String(quoteAmt), String(minutesAgo)],
  );
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

  // 130 in-window fills (> the 120-row display cap), oldest→newest over the
  // last ~22 h. Every fill trades 10 BASE; prices ramp 1.00 → 2.29 in cents.
  // The window MIN sits on the OLDEST in-window fill and the MAX on the
  // newest — both ends of exactly the range the old code truncated.
  for (let i = 0; i < 130; i++) {
    const price = 1 + i * 0.01; // fill i: price 1.00 + i¢
    const minutesAgo = 1330 - i * 10; // 22h10m ago … 40m ago
    await seedFill(10, 10 * price, minutesAgo);
  }
  // The change24 baseline: newest fill OLDER than 24 h, price 0.50.
  await seedFill(10, 5, 25 * 60); // 25 h ago
  // Even older noise that must never affect the window aggregates.
  await seedFill(10, 1000, 48 * 60); // absurd price 100, 48 h ago
  // A different pair inside the window — must not leak in.
  await seedFill(10, 999, 60, [BASE, OTHER]);
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
});

test("volume covers ALL 130 in-window fills, not the newest 120", async () => {
  const s = await realStats(client, BASE, QUOTE);
  // 130 fills × 10 BASE each. Old code: 120 × 10 = 1200 — the regression.
  expect(s.volume_base).toBe(1300);
  const expectedQuote = Array.from({ length: 130 }, (_, i) => 10 * (1 + i * 0.01))
    .reduce((a, b) => a + b, 0);
  expect(s.volume_quote).toBeCloseTo(expectedQuote, 6);
});

test("high/low span the whole window — low sits on a fill the display cap drops", async () => {
  const s = await realStats(client, BASE, QUOTE);
  expect(s.high).toBeCloseTo(2.29, 9); // newest fill
  // Oldest in-window fill (price 1.00) is one of the 10 rows the display
  // cap discards; the old code reported low = 1.10.
  expect(s.low).toBeCloseTo(1.0, 9);
  // Sanity: the display query really is capped — the premise of the bug.
  const hist = await realHistory(client, BASE, QUOTE);
  expect(hist.length).toBe(120);
});

test("change24 baselines on the newest fill older than 24 h, not the 120th-newest trade", async () => {
  const s = await realStats(client, BASE, QUOTE);
  expect(s.last).toBeCloseTo(2.29, 9);
  // ref = 0.50 (25 h ago) → +358%. Old code's ref was in-cap history ≈ 1.10.
  expect(s.change24).toBeCloseTo(((2.29 - 0.5) / 0.5) * 100, 6);
});

test("other pairs and pre-window noise do not leak into the window", async () => {
  const s = await realStats(client, BASE, QUOTE);
  expect(s.high).toBeLessThan(3); // neither price-100 (48 h) nor 99.9 (other pair)
});

test("pair with fills but none in-window: last survives, window numbers are zero", async () => {
  // Reuses only the >24 h rows by querying the reversed pair? No — seed a
  // dedicated quiet pair: one fill 30 h ago at price 4.
  const QUIET = "e".repeat(64);
  await seedFill(10, 40, 30 * 60, [QUIET, QUOTE]);
  const s = await realStats(client, QUIET, QUOTE);
  expect(s.last).toBeCloseTo(4, 9);
  expect(s.volume_base).toBe(0);
  expect(s.volume_quote).toBe(0);
  expect(s.high).toBeCloseTo(4, 9); // collapses to last, not stale aggregates
  expect(s.low).toBeCloseTo(4, 9);
  expect(s.change24).toBeCloseTo(0, 9);
});

test("no fills at all falls back to open-book mid (unchanged behaviour)", async () => {
  const EMPTY = "f".repeat(64);
  const s = await realStats(client, EMPTY, QUOTE);
  expect(s.last).toBe(0);
  expect(s.volume_base).toBe(0);
});

// ── §2.3, FIXED in PR-D. Kept as a permanent regression guard ───────────────
//
// getPairStats24h USED TO bound its window with `NOW() - INTERVAL '24 hours'`
// while comparing against `h.archived_at`, which since the chain-time fix is
// the L2 BLOCK timestamp. Two clocks, one comparison — the same defect class
// that fix closed one layer down, and closing it is what made this reachable.
//
// Any node whose chain clock was not wall clock (a replica catching up, a
// replay, a devnet anchored in the past, an NTP anchor pinned by
// GRAND_NTP_START_TIME) reported zero volume and a collapsed high/low while
// /v1/chart/history still listed every fill. The API contradicting itself.
//
// The cutoff now comes from `effectstream_blocks.ms_timestamp` at the tip — the
// same value api.ts uses for the root-window gate. This test seeds that tip.
//
// Note the tests ABOVE run before this one and have no effectstream_blocks
// table at all: they exercise the documented fallback to wall clock, which is
// correct for an empty chain with no fills to window.
//
// Was verified to fail for the RIGHT reason before the fix: `last` read 2.5
// (the fill present and correctly priced) while volume_base read 0 — the
// window, and only the window, dropped it.
test("24h window follows the CHAIN clock, not the wall clock", async () => {
  // This node is 48 h behind wall clock, and its tip block says so.
  await client.query(`CREATE SCHEMA IF NOT EXISTS effectstream`);
  await client.query(`CREATE TABLE IF NOT EXISTS effectstream.effectstream_blocks (
      block_height BIGINT PRIMARY KEY,
      ms_timestamp BIGINT,
      effectstream_block_hash BYTEA,
      main_chain_block_hash BYTEA)`);
  const chainNowMs = Date.now() - 48 * 3600_000;
  await client.query(
    `INSERT INTO effectstream.effectstream_blocks (block_height, ms_timestamp) VALUES (1, $1)
     ON CONFLICT (block_height) DO UPDATE SET ms_timestamp = EXCLUDED.ms_timestamp`,
    [String(chainNowMs)],
  );

  // One fill, one hour of CHAIN time ago — squarely inside any 24 h window
  // measured on the clock that stamped it.
  const LAGGED = "a".repeat(64);
  await seedFill(10, 25, 49 * 60, [LAGGED, QUOTE]);

  const s = await realStats(client, LAGGED, QUOTE);
  // `last` is not window-bound, so it is right even today. Asserting it first
  // isolates the failure to the WINDOW rather than to the fill being missing.
  expect(s.last).toBeCloseTo(2.5, 9);
  expect(s.volume_base).toBe(10);
  expect(s.volume_quote).toBe(25);
  expect(s.high).toBeCloseTo(2.5, 9);
});

test("stats query hits the (archive_reason, archived_at) index, no seq scan of history", async () => {
  const r = await client.query(`EXPLAIN
    SELECT COUNT(*) FROM offer_file_history h
    WHERE h.archive_reason = 'CONSUMED'
      AND h.archived_at > NOW() - INTERVAL '24 hours'`);
  const plan = r.rows.map((row: any) => row["QUERY PLAN"]).join("\n");
  expect(plan).toContain("idx_offer_file_history_reason_archived_at");
});
