import { afterAll, beforeAll, expect, test } from "bun:test";

// Item #19 phase 1: fill-vs-cancel classification from nullifier tx grouping.
// Settlement is atomic — a fill consumes ALL of an offer's inputs in ONE
// Midnight transaction — so split or partial spends are definitively
// cancels. The matrix below runs the REAL status queries over pglite:
//
//   all nullifiers, one tx      → consumed  (fill, heuristically)
//   nullifiers across two txs   → cancelled (definitive)
//   only some nullifiers spent  → cancelled (definitive)
//   single input, spent         → consumed  (heuristic — no fill markers)
//   no nullifiers (unshielded)  → consumed  (no shielded data to group)
//   TTL archive                 → expired
//
// Phase 2 (item #22, Midnight:NullifierAndCommitment): offers with stored
// output commitments get EXACT classification — one spend tx that also
// created the offer's commitments is a verified fill; one spend tx WITHOUT
// them is a proven cancel, single-input included:
//
//   1 tx + all markers created  → consumed  (verified fill)
//   1 tx + markers NOT created  → cancelled (proven — was mislabelled before)
//   single input + markers made → consumed  (verified — heuristic upgraded)
//   no stored markers           → heuristic unchanged (rows 1–5 above)
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  getOfferStatusByHash,
  getOfferByHash,
  insertNullifierWithTx,
  insertCommitment,
  getPairStats24h,
  getTradeHistory,
  upsertPairStatsByOfferId,
} = await import("@zswap-da/database");

const PORT = 54343;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

const BASE = "b".repeat(64);
const QUOTE = "q".repeat(64);
const BASE2 = "c".repeat(64);
const QUOTE2 = "d".repeat(64);
// These fixtures seed rows relative to NOW(), so their window starts 24 h
// before wall clock. Production derives it from the chain tip instead.
const DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);
const hashOf = (n: number) => n.toString(16).padStart(64, "0");
const TX_A = "aa11";
const TX_B = "bb22";

