import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeTestPglite } from "./test-pglite.ts";

// Item #19 phase 1: fill-vs-cancel classification from nullifier tx grouping.
// Settlement is atomic — a fill consumes ALL of an offer's inputs in ONE
// Midnight transaction — so split or partial spends are definitively
// cancels. The matrix below runs the REAL status queries over pglite:
//
//   all nullifiers, one tx      → unknown   (fill/cancel ambiguous)
//   nullifiers across two txs   → cancelled (definitive)
//   only some nullifiers spent  → cancelled (definitive)
//   single input, spent         → unknown   (fill/cancel ambiguous)
//   no nullifiers (unshielded)  → unknown   (no settlement proof)
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
//   no stored markers           → unknown unless cancellation is proven
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
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const BASE = "b".repeat(64);
const QUOTE = "q".repeat(64);
const BASE2 = "c".repeat(64);
const QUOTE2 = "d".repeat(64);
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

async function addArchivedUnshieldedSpend(id: number) {
  await client.query(
    `INSERT INTO offer_file_unshielded_spends_history
       (offer_file_id, owner, intent_hash, output_no, archived_at)
     VALUES ($1, $2, $3, 0, NOW() - INTERVAL '30 minutes')`,
    [id, `owner-${id}`, `intent-${id}`],
  );
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

  // 1: two nullifiers, both spent in TX_A → unknown without fill markers
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

  // 4: single-input offer, spent → unknown without fill markers
  await seedArchived(4, "CONSUMED", ["n4a"]);
  await spend("n4a", TX_B);

  // 5: unshielded-only (no nullifiers) → unknown without a settlement proof
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

  // 11: a pure-unshielded input has no tx-bound nullifier evidence. Even if a
  // matching commitment exists elsewhere, it cannot prove this offer filled.
  await seedArchived(11, "CONSUMED", [], ["c11a"], [BASE2, QUOTE2]);
  await created("c11a", TX_A);

  // 12: the shielded side has apparently valid fill markers, but this mixed
  // offer also contains an unshielded input. The schema retains no tx hash for
  // that spend, so the complete atomic settlement cannot be proven.
  await seedArchived(12, "CONSUMED", ["n12a"], ["c12a"], [BASE2, QUOTE2]);
  await addArchivedUnshieldedSpend(12);
  await spend("n12a", TX_A);
  await created("c12a", TX_A);
});

afterAll(async () => {
  await closeTestPglite(handle, client);
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
  expect(await statusOf(11)).toBe("unknown");   // no tx-bound spend proof
  expect(await statusOf(12)).toBe("unknown");   // mixed input lacks complete tx proof
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
  expect(await statusOf(1)).toBe("unknown"); // all-in-one-tx, but markerless
  expect(await statusOf(2)).toBe("cancelled"); // split across txs
  expect(await statusOf(3)).toBe("cancelled"); // partial spend
  expect(await statusOf(4)).toBe("unknown"); // single input, markerless
  expect(await statusOf(5)).toBe("unknown"); // unshielded-only, no proof
  expect(await statusOf(6)).toBe("expired"); // TTL
});

test("detail endpoint query agrees with the status query", async () => {
  for (const [id, want] of [[1, "unknown"], [2, "cancelled"], [6, "expired"]] as const) {
    const rows = await getOfferByHash.run({ offer_hash: hashOf(id) }, client);
    expect(rows[0].status).toBe(want);
  }
});

test("chart stats count only marker-verified fills", async () => {
  // Markerless rows 1/4/5 and proven cancels 2/3 are all excluded.
  const s = (await getPairStats24h.run({ base: BASE, quote: QUOTE }, client))[0];
  expect(Number(s.volume_base_24h ?? 0)).toBe(0);
  expect(s.fills_24h).toBe(0);
});

test("trade history hides cancels", async () => {
  const rows = await getTradeHistory.run({ base: BASE, quote: QUOTE }, client);
  expect(rows.length).toBe(0);
});

test("pair_stats.last_traded_at is the archived block time, not NOW()", async () => {
  // The fixture archives rows with archived_at = NOW() - 30 minutes. If the
  // upsert still stamped NOW() (the old bug: node-local wall clock, divergent
  // across replicas and wrong after a resync), last_traded_at would be ~now.
  await upsertPairStatsByOfferId.run({ offer_id: 7 }, client);
  const r = await client.query(
    `SELECT (NOW() - last_traded_at) >= INTERVAL '29 minutes' AS chain_derived,
            last_traded_at = (SELECT archived_at FROM offer_file_history WHERE id = 7) AS matches_archive
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
  await upsertPairStatsByOfferId.run({ offer_id: 1 }, client); // markerless unknown
  r = await client.query("SELECT COUNT(*)::int AS n FROM pair_stats");
  expect(r.rows[0].n).toBe(0);
  await upsertPairStatsByOfferId.run({ offer_id: 7 }, client); // verified consumed
  r = await client.query("SELECT trade_count FROM pair_stats");
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].trade_count).toBe(1);
});
