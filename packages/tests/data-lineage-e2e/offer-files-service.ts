/**
 * L5-only Offer Files process harness.
 *
 * This starts the production apiRouter over a real PGlite PostgreSQL wire
 * connection. The black-box driver talks only to the production HTTP routes;
 * this file adds no substitute liquidity endpoint or in-process test seam.
 */

import { randomInt } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { closeTestPglite } from "../../database/test-pglite.ts";

const HTTP_PORT = Number(process.env["LINEAGE_OFFER_FILES_PORT"] ?? "8080");
if (!Number.isSafeInteger(HTTP_PORT) || HTTP_PORT <= 0 || HTTP_PORT > 65_535) {
  throw new Error("LINEAGE_OFFER_FILES_PORT must be a valid TCP port");
}

process.env["DB_USER"] = "postgres";
process.env["DB_NAME"] = "postgres";
process.env["PGLITE_DATA_DIR"] = "memory://";
process.env["API_RATE_LIMIT_MAX"] = "10000";
process.env["API_RATE_LIMIT_ALLOWLIST"] = "127.0.0.1";

async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = randomInt(10_000, 60_000);
    if (candidate === HTTP_PORT) continue;
    const free = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(false));
      probe.listen({ host: "127.0.0.1", port: candidate, exclusive: true }, () => {
        probe.close((error) => resolve(error === undefined));
      });
    });
    if (free) return candidate;
  }
  throw new Error("could not find a verified-free PGlite port at or above 10000");
}

const nodePackageRoot = fileURLToPath(new URL("../../node/", import.meta.url));
const resolveNodeDependency = (specifier: string): string =>
  Bun.resolveSync(specifier, nodePackageRoot);

const [{ startPglite }, pgModule, databaseModule, fastifyModule, apiModule] =
  await Promise.all([
    import(resolveNodeDependency("@effectstream/db/start-pglite")),
    import(resolveNodeDependency("pg")),
    import("../../database/mod.ts"),
    import(resolveNodeDependency("fastify")),
    import("../../node/api.ts"),
  ]);

const pg = pgModule.default;
const fastify = fastifyModule.default;
const pglitePort = await findFreePort();
const pglite = await startPglite(pglitePort);
const database = new pg.Client({
  host: "127.0.0.1",
  port: pglitePort,
  user: "postgres",
  database: "postgres",
});
await database.connect();
for (const migration of databaseModule.migrationTable) {
  await database.query(migration.sql);
}

const server = fastify({ logger: false });
await apiModule.apiRouter(server, database);
await server.listen({ host: "0.0.0.0", port: HTTP_PORT });

let shuttingDown = false;
async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const errors: unknown[] = [];
  try {
    await server.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeTestPglite(pglite, database);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    console.error(new AggregateError(errors, "Offer Files L5 harness teardown failed"));
    process.exitCode = 1;
  } else {
    process.exitCode = exitCode;
  }
}

process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));

console.log(JSON.stringify({
  event: "lineage-offer-files-ready",
  httpPort: HTTP_PORT,
  pglitePort,
}));
