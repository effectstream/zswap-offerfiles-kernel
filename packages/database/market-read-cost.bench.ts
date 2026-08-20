/**
 * What a market read costs as the archive grows AROUND it.
 *
 * WHY THIS FILE EXISTS. The verdict refactor (ruled 2026-08-17) exists to make
 * market reads O(fills-for-the-pair) instead of O(history): a full read-time
 * derivation measured 0.9 s at 500 archived offers, 13.8 s at 2 000 and 170 s
 * at 10 000, which is why the verdict is stored once and read back. But
 * `pricedFillsSql` keeps a computed FALLBACK branch for rows not yet
 * adjudicated — without it a settled offer can report `consumed` and be absent
 * from chart history in the same instant (grand e2e run 3, fixed in 4b49b97).
 * A fallback that itself scans all of history reintroduces exactly the cost the
 * design removes, one layer down, and on single-backend PGlite that contends
 * with the STM's writes — which is what STM lag measures.
 *
 * THE ISOLATION, and it is the whole point of the fixture. The measured pair
 * keeps a FIXED number of fills at every size; only the background — offers on
 * OTHER pairs — grows. A read of the measured pair therefore has a constant
 * amount of genuine work to do, so any growth in its cost is work done on rows
 * it does not return. That separates the two branches cleanly:
 *
 *   - the stored branch is index-scoped to the pair, so background is invisible;
 *   - the fallback branch, if its aggregates are unrestricted, sums every token
 *     row in history before the pair filter can apply — background included.
 *
 * A flat curve means the fallback is O(missing). A curve that tracks background
 * size means it is O(history), whatever the absolute milliseconds are on the
 * box that ran it. The EXPLAIN at the end shows the same fact structurally: the
 * row count the aggregate feeds on.
 *
 * Not a test: it seeds thousands of rows, takes tens of seconds, and asserts
 * nothing. Named `.bench.ts` so `bun test packages` does not collect it. Run:
 *
 *   bun run packages/database/market-read-cost.bench.ts
 */
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  getPairStats24h,
  getTradeHistory,
  getPairs,
  adjudicateOfferFill,
  findUnadjudicatedFills,
} = await import("@zswap-da/database");

// Shared box: ports above 10000, torn down at the end (AGENTS.md).
const PORT = 54891;
const BASE = "b".repeat(64);
const QUOTE = "q".repeat(64);

/** Background archive sizes, on pairs the measurement never asks for. */
const BACKGROUND = [500, 2000, 8000];
/** Fills on the MEASURED pair. Constant across every size, by construction. */
const MEASURED_FILLS = 50;
/**
 * Rows left unadjudicated — the steady state the fallback exists for: the
 * handful of offers archived in the last few seconds, before the post-commit
 * listener has written their verdicts.
 */
const UNADJUDICATED = 5;
/** Repeats per measurement; the median is reported, so an outlier cannot win. */
const REPEATS = 5;

const handle = await startPglite(PORT);
const client = new pg.Client({
  host: "127.0.0.1",
  port: PORT,
  user: "postgres",
  database: "postgres",
});

/**
 * Seed [from, to] as archived CONSUMED offers giving 10 of one colour for 20 of
 * another.
 *
 * No nullifier, commitment or unshielded-marker rows: both halves of
 * `cancelledPredicate` are inert without them, so every one of these offers
 * classifies as a genuine fill and reaches the priced set. That is the shape
 * that costs the most to serve, which is the one worth measuring.
 *
 * Set-based inserts rather than a loop — 8 000 round trips would measure the
 * client, not the query.
 */
