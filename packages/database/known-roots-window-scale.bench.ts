/**
 * What the known_roots queries cost at a 14-day root window.
 *
 * WHY THIS FILE EXISTS. The root window went from 1 h to the ledger-9
 * `global_ttl`, 14 days (packages/node/network-windows.ts). At one root per
 * 6 s block, known_roots grows from ~600 rows to at most 201,600. Three queries
 * run against it on the hot path:
 *
 *   - isKnownRootLive     the ROOT_UNKNOWN gate (API submit, STM ingestion,
 *                         exact-files read), once per shielded input root;
 *   - pruneKnownRoots     once per Midnight block, in the midnight-zswap-root
 *                         transition, right after the new root's upsert;
 *   - getOfferRootTiming  the offer-deadline query, once per indexed offer.
 *
 * Each is timed at both volumes, each at its own window's steady state: the
 * prune deletes exactly the one root that aged out, as it does per block.
 * The acceptance rule (spec 00054 US3): p95 at 201,600 roots within 2x of p95
 * at 600, or an index is added. The EXPLAIN at the end shows which indexes the
 * planner uses (000-init.sql already indexes root, last_seen_ms and height).
 *
 * Not a test: it seeds ~200k rows and asserts nothing. Named `.bench.ts` so
 * `bun test packages` does not collect it. Run:
 *
 *   bun run packages/database/known-roots-window-scale.bench.ts
 */
import { createServer } from "node:net";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, isKnownRootLive, pruneKnownRoots, getOfferRootTiming } =
  await import("@zswap-da/database");
const { closeTestPglite } = await import("./test-pglite.ts");

const BLOCK_MS = 6_000;
const RUNS = 20;
const WARMUP = 3;
/** A live book of this many offers sits beside known_roots throughout. */
const LIVE_OFFERS = 2_000;
const VOLUMES = [
  { label: "1 h window (old default)", windowS: 3_600, roots: 600 },
  { label: "14 d window (global_ttl)", windowS: 1_209_600, roots: 201_600 },
] as const;

/** Shared box: a random free port >= 10000 (AGENTS.md). */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
      });
    });
    if (port >= 10_000) return port;
  }
}

const rootHex = (height: number) => height.toString(16).padStart(64, "0");

