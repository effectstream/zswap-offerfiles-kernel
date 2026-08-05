// What do the market queries actually report for ONE multi-leg offer?
//
// Not an argument — a measurement. Seeds a single CONSUMED offer that gives
// A=1317 + B=1424 and wants C=1983 + D=1826 (the shape produced by merging a
// shielded and an unshielded offer), then runs the REAL queries the API serves
// from and prints what a client would see.
//
//   bun test packages/database/multileg-pairs.test.ts

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, getPairStats24h, getTradeHistory, getPairs, upsertPairStatsByOfferId } =
  await import("@zswap-da/database");
// The exact functions api.ts calls for /v1/chart/stats and /v1/chart/history.
const { realStats, realHistory } = await import("../node/trade-data.ts");

import { afterAll, expect, test } from "bun:test";

const PORT = 54399;
const handle = await startPglite(PORT);
const client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
await client.connect();
for (const m of migrationTable) await client.query(m.sql);

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64);
const NAME: Record<string, string> = { [A]: "A", [B]: "B", [C]: "C", [D]: "D" };
const legs: [string, string, string][] = [
  [A, "1317", "GIVING"], [B, "1424", "GIVING"],
  [C, "1983", "WANTING"], [D, "1826", "WANTING"],
];

await client.query(
  `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash, created_at,
     ttl_seconds, archive_reason, archived_at)
   VALUES (1, 1, 'blob', $1, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '10 minutes')`,
  ["e".repeat(64)],
);
for (const [color, amt, dir] of legs) {
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES (1, $1, $2, $3, 'SHIELDED', NOW() - INTERVAL '10 minutes')`,
    [color, amt, dir],
  );
}
// The same offer, still open, to show the book side.
await client.query(
  `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, metadata_created_at, ttl_seconds)
   VALUES (2, 1, 'blob2', $1, NOW(), 3600)`,
  ["f".repeat(64)],
);
for (const [color, amt, dir] of legs) {
  await client.query(
    `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
     VALUES (2, $1, $2, $3, 'SHIELDED')`,
    [color, amt, dir],
  );
}
await upsertPairStatsByOfferId.run({ offer_id: 1 }, client);

// KNOWN RED — PR-F (PRODUCTION-READINESS.md §2.5).
//
// The volume double-count is arguable: per pair each figure is defensible, and
// it only doubles if you sum across pairs. The PRICE is not arguable. One
// transaction has ONE exchange rate; the query reports four, each manufactured
// by pretending the other legs do not exist. A basket rate cannot be split per
// pair without an allocation the transaction never specifies.
test.failing("one settlement produces ONE price, not one per give x want pair", async () => {
console.log("ONE settled offer:  gives A=1317 B=1424   wants C=1983 D=1826");
console.log("ONE open offer with the same legs.\n");

console.log("What /v1/chart/* reports, pair by pair:");
let vol: Record<string, number> = {};
let tradeRows = 0;
for (const [base, quote] of [[A, C], [A, D], [B, C], [B, D], [A, B], [C, D]] as [string, string][]) {
  const s = (await getPairStats24h.run({ base, quote }, client))[0]!;
  const h = await getTradeHistory.run({ base, quote }, client);
  if (!s.last_price && h.length === 0) continue;
  tradeRows += h.length;
  vol[NAME[base]!] = (vol[NAME[base]!] ?? 0) + Number(s.volume_base_24h ?? 0);
  vol[NAME[quote]!] = (vol[NAME[quote]!] ?? 0) + Number(s.volume_quote_24h ?? 0);
  console.log(
    `  ${NAME[base]}/${NAME[quote]}: fills=${s.fills_24h} price=${Number(s.last_price).toFixed(4)} ` +
      `vol_base=${s.volume_base_24h} vol_quote=${s.volume_quote_24h} historyRows=${h.length}`,
  );
}

console.log(`\n  trade-history rows across all pairs: ${tradeRows}   (the offer settled ONCE)`);
console.log("  volume attributed per colour vs what actually changed hands:");
for (const [k, actual] of [["A", 1317], ["B", 1424], ["C", 1983], ["D", 1826]] as [string, number][]) {
  const got = vol[k] ?? 0;
  console.log(`    ${k}: reported ${got}, actually moved ${actual}${got !== actual ? `  <-- x${(got / actual).toFixed(0)}` : ""}`);
}

// ── The actual HTTP responses a client receives ──────────────────────────
const short = (o: any) => JSON.stringify(o, (k, v) =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? NAME[v] ?? v.slice(0, 6) : v);

console.log("\n──────── GET /v1/chart/stats?base=A&quote=C ────────");
console.log(short(await realStats(client, A, C)));
console.log("\n──────── GET /v1/chart/stats?base=A&quote=D ────────");
console.log(short(await realStats(client, A, D)));
console.log("   ^ same 1317 units of A, two different last prices\n");

console.log("──────── GET /v1/chart/history?base=A&quote=C ────────");
console.log(short(await realHistory(client, A, C)));
console.log("──────── GET /v1/chart/history?base=A&quote=D ────────");
console.log(short(await realHistory(client, A, D)));
console.log("   ^ the SAME settlement, same timestamp, same size, two prices\n");

console.log("──────── GET /v1/pairs ────────");
const pairs = await getPairs.run(undefined, client);
console.log(short(pairs.map((p: any) => ({
  pairKey: `${NAME[p.base_color]}|${NAME[p.quote_color]}`,
  tradeCount: p.trade_count,
  lastPrice: p.last_price ? Number(p.last_price).toFixed(4) : null,
  openCount: p.open_count,
}))));
console.log("   ^ 4 markets, 4 trade_counts, from 1 settled + 1 open offer");

// The assertion, stated on the unarguable part.
const prices = new Set<string>();
for (const [base, quote] of [[A, C], [A, D], [B, C], [B, D]] as [string, string][]) {
  const s2 = (await getPairStats24h.run({ base, quote }, client))[0]!;
  if (s2.last_price != null) prices.add(Number(s2.last_price).toFixed(6));
}
expect(tradeRows).toBe(1);          // one settlement, one trade
expect(prices.size).toBe(1);        // one settlement, one rate



});

afterAll(async () => { await handle.close().catch(() => {}); });