// Archived offer straight into history (the shape the archive queries write),
// with legs (gives 10 BASE / wants 20 QUOTE → price 2) and its nullifier list.
async function seedArchived(
  id: number,
  reason: "CONSUMED" | "TTL",
  nullifiers: string[],
  commitments: string[] = [],
  // Phase-2 rows use their own pair so the chart/history assertions over
  // BASE/QUOTE keep counting exactly the phase-1 fills.
  pair: [string, string] = [BASE, QUOTE],
) {
  await client.query(
    `INSERT INTO offer_file_history
       (id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds, archive_reason, archived_at)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', 3600, $5, NOW() - INTERVAL '30 minutes')`,
    [id, 100 + id, `blob-${id}`, hashOf(id), reason],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, '10', 'GIVING', 'SHIELDED', NOW() - INTERVAL '30 minutes'),
            ($1, $3, '20', 'WANTING', 'SHIELDED', NOW() - INTERVAL '30 minutes')`,
    [id, pair[0], pair[1]],
  );
  for (const n of nullifiers) {
    await client.query(
      `INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier, archived_at)
       VALUES ($1, $2, NOW() - INTERVAL '30 minutes')`,
      [id, n],
    );
  }
  for (const c of commitments) {
    await client.query(
      `INSERT INTO offer_file_commitments_history (offer_file_id, commitment)
       VALUES ($1, $2)`,
      [id, c],
    );
  }
}

const created = (commitment: string, txHash: string | null) =>
  insertCommitment.run(
    { commitment, tx_hash: txHash, mt_index: null, height: 1 },
    client,
  );

const spend = (nullifier: string, txHash: string | null) =>
  insertNullifierWithTx.run({ nullifier, height: 1, tx_hash: txHash }, client);

const statusOf = async (id: number) => {
  const rows = await getOfferStatusByHash.run({ offer_hash: hashOf(id) }, client);
  expect(rows.length).toBe(1);
  return rows[0].status;
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

  // 1: two nullifiers, both spent in TX_A → consumed
  await seedArchived(1, "CONSUMED", ["n1a", "n1b"]);
  await spend("n1a", TX_A);
  await spend("n1b", TX_A);

  // 2: two nullifiers spent across TWO txs → cancelled (definitive)
  await seedArchived(2, "CONSUMED", ["n2a", "n2b"]);
  await spend("n2a", TX_A);
  await spend("n2b", TX_B);

  // 3: two nullifiers, only one ever spent → cancelled (definitive)
  await seedArchived(3, "CONSUMED", ["n3a", "n3b"]);
  await spend("n3a", TX_B);

  // 4: single-input offer, spent → consumed (heuristic ceiling)
  await seedArchived(4, "CONSUMED", ["n4a"]);
  await spend("n4a", TX_B);

  // 5: unshielded-only (no nullifiers) → consumed
  await seedArchived(5, "CONSUMED", []);

  // 6: TTL → expired regardless of nullifier state
  await seedArchived(6, "TTL", []);

  // ── Phase 2: offers WITH stored fill markers ──
  // 7: one spend tx which ALSO created both markers → verified fill
  await seedArchived(7, "CONSUMED", ["n7a", "n7b"], ["c7a", "c7b"], [BASE2, QUOTE2]);
  await spend("n7a", TX_A);
  await spend("n7b", TX_A);
  await created("c7a", TX_A);
  await created("c7b", TX_A);

  // 8: one spend tx, markers NEVER created → proven cancel. Under the
  // nullifier-grouping heuristic alone this offer reads consumed (compare
  // offer 1) — the markers are what flip it.
  await seedArchived(8, "CONSUMED", ["n8a", "n8b"], ["c8a", "c8b"], [BASE2, QUOTE2]);
  await spend("n8a", TX_A);
  await spend("n8b", TX_A);

  // 9: SINGLE-input offer, spend tx created its markers → verified fill for
  // the case the heuristic could never classify (offer 4).
  await seedArchived(9, "CONSUMED", ["n9a"], ["c9a"], [BASE2, QUOTE2]);
  await spend("n9a", TX_B);
  await created("c9a", TX_B);

  // 10: single-input offer, marker created by a DIFFERENT tx (maker moved
  // the coin; someone else's tx happens to be recorded) → proven cancel.
  await seedArchived(10, "CONSUMED", ["n10a"], ["c10a"], [BASE2, QUOTE2]);
  await spend("n10a", TX_B);
  await created("c10a", TX_A);
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
});

test("tx_hash is captured and first-seen wins on replay", async () => {
  const r = await client.query(
    "SELECT tx_hash FROM nullifiers WHERE nullifier = 'n1a'",
  );
  expect(r.rows[0].tx_hash).toBe(TX_A);
  await spend("n1a", "ff99"); // replayed event with a different hash
  const again = await client.query(
    "SELECT tx_hash FROM nullifiers WHERE nullifier = 'n1a'",
  );
  expect(again.rows[0].tx_hash).toBe(TX_A);
});

test("phase-2 matrix: fill markers make classification exact", async () => {
  expect(await statusOf(7)).toBe("consumed");   // verified fill
  expect(await statusOf(8)).toBe("cancelled");  // markers absent → proven cancel
  expect(await statusOf(9)).toBe("consumed");   // single-input, verified
  expect(await statusOf(10)).toBe("cancelled"); // marker in the wrong tx
});

test("commitment insert is idempotent; first-seen tx wins on replay", async () => {
  await created("c-replay", TX_A);
  await created("c-replay", TX_B); // replayed event, different claimed tx
  const r = await client.query(
    "SELECT tx_hash FROM commitments WHERE commitment = 'c-replay'",
  );
  expect(r.rows[0].tx_hash).toBe(TX_A);
});

test("classification matrix", async () => {
  expect(await statusOf(1)).toBe("consumed"); // all-in-one-tx
  expect(await statusOf(2)).toBe("cancelled"); // split across txs
  expect(await statusOf(3)).toBe("cancelled"); // partial spend
  expect(await statusOf(4)).toBe("consumed"); // single input
  expect(await statusOf(5)).toBe("consumed"); // unshielded-only
  expect(await statusOf(6)).toBe("expired"); // TTL
});

test("detail endpoint query agrees with the status query", async () => {
  for (const [id, want] of [[1, "consumed"], [2, "cancelled"], [6, "expired"]] as const) {
    const rows = await getOfferByHash.run({ offer_hash: hashOf(id) }, client);
    expect(rows[0].status).toBe(want);
  }
});

test("chart stats count only genuine fills — cancels contribute nothing", async () => {
  // Offers 1, 4, 5 are consumed (10 BASE each); 2 and 3 are cancels at the
  // same price and would inflate volume by 20 BASE if counted.
  const s = (await getPairStats24h.run({ base: BASE, quote: QUOTE, cutoff: DAY_AGO }, client))[0];
  expect(Number(s.volume_base_24h)).toBe(30);
  expect(s.fills_24h).toBe(3);
});

test("trade history hides cancels", async () => {
  const rows = await getTradeHistory.run({ base: BASE, quote: QUOTE }, client);
  expect(rows.length).toBe(3);
});

test("pair_stats.last_traded_at is the archived block time, not NOW()", async () => {
  // The fixture archives rows with archived_at = NOW() - 30 minutes. If the
  // upsert still stamped NOW() (the old bug: node-local wall clock, divergent
  // across replicas and wrong after a resync), last_traded_at would be ~now.
  await upsertPairStatsByOfferId.run({ offer_id: 1 }, client);
  const r = await client.query(
    `SELECT (NOW() - last_traded_at) >= INTERVAL '29 minutes' AS chain_derived,
            last_traded_at = (SELECT archived_at FROM offer_file_history WHERE id = 1) AS matches_archive
     FROM pair_stats`,
  );
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].chain_derived).toBe(true);
  expect(r.rows[0].matches_archive).toBe(true);
  await client.query("DELETE FROM pair_stats");
});

test("pair_stats writer refuses cancelled offers", async () => {
  await upsertPairStatsByOfferId.run({ offer_id: 2 }, client); // cancelled
  let r = await client.query("SELECT COUNT(*)::int AS n FROM pair_stats");
  expect(r.rows[0].n).toBe(0);
  await upsertPairStatsByOfferId.run({ offer_id: 1 }, client); // consumed
  r = await client.query("SELECT trade_count FROM pair_stats");
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].trade_count).toBe(1);
});

// ── §2.2, FIXED in PR-C. Kept as a permanent regression guard ───────────────
//
// upsertPairStatsByOfferId assigns base_color/quote_color by LEAST/GREATEST of
// the hex color, but computes last_price as `w.amount / g.amount` with no
// reference to which of them became base:
//
//   gives the lesser color (= base)  → want/give = quote per base  ✔
//   gives the greater color (= quote) → want/give = base per quote  ✘  1/p
//
// Every other price path normalises explicitly — getPairStats24h does
// `CASE WHEN g.token_color = :base THEN w/g ELSE g/w END`, and trade-data.ts's
// toFill() does the same in JS. Only this one does not, so `/v1/pairs`'s price
// column flips meaning with the direction of the most recent trade and
// disagrees with `/v1/chart/stats` by a factor of p².
//
// This lives at unit level because the direction is only controllable here: in
// an e2e run, whether the last fill on a pair went the "wrong" way is data
// dependent, and a coin-flip red would fail the build at random.
//
// The two offers below are economically IDENTICAL — 10 LO against 20 HI — and
// differ only in which side the maker took. Their recorded price must not.
// Was verified to fail for the RIGHT reason before the fix: the forward
// direction recorded 2 and the reverse 0.5 — same trade, reciprocal price.
test("pair_stats.last_price is quote-per-base in BOTH trade directions", async () => {
  const LO = "1".repeat(64); // lexically lesser  → becomes base_color
  const HI = "9".repeat(64); // lexically greater → becomes quote_color

  // Archived CONSUMED offers with no nullifiers: classification falls through
  // every cancelledPredicate branch to `consumed`, so the writer accepts them.
  const seedDirected = async (id: number, give: string, giveAmt: string, want: string, wantAmt: string) => {
    await client.query(
      `INSERT INTO offer_file_history
         (id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds, archive_reason, archived_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '30 minutes')`,
      [id, 900 + id, `blob-${id}`, hashOf(id)],
    );
    await client.query(
      `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
       VALUES ($1, $2, $3, 'GIVING',  'SHIELDED', NOW() - INTERVAL '30 minutes'),
              ($1, $4, $5, 'WANTING', 'SHIELDED', NOW() - INTERVAL '30 minutes')`,
      [id, give, giveAmt, want, wantAmt],
    );
  };

  await client.query("DELETE FROM pair_stats");
  // Direction 1 — maker gives the lesser color. Price = 20/10 = 2.
  await seedDirected(901, LO, "10", HI, "20");
  await upsertPairStatsByOfferId.run({ offer_id: 901 }, client);
  const forward = await client.query(
    `SELECT base_color, last_price::float8 AS p FROM pair_stats WHERE base_color = $1`, [LO],
  );
  expect(forward.rows[0].p).toBeCloseTo(2, 9); // passes today

  // Direction 2 — maker gives the greater color. Same trade, same pair, and
  // the same quote-per-base price of 2. Today this records 0.5.
  await seedDirected(902, HI, "20", LO, "10");
  await upsertPairStatsByOfferId.run({ offer_id: 902 }, client);
  const reverse = await client.query(
    `SELECT last_price::float8 AS p FROM pair_stats WHERE base_color = $1`, [LO],
  );
  expect(reverse.rows[0].p).toBeCloseTo(2, 9);

  // And the authoritative SQL aggregate must agree with the stored column —
  // the cross-route disagreement users actually see.
  const stats = (await getPairStats24h.run({ base: LO, quote: HI, cutoff: DAY_AGO }, client))[0];
  expect(Number(stats!.last_price)).toBeCloseTo(Number(reverse.rows[0].p), 9);
});
