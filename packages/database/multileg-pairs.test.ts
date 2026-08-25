// §2.5 — a basket offer contributes NOTHING to price discovery.
//
// Not an argument, a measurement. Seeds ONE settled offer that gives
// A=1317 + B=1424 and wants C=1983 + D=1826 (the shape a merge of two offers
// produces) plus one open offer with the same legs, then runs the REAL queries
// the API serves from and prints what a client would see.
//
// Pre-fix, that single settlement rendered as FOUR trades at four different
// prices on four pairs, with every leg's volume counted twice, and /v1/pairs
// manufactured four markets with open counts. The printed output below is the
// evidence; the assertions pin it.
//
// RULING (§2.5): ACCEPT-but-exclude. A basket is a legitimate sealed
// settlement — it lives, settles and archives like any other offer, and this
// test asserts that half too. What it is not is a price: nobody agreed 1317 A
// is worth 1983 C, only that A+B together are worth C+D together.
//
// Why exclusion rather than reconstruction: merging is lossy at the segment
// level. Two zswaps merged into one transaction land in segment 0 TOGETHER,
// netted, with nothing left to say which +N pairs with which -M
// (probe-segments.ts). The sealed sub-balances are unrecoverable from the
// bytes, so no query-side reconstruction is honest.
//
// A CONTROL offer (a plain single-colour swap, E for F) runs alongside
// throughout. Every exclusion assertion here would also pass if the filter
// simply broke all five queries; the control is what distinguishes "baskets
// excluded" from "market data empty".
//
//   bun test packages/database/multileg-pairs.test.ts

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, getPairStats24h, getTradeHistory, getPairs, getOpenLegs,
        adjudicateOfferFill, findUnadjudicatedFills, PAIRS_ORDER_BY } = await import("@zswap-da/database");
// The exact functions api.ts calls for /v1/chart/stats and /v1/chart/history.
const { realStats, realHistory } = await import("../node/trade-data.ts");

import { afterAll, describe, expect, test } from "bun:test";

// Fixtures seed rows relative to NOW(), so their window starts 24 h before
// wall clock. Production derives it from the chain tip instead (trade-data.ts).
const DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PORT = 54399;
const handle = await startPglite(PORT);
const client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
await client.connect();
  // @effectstream/db 0.200.1: startPglite's close() DESTROYS live sockets
  // (0.103.1 closed politely). afterAll deliberately never sends a client
  // Terminate (PGlite WASM throws on it), so the destroy surfaces here as a
  // 'error' event — expected at teardown, not a test failure. Swallow it.
  client.on("error", () => {});
for (const m of migrationTable) await client.query(m.sql);

// The framework owns effectstream_blocks, so migrationTable does not create it.
// Create it EMPTY: chainWindowStart then takes its real "no processed block
// yet" fallback. Without this, realStats/realHistory throw undefined-relation —
// and a throw is exactly how this file's `test.failing` used to go green
// WITHOUT the defect being present, which meant the red could never have
// signalled its own fix.
await client.query(`CREATE SCHEMA IF NOT EXISTS effectstream`);
await client.query(`CREATE TABLE IF NOT EXISTS effectstream.effectstream_blocks (
    block_height BIGINT PRIMARY KEY,
    ms_timestamp BIGINT,
    effectstream_block_hash BYTEA,
    main_chain_block_hash BYTEA)`);

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64);
const E = "e".repeat(64), F = "f".repeat(64);
const NAME: Record<string, string> = { [A]: "A", [B]: "B", [C]: "C", [D]: "D", [E]: "E", [F]: "F" };

const basketLegs: [string, string, string][] = [
  [A, "1317", "GIVING"], [B, "1424", "GIVING"],
  [C, "1983", "WANTING"], [D, "1826", "WANTING"],
];
// The control: one give colour, one want colour. Ordinary, and must stay fully
// visible on every surface a basket disappears from.
const plainLegs: [string, string, string][] = [
  [E, "100", "GIVING"], [F, "250", "WANTING"],
];

/** The product's own repair sweep, run verbatim. */
async function adjudicateAll() {
  const owed = await findUnadjudicatedFills.run({ limit: 10_000 }, client);
  for (const row of owed) await adjudicateOfferFill.run({ offer_id: row.id }, client);
}