async function seedRange(
  from: number,
  to: number,
  give: string,
  want: string,
): Promise<void> {
  if (to < from) return;
  await client.query(
    `INSERT INTO offer_file_history
       (id, celestia_height, transaction_hex, offer_hash, created_at,
        ttl_seconds, archive_reason, archived_at, first_seen_at)
     SELECT g, 100 + g, 'blob-' || g, lpad(to_hex(g), 64, '0'),
            NOW() - INTERVAL '1 hour', 3600, 'CONSUMED',
            NOW() - INTERVAL '30 minutes', NOW()
       FROM generate_series($1::int, $2::int) g`,
    [from, to],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history
       (offer_file_id, token_color, amount, direction, kind, archived_at)
     SELECT g, $3, '10', 'GIVING', 'SHIELDED', NOW() - INTERVAL '30 minutes'
       FROM generate_series($1::int, $2::int) g
     UNION ALL
     SELECT g, $4, '20', 'WANTING', 'SHIELDED', NOW() - INTERVAL '30 minutes'
       FROM generate_series($1::int, $2::int) g`,
    [from, to, give, want],
  );
}

/**
 * Run the product's OWN repair sweep to convergence — the same two queries
 * api.ts uses. The bench never hand-writes a verdict column: doing so would
 * measure a state the adjudicator cannot actually produce.
 */
async function adjudicateAll(): Promise<void> {
  for (;;) {
    const owed = await findUnadjudicatedFills.run({ limit: 20_000 }, client);
    if (owed.length === 0) return;
    for (const row of owed) await adjudicateOfferFill.run({ offer_id: row.id }, client);
  }
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function timed(label: string, fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  const ms = median(samples);
  console.log(`    ${label.padEnd(18)} ${ms.toFixed(1).padStart(8)} ms`);
  return ms;
}

const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

async function measure(): Promise<Record<string, number>> {
  return {
    stats: await timed("getPairStats24h", () =>
      getPairStats24h.run({ base: BASE, quote: QUOTE, cutoff }, client),
    ),
    history: await timed("getTradeHistory", () =>
      getTradeHistory.run({ base: BASE, quote: QUOTE }, client),
    ),
    pairs: await timed("getPairs", () => getPairs.run(undefined, client)),
  };
}

/**
 * The compiled statement, with its named params replaced by literals, so the
 * planner can be asked about the query the product actually runs rather than a
 * copy of it kept in this file that would drift.
 */
function explainable(query: unknown, values: Record<string, string>): string {
  const statement = (query as { queryIR: { statement: string } }).queryIR.statement;
  return statement.replace(
    /(?<![:A-Za-z0-9_]):([A-Za-z_][A-Za-z0-9_]*)!?/g,
    (whole, name: string) =>
      name in values ? `'${values[name]}'` : whole,
  );
}

await client.connect();
for (const migration of migrationTable) await client.query(migration.sql);

const results: { background: number; ms: Record<string, number> }[] = [];
let seeded = 0;
let tail: [number, number] | null = null;

try {
  // The measured pair's fills, seeded once and adjudicated once. Everything
  // after this is background on other pairs.
  await seedRange(1, MEASURED_FILLS, BASE, QUOTE);
  seeded = MEASURED_FILLS;

  for (const background of BACKGROUND) {
    // The unadjudicated tail is deleted and re-seeded at each size rather than
    // left to be adjudicated by the next sweep, so the measured pair's fill
    // count stays at exactly MEASURED_FILLS at every point on the curve.
    if (tail) {
      await client.query(
        `DELETE FROM offer_file_tokens_history WHERE offer_file_id BETWEEN $1 AND $2`,
        tail,
      );
      await client.query(
        `DELETE FROM offer_file_history WHERE id BETWEEN $1 AND $2`,
        tail,
      );
      seeded = tail[0] - 1;
    }
    const target = MEASURED_FILLS + background;
    // Background is ONE other pair, so /v1/pairs still returns two rows at
    // every size. Its cost therefore grows with fills-in-window rather than
    // with the number of pairs — the genuine O(fills) aggregation that route
    // owes, which this fixture must not be read as claiming to remove.
    await seedRange(seeded + 1, target, "1".repeat(64), "2".repeat(64));
    seeded = Math.max(seeded, target);
    await adjudicateAll();

    tail = [seeded + 1, seeded + UNADJUDICATED];
    await seedRange(tail[0], tail[1], BASE, QUOTE);
    seeded = tail[1];
    await client.query("ANALYZE");

    const owed = await findUnadjudicatedFills.run({ limit: 20_000 }, client);
    console.log(
      `\n  background ${background} · measured pair ${MEASURED_FILLS} fills · ` +
        `${owed.length} unadjudicated (${REPEATS} repeats, median)`,
    );
    results.push({ background, ms: await measure() });
  }

  const first = results[0];
  console.log(`\n  cost relative to background ${first!.background}:`);
  console.log(
    `    ${"background".padEnd(12)}` +
      Object.keys(first!.ms).map((k) => k.padStart(12)).join(""),
  );
  for (const r of results) {
    console.log(
      `    ${String(r.background).padEnd(12)}` +
        Object.keys(r.ms)
          .map((k) => `${(r.ms[k]! / first!.ms[k]!).toFixed(2)}x`.padStart(12))
          .join(""),
    );
  }
  console.log(
    `\n  O(missing) predicts a flat column; O(history) predicts one that tracks` +
      `\n  the background multiple (1x / 4x / 16x).`,
  );

  const plan = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS OFF, COSTS OFF, TIMING OFF, SUMMARY OFF) ` +
      explainable(getTradeHistory, { base: BASE, quote: QUOTE }),
  );
  console.log(`\n  getTradeHistory plan at background ${BACKGROUND.at(-1)}:`);
  for (const row of plan.rows) console.log(`    ${row["QUERY PLAN"]}`);
} finally {
  // PGlite's WASM backend can fault during shutdown after a long run; the
  // measurement is already printed by then, so a teardown fault must not be
  // mistaken for a failed benchmark.
  try {
    await client.end();
    await handle.close();
  } catch (err) {
    console.log(`\n  (teardown fault, measurement above stands: ${err})`);
  }
  process.exit(0);
}
