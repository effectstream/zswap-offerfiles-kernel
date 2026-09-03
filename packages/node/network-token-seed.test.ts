import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeTestPglite } from "../database/test-pglite.ts";

// The startup wiring, against a database that starts out EMPTY — the case
// api.test.ts cannot express, because it applies the migrations before it
// builds the router.
//
// A real node reaches the router before the schema exists: the runtime spawns
// the HTTP server, and 000-init.sql is applied inside the first block's
// transaction. So the first seed attempt legitimately fails with
// `undefined_table` and the helper has to wait for the schema rather than give
// up (or crash the node). That is what US-1 acceptance scenario 1 — "given an
// EMPTY database and MIDNIGHT_NETWORK_ID=preprod, when the node starts, the
// registry holds exactly one sNight row" — actually requires.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, SHIELDED_NIGHT_BY_NETWORK } = await import("@zswap-da/database");
const { startNetworkTokenSeed } = await import("./network-token-seed.ts");

const PORT = 54359;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const SNIGHT = SHIELDED_NIGHT_BY_NETWORK.get("preprod")!.color;

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
});

afterAll(async () => {
  await closeTestPglite(handle, client);
});

const settledYet = (p: Promise<void>) =>
  Promise.race([p.then(() => true), Promise.resolve().then(() => false)]);

test("on an empty database the seed waits for the schema, then registers sNight", async () => {
  const lines: string[] = [];
  const seed = startNetworkTokenSeed(client, "preprod", {
    intervalMs: 20,
    log: (line) => lines.push(line),
    warn: (line) => lines.push(`WARN ${line}`),
  });

  // known_tokens does not exist yet: nothing is logged, nothing throws, and
  // the helper has NOT settled — it is waiting, not failing.
  await new Promise((r) => setTimeout(r, 100));
  expect(lines).toEqual([]);
  expect(await settledYet(seed.settled)).toBe(false);

  // The first block applies the schema…
  for (const migration of migrationTable) {
    await client.query(migration.sql);
  }

  // …and the next attempt registers the row.
  await seed.settled;
  expect(lines).toEqual([`known_tokens: seeded SNIGHT ${SNIGHT} for preprod`]);
  const rows = await client.query(
    "SELECT token_color, name, kind, decimals, asset_id FROM known_tokens WHERE name = 'SNIGHT'",
  );
  expect(rows.rows).toEqual([
    {
      token_color: SNIGHT,
      name: "SNIGHT",
      kind: "shielded",
      decimals: 0, // NIGHT's seeded value
      asset_id: "midnight-3",
    },
  ]);
});

test("a database that never gets a schema is given up on, not retried forever", async () => {
  const lines: string[] = [];
  const dead = {
    query: async () => {
      const error: any = new Error('relation "known_tokens" does not exist');
      error.code = "42P01";
      throw error;
    },
  };
  const seed = startNetworkTokenSeed(dead as any, "preprod", {
    intervalMs: 1,
    maxAttempts: 3,
    log: (line) => lines.push(line),
    warn: (line) => lines.push(`WARN ${line}`),
  });
  await seed.settled; // resolves — a node must still serve without this row
  expect(lines).toEqual([
    "WARN known_tokens: gave up seeding SNIGHT for preprod after 3 attempts",
  ]);
});

test("stop() ends a pending retry and settles", async () => {
  const seed = startNetworkTokenSeed(
    {
      query: async () => {
        const error: any = new Error("nope");
        error.code = "42P01";
        throw error;
      },
    } as any,
    "preprod",
    { intervalMs: 10_000, log: () => {}, warn: () => {} },
  );
  await new Promise((r) => setTimeout(r, 20));
  seed.stop();
  await seed.settled;
});

test("a network with no deployed contract never touches the database", async () => {
  const lines: string[] = [];
  const seed = startNetworkTokenSeed(
    {
      query: async () => {
        throw new Error("the seed must not query at all here");
      },
    } as any,
    "undeployed",
    { log: (line) => lines.push(line), warn: (line) => lines.push(`WARN ${line}`) },
  );
  await seed.settled;
  expect(lines).toEqual([]);
});