/** Deterministic PRNG, so both volumes probe comparable positions. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

type Stats = { p50: number; p95: number };
const stats = (xs: number[]): Stats => ({ p50: percentile(xs, 50), p95: percentile(xs, 95) });

function explainable(query: unknown, values: Record<string, string>): string {
  const statement = (query as { queryIR: { statement: string } }).queryIR.statement;
  return statement.replace(/(?<![:A-Za-z0-9_]):([A-Za-z_][A-Za-z0-9_]*)!?/g, (whole, name: string) =>
    name in values ? values[name]! : whole,
  );
}

const port = await freePort();
const handle = await startPglite(port);
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await client.connect();

type Row = { label: string; roots: number; analyzed: boolean; lookup: Stats; prune: Stats; deadline: Stats; pruned: number };
const rows: Row[] = [];
const plans: string[] = [];

try {
  for (const migration of migrationTable) await client.query(migration.sql);
  await client.query(
    `INSERT INTO offer_file
       (celestia_height, transaction_hex, offer_hash, metadata_created_at,
        metadata_expires_at, first_seen_at, ttl_seconds)
     SELECT 1000 + g, 'blob-' || g, lpad(to_hex(g), 64, '0'), NOW(),
            NOW() + INTERVAL '14 days', NOW(), 1209600
       FROM generate_series(1, $1::int) g`,
    [LIVE_OFFERS],
  );

  for (const analyzed of [false, true]) {
    for (const volume of VOLUMES) {
      const windowMs = volume.windowS * 1000;
      // Tip at height N, last seen at nowMs; one root per 6 s block before it.
      const t0 = 1_790_000_000_000;
      let nowMs = t0 + volume.roots * BLOCK_MS;
      let tip = volume.roots;
      await client.query("TRUNCATE known_roots");
      await client.query(
        `INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms)
         SELECT lpad(to_hex(g), 64, '0'), g, $1::bigint + g::bigint * $2::bigint, $1::bigint + g::bigint * $2::bigint
           FROM generate_series(1, $3::int) g`,
        [t0, BLOCK_MS, volume.roots],
      );
      if (analyzed) await client.query("ANALYZE known_roots");

      const rand = mulberry32(0x00054);
      /** A root strictly inside the window and below the tip. */
      const insideRoot = () => rootHex(Math.max(2, tip - 1 - Math.floor(rand() * (volume.roots - 2))));

      const lookup: number[] = [];
      const deadline: number[] = [];
      const prune: number[] = [];
      let pruned = 0;
      for (let i = 0; i < WARMUP + RUNS; i++) {
        const cutoff = nowMs - windowMs;

        let t = performance.now();
        const live = await isKnownRootLive.run({ root: insideRoot(), cutoff_ms: cutoff }, client);
        const lookupMs = performance.now() - t;
        if (live.length !== 1) throw new Error("an in-window root was not live");

        t = performance.now();
        await getOfferRootTiming.run({ roots: [insideRoot(), insideRoot()], block_ms: nowMs }, client);
        const deadlineMs = performance.now() - t;

        // One block later: the new root is upserted (untimed), then pruned to
        // the window — exactly the midnight-zswap-root transition's order.
        nowMs += BLOCK_MS;
        tip += 1;
        await client.query(
          `INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms) VALUES ($1, $2, $3, $3)`,
          [rootHex(tip), tip, nowMs],
        );
        t = performance.now();
        await pruneKnownRoots.run({ cutoff_ms: nowMs - windowMs }, client);
        const pruneMs = performance.now() - t;

        if (i >= WARMUP) {
          lookup.push(lookupMs);
          deadline.push(deadlineMs);
          prune.push(pruneMs);
        }
      }
      // Steady state, checked once outside the timed loop (a COUNT(*) per run
      // scans the whole table and evicts the index pages the next lookup
      // needs): every block adds one root and prunes the one that aged out, so
      // the window holds `roots` rows plus the new tip.
      const count = Number((await client.query("SELECT COUNT(*)::int AS n FROM known_roots")).rows[0].n);
      if (count !== volume.roots + 1) throw new Error(`known_roots holds ${count} rows, expected ${volume.roots + 1}`);
      const oldest = Number((await client.query("SELECT MIN(height)::int AS h FROM known_roots")).rows[0].h);
      // Warm-up block i deletes height i (none for i = 0), so the timed runs
      // delete heights WARMUP..WARMUP+RUNS-1: one root per block.
      pruned = oldest - WARMUP;
      rows.push({ label: volume.label, roots: volume.roots, analyzed, lookup: stats(lookup), prune: stats(prune), deadline: stats(deadline), pruned });

      if (volume.roots === 201_600) {
        const cutoff = String(nowMs - windowMs);
        for (const [name, q, values] of [
          ["isKnownRootLive", isKnownRootLive, { root: `'${rootHex(tip - 100_000)}'`, cutoff_ms: cutoff }],
          ["pruneKnownRoots", pruneKnownRoots, { cutoff_ms: cutoff }],
          ["getOfferRootTiming", getOfferRootTiming, { roots: `ARRAY['${rootHex(tip - 5)}','${rootHex(tip - 90_000)}']`, block_ms: String(nowMs) }],
        ] as const) {
          const sql = explainable(q, values as Record<string, string>);
          const plan = (await client.query(`EXPLAIN ${sql}`)).rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
          plans.push(`-- ${name} @ 201,600 roots, ${analyzed ? "after ANALYZE" : "no ANALYZE"}\n${plan}`);
        }
      }
    }
  }
} finally {
  await closeTestPglite(handle, client);
}

const f = (s: Stats) => `${s.p50.toFixed(3).padStart(7)} / ${s.p95.toFixed(3).padStart(7)}`;
console.log(`known_roots scale, ${RUNS} runs after ${WARMUP} warm-up, ${LIVE_OFFERS} live offers (ms, p50 / p95)`);
console.log(`${"volume".padEnd(26)} ${"ANALYZE".padEnd(8)} ${"lookup".padStart(17)} ${"prune".padStart(17)} ${"deadline".padStart(17)}  pruned in timed runs`);
for (const r of rows) {
  console.log(`${r.label.padEnd(26)} ${String(r.analyzed).padEnd(8)} ${f(r.lookup)} ${f(r.prune)} ${f(r.deadline)}  ${r.pruned}`);
}
for (const analyzed of [false, true]) {
  const [small, large] = [rows.find((r) => r.roots === 600 && r.analyzed === analyzed)!, rows.find((r) => r.roots === 201_600 && r.analyzed === analyzed)!];
  const ratio = (k: "lookup" | "prune" | "deadline") => (large[k].p95 / small[k].p95).toFixed(2);
  console.log(`p95 ratio 201,600 / 600 (${analyzed ? "after ANALYZE" : "no ANALYZE"}): lookup ${ratio("lookup")}x, prune ${ratio("prune")}x, deadline ${ratio("deadline")}x`);
}
console.log("\n" + plans.join("\n\n"));
console.log(JSON.stringify({ rows }));
