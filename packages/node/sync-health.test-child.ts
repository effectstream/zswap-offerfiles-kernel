// Child-process body for sync-health.functional.test.ts. The `.test-child.ts`
// name keeps it out of `bun test` collection, out of the kernel image and out
// of the strict backend typecheck (its untyped `pg` import, like the *.test.ts
// files it serves).
//
// Runs in its own process because the Midnight endpoints, CELESTIA_RPC_URL and
// the SYNC_HEALTH_* thresholds are read once, at module load. The parent
// points the endpoints at its stub indexer and stub Celestia RPC and sets
// TEST_PGLITE_PORT. The REAL apiRouter is registered on fastify over PGlite
// with the runtime and app migrations; the node is seeded at Midnight height
// 1000, Celestia height 2000 and NTP at its tip. Prints one RESULT line.

const port = Number(process.env["TEST_PGLITE_PORT"]);
if (!Number.isInteger(port) || port <= 0) throw new Error("TEST_PGLITE_PORT is required");

const { getMigrations } = await import("@effectstream/db/version");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { migrationTable } = await import("@zswap-da/database");
const { closeTestPglite } = await import("../database/pglite.test-support.ts");
const { apiRouter } = await import("./api.ts");

const NTP_HEIGHT = 42;
const NTP_BLOCK_MS = 60_000;

const handle = await startPglite(port);
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await client.connect();
for (const migration of await getMigrations()) await client.query(migration.sql);
for (const migration of migrationTable) await client.query(migration.sql);
const nowMs = Date.now();
await client.query(
  `INSERT INTO effectstream.sync_protocol_config_snapshot
     (protocol_name, network_type, immutable_config)
   VALUES ('ntp-validation', 'ntp', $1::jsonb)`,
  [JSON.stringify({ startTime: nowMs - NTP_HEIGHT * NTP_BLOCK_MS, blockTimeMS: NTP_BLOCK_MS })],
);
await client.query(
  `INSERT INTO effectstream.effectstream_blocks
     (block_height, ver, main_chain_block_hash, seed, ms_timestamp, effectstream_block_hash)
   VALUES ($1, 1, $2, 'sync-health-child', $3, $4)`,
  [NTP_HEIGHT, Buffer.from("01", "hex"), new Date(nowMs).toISOString(), Buffer.from("02", "hex")],
);
await client.query(
  `INSERT INTO effectstream.sync_protocol_pagination(protocol_name, page_number, page)
   VALUES ('parallelMidnight', 1000, '{}'::jsonb), ('parallelCelestia', 2000, '{}'::jsonb)`,
);

const server = fastify();
await apiRouter(server, client);
await server.ready();
const get = async (url: string) => {
  const res = await server.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.body };
};
const result = {
  health: await get("/v1/health"),
  healthSync: await get("/v1/health/sync"),
};
await server.close();
await closeTestPglite(handle, client);
console.log("RESULT " + JSON.stringify(result));
process.exit(0);
