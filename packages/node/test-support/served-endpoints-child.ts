// Child-process body for ../served-endpoints-redaction.test.ts. In a
// subdirectory so the strict backend typecheck (packages/node/*.ts) does not
// see its untyped `pg` import — like the *.test.ts files it serves.
//
// Runs in its own process because `@effectstream/midnight-contracts` resolves
// the endpoints once, at module load: the parent sets token-bearing
// MIDNIGHT_INDEXER_HTTP / _WS / MIDNIGHT_NODE_HTTP overrides and
// TEST_PGLITE_PORT, then reads the one RESULT line this prints. The REAL
// apiRouter is registered on fastify over PGlite with the real migrations;
// nothing touches the network (the sync tip probes fail fast on loopback).

const port = Number(process.env["TEST_PGLITE_PORT"]);
if (!Number.isInteger(port) || port <= 0) throw new Error("TEST_PGLITE_PORT is required");

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { migrationTable } = await import("@zswap-da/database");
const { closeTestPglite } = await import("../../database/test-pglite.ts");
const { apiRouter } = await import("../api.ts");

const handle = await startPglite(port);
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await client.connect();
for (const migration of migrationTable) await client.query(migration.sql);

const server = fastify();
await apiRouter(server, client);
await server.ready();
const get = async (url: string) => {
  const res = await server.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.body };
};
const result = {
  config: await get("/v1/midnight/config"),
  health: await get("/v1/health"),
  healthSync: await get("/v1/health/sync"),
};
await server.close();
await closeTestPglite(handle, client);
console.log("RESULT " + JSON.stringify(result));
process.exit(0);
