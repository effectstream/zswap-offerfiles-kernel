import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { closeTestPglite } from "./test-pglite.ts";

// The prune index for the 14-day root window: created by 000-init.sql on a
// fresh database, and by the startup ensure on one that synced before it.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, ensureKnownRootsIndexes, KNOWN_ROOTS_PRUNE_INDEX, pruneKnownRoots } =
  await import("@zswap-da/database");

async function freePortAtLeast10000(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
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
  throw new Error("could not allocate a free test port >= 10000");
}

let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const indexExists = async () =>
  (await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [KNOWN_ROOTS_PRUNE_INDEX])).rows.length === 1;

beforeAll(async () => {
  const port = await freePortAtLeast10000();
  handle = await startPglite(port);
  client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await client.connect();
});

afterAll(async () => {
  await closeTestPglite(handle, client);
});

test("before the schema exists the startup ensure is a no-op", async () => {
  await ensureKnownRootsIndexes(client);
  expect((await client.query(`SELECT to_regclass('known_roots') AS t`)).rows[0].t).toBeNull();
});

test("000-init.sql creates the index; the ensure restores it on a database that lacks it, idempotently", async () => {
  for (const migration of migrationTable) await client.query(migration.sql);
  expect(await indexExists()).toBe(true);

  // A database that synced before the index existed.
  await client.query(`DROP INDEX ${KNOWN_ROOTS_PRUNE_INDEX}`);
  expect(await indexExists()).toBe(false);
  await ensureKnownRootsIndexes(client);
  expect(await indexExists()).toBe(true);
  await ensureKnownRootsIndexes(client);
  expect(await indexExists()).toBe(true);
  const def = (await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [KNOWN_ROOTS_PRUNE_INDEX]))
    .rows[0].indexdef as string;
  expect(def).toContain("(last_seen_ms, height)");
});

test("with no planner statistics the per-block prune uses the index at 201,600 roots", async () => {
  // 14 days of 6 s blocks; never ANALYZEd, as on PGlite (no autovacuum).
  const t0 = 1_790_000_000_000;
  await client.query(
    `INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms)
     SELECT lpad(to_hex(g), 64, '0'), g, $1::bigint + g::bigint * 6000, $1::bigint + g::bigint * 6000
       FROM generate_series(1, 201600) g`,
    [t0],
  );
  const cutoff = String(t0 + 6000 * 2);
  const statement = (pruneKnownRoots as unknown as { queryIR: { statement: string } }).queryIR.statement
    .replace(/:cutoff_ms!?/g, cutoff);
  const plan = (await client.query(`EXPLAIN ${statement}`)).rows
    .map((r: Record<string, string>) => r["QUERY PLAN"])
    .join("\n");
  expect(plan).toContain(KNOWN_ROOTS_PRUNE_INDEX);
  expect(plan).not.toContain("Bitmap Index Scan on idx_known_roots_height");

  await pruneKnownRoots.run({ cutoff_ms: cutoff }, client);
  expect(Number((await client.query(`SELECT COUNT(*)::int AS n FROM known_roots`)).rows[0].n)).toBe(201_600 - 1);
});