/**
 * An archived fill for `pair` at an EXACT time — the ordering fixtures need
 * identical last_traded_at across pairs, which is the tie the tiebreaker
 * exists for. Seeded as a real offer and adjudicated, never by writing the
 * verdict columns by hand: a hand-written verdict could disagree with the
 * adjudicator and this file would not notice.
 */
async function seedFillAt(id: number, base: string, quote: string, at: Date) {
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash, created_at,
       ttl_seconds, archive_reason, archived_at, first_seen_at)
     VALUES ($1, 1, 'blob', $2, $3, 3600, 'CONSUMED', $3, $3)`,
    [id, id.toString(16).padStart(64, "0"), at],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, '1', 'GIVING', 'SHIELDED', $4),
            ($1, $3, '1', 'WANTING', 'SHIELDED', $4)`,
    [id, base, quote, at],
  );
  await adjudicateAll();
}

async function seedArchived(id: number, hash: string, legs: [string, string, string][]) {
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash, created_at,
       ttl_seconds, archive_reason, archived_at, first_seen_at)
     VALUES ($1, 1, 'blob', $2, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '10 minutes', NOW())`,
    [id, hash],
  );
  for (const [color, amt, dir] of legs) {
    await client.query(
      `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
       VALUES ($1, $2, $3, $4, 'SHIELDED', NOW() - INTERVAL '10 minutes')`,
      [id, color, amt, dir],
    );
  }
}

async function seedOpen(id: number, hash: string, legs: [string, string, string][]) {
  await client.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, metadata_created_at, ttl_seconds, first_seen_at)
     VALUES ($1, 1, $2, $3, NOW(), 3600, NOW())`,
    [id, `blob${id}`, hash],
  );
  for (const [color, amt, dir] of legs) {
    await client.query(
      `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
       VALUES ($1, $2, $3, $4, 'SHIELDED')`,
      [id, color, amt, dir],
    );
  }
}

const hash = (n: number) => n.toString(16).padStart(64, "0");
await seedArchived(1, hash(0x11), basketLegs); // settled basket
await seedOpen(2, hash(0x22), basketLegs); // open basket
await seedArchived(3, hash(0x33), plainLegs); // settled control
await seedOpen(4, hash(0x44), plainLegs); // open control
await adjudicateAll();

const BASKET_PAIRS: [string, string][] = [[A, C], [A, D], [B, C], [B, D], [A, B], [C, D]];

