// Child-process body for ../stagenet-registry.test.ts (00050 FR-005, T5/T6).
// In a subdirectory so the strict backend typecheck (packages/node/*.ts) does
// not see its untyped `pg` import — like the *.test.ts files it serves.
//
// Runs in its own process because `@effectstream/midnight-contracts` resolves
// MIDNIGHT_NETWORK_ID once, at module load: the parent test process has already
// loaded it for `undeployed`. The parent sets MIDNIGHT_NETWORK_ID=stagenet,
// ENABLE_TOKEN_REGISTRY=true and TEST_PGLITE_PORT, then reads the one RESULT
// line this prints. Nothing here touches the network: the registry document is
// the vendored stagenet fixture, served through an injected fetch.
//
// Flow, on a fresh database with the real migrations:
//   1. the seeded state (Preprod colours + Preprod SNIGHT);
//   2. the stagenet registry import (runOptionalRegistryImport, as the image's
//      token-registry one-shot runs it);
//   3. the REAL apiRouter on fastify: GET /v1/midnight/config, then the
//      extra-token route POST /v1/known-tokens (what 00053 uses for its stk
//      tokens), a duplicate, and GET /v1/known-tokens.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env["TEST_PGLITE_PORT"]);
if (!Number.isInteger(port) || port <= 0) throw new Error("TEST_PGLITE_PORT is required");

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { migrationTable } = await import("@zswap-da/database");
const { runOptionalRegistryImport } = await import("../../database/import-token-registry.ts");
const { closeTestPglite } = await import("../../database/test-pglite.ts");
const { apiRouter } = await import("../api.ts");

type TokenRow = { name: string; token_color: string; kind: string; decimals: number };

const fixture: unknown = JSON.parse(
  readFileSync(join(here, "../../database/fixtures/mint-test-tokens.stagenet.json"), "utf8"),
);

const handle = await startPglite(port);
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await client.connect();
for (const migration of migrationTable) await client.query(migration.sql);

const tokens = async (): Promise<TokenRow[]> =>
  (await client.query("SELECT name, token_color, kind, decimals FROM known_tokens ORDER BY name")).rows as TokenRow[];

const seeded = await tokens();

const requestedUrls: string[] = [];
const outcome = await runOptionalRegistryImport(
  {
    baseUrl: "https://mint-test-tokens.pages.dev/",
    network: "stagenet",
    timeoutMs: 5_000,
    db: { host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" },
  },
  {
    fetchImpl: (async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as unknown as typeof fetch,
  },
);
const imported = await tokens();
const state = (await client.query(
  "SELECT DISTINCT network, registry_revision FROM canonical_token_registry_state",
)).rows;

const server = fastify();
await apiRouter(server, client);
await server.ready();
const config = (await server.inject({ method: "GET", url: "/v1/midnight/config" })).json();
const stkA = { color: "5a".repeat(32), name: "stkA", kind: "shielded", decimals: 6 };
const post = await server.inject({ method: "POST", url: "/v1/known-tokens", payload: stkA });
const duplicate = await server.inject({ method: "POST", url: "/v1/known-tokens", payload: stkA });
const listed = (await server.inject({ method: "GET", url: "/v1/known-tokens" })).json() as TokenRow[];

console.log(
  "RESULT " +
    JSON.stringify({
      networkId: config.networkId,
      seeded,
      outcome,
      requestedUrls,
      imported,
      state,
      post: { status: post.statusCode, body: post.json() },
      duplicate: { status: duplicate.statusCode },
      listed: listed.map((row) => ({ name: row.name, token_color: row.token_color })),
    }),
);

await server.close();
await closeTestPglite(handle, client);
process.exit(0);
