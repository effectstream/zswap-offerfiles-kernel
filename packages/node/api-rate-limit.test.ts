import { afterAll, beforeAll, expect, test } from "bun:test";

// The limiter's budget and exemptions come from env. A silent break here is
// invisible in normal use — the API keeps answering — so the wiring is pinned:
// the configured max must actually throttle, and a non-local allowlist entry
// must not exempt the caller.
//
// The limiter reads env when the router registers, so the vars are set only
// around that call and restored immediately: bun shares one process env across
// test files, and leaving them set throttles every other file's server.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const { apiRateLimitAllowList, apiRateLimitMax } = await import("./env.ts");

// Continues the every-other-port sequence the sibling test files use (…54347).
const PORT = 54349;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;
let server: any;
let parsedMax = 0;
let parsedAllowList: string[] = [];

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of migrationTable) await client.query(migration.sql);

  const priorMax = process.env["API_RATE_LIMIT_MAX"];
  const priorAllowList = process.env["API_RATE_LIMIT_ALLOWLIST"];
  process.env["API_RATE_LIMIT_MAX"] = "2";
  process.env["API_RATE_LIMIT_ALLOWLIST"] = " 10.0.0.1 , ";
  try {
    parsedMax = apiRateLimitMax();
    parsedAllowList = apiRateLimitAllowList();
    server = fastify();
    await apiRouter(server, client);
    await server.ready();
  } finally {
    if (priorMax === undefined) delete process.env["API_RATE_LIMIT_MAX"];
    else process.env["API_RATE_LIMIT_MAX"] = priorMax;
    if (priorAllowList === undefined) delete process.env["API_RATE_LIMIT_ALLOWLIST"];
    else process.env["API_RATE_LIMIT_ALLOWLIST"] = priorAllowList;
  }
});

afterAll(async () => {
  await server?.close();
  await client?.end();
  await handle?.close();
});

test("env parses the budget and trims/drops blanks in the allowlist", () => {
  expect(parsedMax).toBe(2);
  expect(parsedAllowList).toEqual(["10.0.0.1"]);
});

test("requests past the configured max are throttled with 429 RATE_LIMITED", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await server.inject({ method: "GET", url: "/v1/pairs" });
    codes.push(res.statusCode);
  }
  expect(codes.slice(0, 2)).toEqual([200, 200]);
  expect(codes[2]).toBe(429);

  const throttled = await server.inject({ method: "GET", url: "/v1/pairs" });
  expect(throttled.json().error).toBe("RATE_LIMITED");
});

test("health stays exempt from the budget once other routes are throttled", async () => {
  const res = await server.inject({ method: "GET", url: "/v1/health" });
  expect(res.statusCode).toBe(200);
});