describe("§2.5 — baskets are accepted but excluded from market data", () => {
  // ── The exclusion half, surface by surface ───────────────────────────────

  test("SURFACE 1+2 · no chart history rows and no prices on any basket pair", async () => {
    console.log("ONE settled basket:  gives A=1317 B=1424   wants C=1983 D=1826");
    console.log("ONE open basket with the same legs.");
    console.log("Plus a CONTROL: settled + open E->F, one colour each side.\n");

    console.log("What /v1/chart/* reports, pair by pair:");
    const vol: Record<string, number> = {};
    let tradeRows = 0;
    const prices = new Set<string>();
    for (const [base, quote] of BASKET_PAIRS) {
      const s = (await getPairStats24h.run({ base, quote, cutoff: DAY_AGO }, client))[0]!;
      const h = await getTradeHistory.run({ base, quote }, client);
      if (s.last_price != null) prices.add(Number(s.last_price).toFixed(6));
      if (!s.last_price && h.length === 0) continue;
      tradeRows += h.length;
      vol[NAME[base]!] = (vol[NAME[base]!] ?? 0) + Number(s.volume_base_24h ?? 0);
      vol[NAME[quote]!] = (vol[NAME[quote]!] ?? 0) + Number(s.volume_quote_24h ?? 0);
      console.log(
        `  ${NAME[base]}/${NAME[quote]}: fills=${s.fills_24h} price=${Number(s.last_price).toFixed(4)} ` +
          `vol_base=${s.volume_base_24h} vol_quote=${s.volume_quote_24h} historyRows=${h.length}`,
      );
    }
    console.log(`\n  trade-history rows across all basket pairs: ${tradeRows}   (it settled ONCE)`);
    console.log("  volume attributed per colour vs what actually changed hands:");
    for (const [k, actual] of [["A", 1317], ["B", 1424], ["C", 1983], ["D", 1826]] as [string, number][]) {
      const got = vol[k] ?? 0;
      console.log(`    ${k}: reported ${got}, actually moved ${actual}${got !== actual ? `  <-- x${(got / actual).toFixed(0)}` : ""}`);
    }

    expect(tradeRows).toBe(0);
    expect(prices.size).toBe(0);
  });

  test("SURFACE 1+2 · CONTROL — the plain offer is still a trade with a price", async () => {
    const s = (await getPairStats24h.run({ base: E, quote: F, cutoff: DAY_AGO }, client))[0]!;
    const h = await getTradeHistory.run({ base: E, quote: F }, client);
    console.log(`\n  CONTROL E/F: fills=${s.fills_24h} price=${Number(s.last_price).toFixed(4)} historyRows=${h.length}`);
    expect(h.length).toBe(1);
    expect(Number(s.last_price)).toBeCloseTo(2.5, 6); // 250 F per 100 E
    expect(Number(s.volume_base_24h)).toBe(100);
  });

  test("SURFACE 3 · the fill verdicts hold the control only, never a basket pair", async () => {
    const rows = await client.query(
      `SELECT DISTINCT base_color, quote_color FROM offer_file_history
        WHERE settled AND base_color IS NOT NULL
        ORDER BY base_color, quote_color`,
    );
    const keys = rows.rows.map((r: any) =>
      [r.base_color, r.quote_color].map((c: string) => NAME[c] ?? c).join("|"));
    console.log(`\n  priced fills: ${JSON.stringify(keys)}`);
    // Adjudication is where this must be stopped. Filtering only at read time
    // would leave a settled basket carrying colours that every future reader
    // has to remember to skip; instead it is stored settled with NULL colours,
    // which no aggregate can accidentally count.
    expect(keys).toEqual(["E|F"]);
  });

  test("SURFACE 4 · currentMid sees no open basket legs, but does see the control", async () => {
    for (const [base, quote] of BASKET_PAIRS) {
      const legs = await getOpenLegs.run({ base, quote }, client);
      expect(legs.length).toBe(0);
    }
    // realStats falls back to the open-book mid when a pair has no fills. With
    // the basket's open legs excluded there is nothing to quote, so a basket
    // pair must report a null/zero mid rather than an invented one.
    const statsAC = await realStats(client, A, C);
    console.log(`  /v1/chart/stats A/C after exclusion: last=${JSON.stringify(statsAC.last)}`);
    expect(statsAC.last ?? 0).toBe(0);
    expect(statsAC.volume_base).toBe(0);

    expect((await getOpenLegs.run({ base: E, quote: F }, client)).length).toBe(1);
  });

  test("SURFACE 5 · /v1/pairs manufactures no basket markets and no open_count", async () => {
    const pairs = await getPairs.run(undefined, client);
    const shown = pairs.map((p: any) => ({
      pairKey: `${NAME[p.base_color]}|${NAME[p.quote_color]}`,
      tradeCount: p.trade_count,
      lastPrice: p.last_price ? Number(p.last_price).toFixed(4) : null,
      openCount: p.open_count,
    }));
    console.log(`\n  GET /v1/pairs → ${JSON.stringify(shown)}`);

    // Pre-fix this served four fabricated markets with open counts. The
    // control proves the surface still works.
    expect(shown.map((p) => p.pairKey)).toEqual(["E|F"]);
    expect(pairs.reduce((n: number, p: any) => n + Number(p.open_count), 0)).toBe(1);
  });

  // ── The acceptance half. If these fail, the fix overreached ──────────────

  test("the basket is still ACCEPTED — archived CONSUMED and served, not dropped", async () => {
    const arch = await client.query(
      `SELECT archive_reason FROM offer_file_history WHERE id = 1`,
    );
    expect(arch.rows[0].archive_reason).toBe("CONSUMED");

    // Still on the live book as a real offer, with all four legs intact.
    const open = await client.query(`SELECT COUNT(*)::int AS n FROM offer_file WHERE id = 2`);
    expect(open.rows[0].n).toBe(1);
    const legs = await client.query(
      `SELECT COUNT(*)::int AS n FROM offer_file_tokens WHERE offer_file_id = 2`,
    );
    expect(legs.rows[0].n).toBe(4);
  });
});

// ── §8 · /v1/pairs ordering is a CONTRACT, ruled liquidity-first ───────────
//
// "Liquidity first; we want to always show the major players — and make the
// users see by default the largest pools." (Edward, 2026-08-10)
//
//   ORDER BY open_count DESC, last_traded_at DESC NULLS LAST, pair_key
//
// The pair_key tiebreaker is mandatory, not tidiness: last_traded_at quantises
// to L2 block time, so full ties are common, and without a deterministic final
// key two replicas can serve the same pairs in different orders — which is
// exactly what p7a's A-vs-B byte comparison would catch as a phantom failure.
describe("§8 — /v1/pairs ordering contract", () => {
  const G = "1".repeat(64), H = "2".repeat(64), I = "3".repeat(64), J = "4".repeat(64);

  test("liquidity leads, and identical (open_count, last_traded_at) ties break on pair_key", async () => {
    // Wipe the §2.5 fixture so ordering is read on a known set.
    await client.query(`DELETE FROM offer_file_tokens; DELETE FROM offer_file;
                        DELETE FROM offer_file_tokens_history; DELETE FROM offer_file_history`);

    // Two pairs with the SAME trade time — the tie the tiebreaker exists for.
    const at = new Date(Date.now() - 60_000);
    let seedId = 900;
    for (const [base, quote] of [[G, H], [I, J]] as [string, string][]) {
      await seedFillAt(seedId++, base, quote, at);
    }
    // G|H gets ONE open offer; I|J gets none. Under liquidity-first, G|H leads
    // despite the identical trade time — that is the whole ruling.
    await seedOpen(10, hash(0xaa), [[G, "5", "GIVING"], [H, "5", "WANTING"]]);

    const ordered = (await getPairs.run(undefined, client)).map((p: any) => ({
      key: `${NAME[p.base_color] ?? p.base_color.slice(0, 2)}|${NAME[p.quote_color] ?? p.quote_color.slice(0, 2)}`,
      open: Number(p.open_count),
    }));
    console.log(`\n  ordering with a liquidity difference: ${JSON.stringify(ordered)}`);
    expect(ordered[0]!.open).toBe(1);
    expect(ordered[1]!.open).toBe(0);

    // Now remove the liquidity difference so every row ties on BOTH sort keys:
    // same open_count (0), same last_traded_at. Only pair_key can separate
    // them.
    //
    // Rows are INSERTED in descending pair_key order on purpose. Without the
    // tiebreaker the planner is free to return them in physical order — which
    // for a fresh heap is insertion order, i.e. descending — and asserting
    // "sorted" would pass by luck on a small set. Inserting backwards means
    // ascending output can only come from an ORDER BY that names pair_key.
    await client.query(`DELETE FROM offer_file_tokens; DELETE FROM offer_file;
                        DELETE FROM offer_file_tokens_history; DELETE FROM offer_file_history`);
    const tied = ["dd", "cc", "bb", "aa"].map((p) => p.repeat(32));
    for (const c of tied) {
      await seedFillAt(seedId++, c, c, at);
    }
    const keysOf = async () =>
      (await getPairs.run(undefined, client)).map((p: any) => p.pair_key.slice(0, 2));
    const first = await keysOf();
    const second = await keysOf();
    console.log(`  inserted dd,cc,bb,aa → served ${JSON.stringify(first)}`);
    expect(first).toEqual(["aa", "bb", "cc", "dd"]);
    expect(second).toEqual(first); // and stable, which is what replicas need
  });

  // Stated honestly: the assertion above passes WITHOUT the pair_key
  // tiebreaker: the aggregate groups by colour, so it already tends to come
  // back sorted and no fixture can distinguish "ordered by pair_key"
  // from "came back sorted anyway". Verified, not assumed — the test was run
  // against the untiebroken query and stayed green.
  //
  // The tiebreaker still has to be pinned, because the ordering is a published
  // contract and a future edit that drops it would be invisible until two
  // replicas disagreed in production. So it is pinned where it IS observable:
  // on the contract string the query is built from.
  test("the ordering contract names all three keys, in order", () => {
    expect(PAIRS_ORDER_BY).toBe("open_count DESC, last_traded_at DESC NULLS LAST, pair_key");
  });
});

afterAll(async () => { await handle.close().catch(() => {}); });
