import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { closeTestPglite } from "../database/test-pglite.ts";

const TRACKED_ENV = [
  "API_RATE_LIMIT_ALLOWLIST",
  "API_RATE_LIMIT_MAX",
  "DB_NAME",
  "DB_USER",
  "PGLITE_DATA_DIR",
  "SOLVER_LEVELS_AUTH_KEYS",
  "SOLVER_LEVELS_AUTH_SECRET",
  "SOLVER_LEVELS_QUOTE_ENABLED",
  "SOLVER_LEVELS_TTL_SECONDS",
  "SOLVER_LIQUIDITY_READ_AUTH_SECRET",
] as const;
const priorEnv = new Map(TRACKED_ENV.map((key) => [key, process.env[key]]));
const realDateNow = Date.now;

const SOLVER_ID = "offer-files-solver-fixture-01";
const READ_SECRET = "liquidity-read-secret-fixture-00001";
const WRITE_SECRET = "levels-write-secret-fixture-00001";
const T0 = Date.parse("2026-08-14T12:00:00.000Z");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const AB = {
  tokenIn: A,
  tokenOut: B,
  levels: [
    { input: "1000", output: "900" },
    { input: "2000", output: "1700" },
    { input: "4000", output: "3000" },
  ],
};
const BC = {
  tokenIn: B,
  tokenOut: C,
  levels: [
    { input: "1000", output: "2000" },
    { input: "2000", output: "3900" },
  ],
};

const liveFixture = JSON.parse(readFileSync(
  new URL(
    "../solver-core/fixtures/offer-files-data-lineage/v1/upstream-liquidity-200-live.json",
    import.meta.url,
  ),
  "utf8",
));
const withdrawnFixture = JSON.parse(readFileSync(
  new URL(
    "../solver-core/fixtures/offer-files-data-lineage/v1/upstream-liquidity-200-withdrawn.json",
    import.meta.url,
  ),
  "utf8",
));

process.env["DB_USER"] = "postgres";
process.env["DB_NAME"] = "postgres";
process.env["PGLITE_DATA_DIR"] = "memory://";
process.env["API_RATE_LIMIT_MAX"] = "10000";
process.env["API_RATE_LIMIT_ALLOWLIST"] = "127.0.0.1";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const {
  authenticateSolverLiquidityReadToken,
  solverLiquidityReadAuthSecret,
} = await import("./env.ts");
const { solverLevels } = await import("./solver-levels.ts");
const {
  isSolverLiquidityEnvelope,
  MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES,
} = await import("@zswap-da/solver-core/liquidity-contract");

let port = 0;
let apiPort = 0;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;
let server: any;

function configureValidAuth(): void {
  process.env["SOLVER_LIQUIDITY_READ_AUTH_SECRET"] = READ_SECRET;
  process.env["SOLVER_LEVELS_AUTH_KEYS"] = JSON.stringify({
    [SOLVER_ID]: WRITE_SECRET,
  });
  delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
}

function restoreTrackedEnv(): void {
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function findFreePort(min: number, max: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomInt(min, max + 1);
    const available = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(false));
      probe.listen({ host: "127.0.0.1", port: candidate, exclusive: true }, () => {
        probe.close((error) => resolve(error === undefined));
      });
    });
    if (available) return candidate;
  }
  throw new Error(`could not find a free test port in ${min}-${max}`);
}

const liquidityRequest = (
  url = `/v1/solver/liquidity?solver_id=${encodeURIComponent(SOLVER_ID)}`,
  token: string | null = READ_SECRET,
  overrides: Record<string, unknown> = {},
) => server.inject({
  method: "GET",
  url,
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
  ...overrides,
});

interface RawHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawLiquidityRequest(
  body: string,
  framing: "content-length" | "chunked",
  token: string | null = READ_SECRET,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      "content-type": "application/x-liquidity-body-test",
    };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (framing === "content-length") {
      headers["content-length"] = Buffer.byteLength(body, "utf8");
    } else {
      headers["transfer-encoding"] = "chunked";
    }
    const request = httpRequest({
      host: "127.0.0.1",
      port: apiPort,
      method: "GET",
      path: `/v1/solver/liquidity?solver_id=${encodeURIComponent(SOLVER_ID)}`,
      headers,
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: responseBody,
      }));
    });
    request.once("error", reject);
    if (framing === "chunked") {
      request.write(body.slice(0, 1));
      request.write(body.slice(1));
      request.end();
    } else {
      request.end(body);
    }
  });
}

async function atTime<T>(nowMs: number, operation: () => Promise<T>): Promise<T> {
  Date.now = () => nowMs;
  try {
    return await operation();
  } finally {
    Date.now = realDateNow;
  }
}

beforeAll(async () => {
  // Probe two disjoint ranges so every listener is verified free, distinct,
  // and above the workspace's shared-agent minimum before it is started.
  port = await findFreePort(20_000, 29_999);
  apiPort = await findFreePort(40_000, 49_999);
  handle = await startPglite(port);
  client = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of migrationTable) await client.query(migration.sql);
  server = fastify();
  await apiRouter(server, client);
  await server.ready();
  await server.listen({ host: "127.0.0.1", port: apiPort });
});

afterAll(async () => {
  Date.now = realDateNow;
  try {
    await server?.close();
  } finally {
    try {
      await closeTestPglite(handle, client);
    } finally {
      restoreTrackedEnv();
    }
  }
});

afterEach(() => {
  Date.now = realDateNow;
});

beforeEach(() => {
  solverLevels.clear();
  configureValidAuth();
  process.env["SOLVER_LEVELS_TTL_SECONDS"] = "60";
  delete process.env["SOLVER_LEVELS_QUOTE_ENABLED"];
});

test.serial("configuration and authentication fail closed before registry work or body parsing", async () => {
  const originalEnvelope = solverLevels.liquidityEnvelope.bind(solverLevels);
  let registryCalls = 0;
  Object.defineProperty(solverLevels, "liquidityEnvelope", {
    configurable: true,
    value: (...args: Parameters<typeof originalEnvelope>) => {
      registryCalls += 1;
      return originalEnvelope(...args);
    },
  });

  try {
    delete process.env["SOLVER_LIQUIDITY_READ_AUTH_SECRET"];
    let response = await liquidityRequest("/v1/solver/liquidity?unexpected=true", null);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("LIQUIDITY_DISABLED");
    expect(response.headers["cache-control"]).toBe("no-store");

    process.env["SOLVER_LIQUIDITY_READ_AUTH_SECRET"] = "too-short";
    response = await liquidityRequest();
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("LIQUIDITY_DISABLED");

    process.env["SOLVER_LIQUIDITY_READ_AUTH_SECRET"] = `${READ_SECRET} bad`;
    response = await liquidityRequest();
    expect(response.statusCode).toBe(503);

    process.env["SOLVER_LIQUIDITY_READ_AUTH_SECRET"] = WRITE_SECRET;
    response = await liquidityRequest(undefined, WRITE_SECRET);
    expect(response.statusCode).toBe(503);

    delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
    process.env["SOLVER_LEVELS_AUTH_SECRET"] = READ_SECRET;
    process.env["SOLVER_LIQUIDITY_READ_AUTH_SECRET"] = READ_SECRET;
    response = await liquidityRequest();
    expect(response.statusCode).toBe(503);

    configureValidAuth();
    process.env["SOLVER_LEVELS_AUTH_KEYS"] = "not-json";
    response = await liquidityRequest();
    expect(response.statusCode).toBe(503);

    configureValidAuth();
    response = await liquidityRequest(undefined, null, {
      headers: { "content-type": "text/plain" },
      payload: "x".repeat(2_048),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("UNAUTHORIZED");
    expect(response.headers["www-authenticate"]).toBe("Bearer");

    response = await liquidityRequest(undefined, "wrong-token");
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(registryCalls).toBe(0);

    expect(solverLiquidityReadAuthSecret()).toBe(READ_SECRET);
    expect(authenticateSolverLiquidityReadToken(READ_SECRET, READ_SECRET)).toBe(true);
    expect(authenticateSolverLiquidityReadToken("wrong-token", READ_SECRET)).toBe(false);
  } finally {
    delete (solverLevels as any).liquidityEnvelope;
  }
});

test.serial("strictly rejects missing, extra, repeated, invalid query values and every request body", async () => {
  for (const url of [
    "/v1/solver/liquidity",
    `/v1/solver/liquidity?solver_id=${SOLVER_ID}&extra=true`,
    `/v1/solver/liquidity?solver_id=${SOLVER_ID}&solver_id=${SOLVER_ID}`,
    "/v1/solver/liquidity?solver_id=bad%20identity",
    "/v1/solver/liquidity?Solver_id=offer-files-solver-fixture-01",
  ]) {
    const response = await liquidityRequest(url);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION");
    expect(response.headers["cache-control"]).toBe("no-store");
  }

  const withBody = await liquidityRequest(undefined, READ_SECRET, {
    headers: {
      authorization: `Bearer ${READ_SECRET}`,
      "content-type": "application/json",
    },
    payload: { unexpected: true },
  });
  expect(withBody.statusCode).toBe(400);
  expect(withBody.json().error).toBe("VALIDATION");
});

test.serial("real HTTP rejects Content-Length and chunked GET bodies in preParsing after auth", async () => {
  const originalEnvelope = solverLevels.liquidityEnvelope.bind(solverLevels);
  let registryCalls = 0;
  Object.defineProperty(solverLevels, "liquidityEnvelope", {
    configurable: true,
    value: (...args: Parameters<typeof originalEnvelope>) => {
      registryCalls += 1;
      return originalEnvelope(...args);
    },
  });
  try {
    for (const framing of ["content-length", "chunked"] as const) {
      const response = await rawLiquidityRequest('{"unexpected":true}', framing);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe("VALIDATION");
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    const unauthenticated = await rawLiquidityRequest("unauthenticated", "chunked", null);
    expect(unauthenticated.statusCode).toBe(401);
    expect(JSON.parse(unauthenticated.body).error).toBe("UNAUTHORIZED");
    expect(unauthenticated.headers["www-authenticate"]).toBe("Bearer");
    expect(registryCalls).toBe(0);
  } finally {
    delete (solverLevels as any).liquidityEnvelope;
  }
});

test.serial("serves the canonical live fixture with immutable source freshness and bounded no-store JSON", async () => {
  expect(solverLevels.publish(
    SOLVER_ID,
    [BC, AB],
    9_007_199_254_740_993n,
    T0,
  )).toMatchObject({ ok: true });

  const response = await atTime(T0 + 10_000, () => liquidityRequest());
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(liveFixture);
  expect(isSolverLiquidityEnvelope(response.json())).toBe(true);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["content-type"]).toStartWith("application/json");
  expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(
    MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES,
  );

  const later = await atTime(T0 + 20_000, () => liquidityRequest());
  expect(later.json().generatedAt).toBe("2026-08-14T12:00:20.000Z");
  expect(later.json().snapshots[0].updatedAt).toBe(liveFixture.snapshots[0].updatedAt);
  expect(later.json().snapshots[0].expiresAt).toBe(liveFixture.snapshots[0].expiresAt);
});

test.serial("serves the canonical explicit-withdrawal fixture", async () => {
  solverLevels.publish(SOLVER_ID, [AB], 9_007_199_254_740_993n, T0);
  expect(solverLevels.publish(
    SOLVER_ID,
    [],
    9_007_199_254_740_994n,
    T0 + 30_000,
  )).toMatchObject({ ok: true, accepted: 0, withdrawn: 1 });

  const response = await atTime(T0 + 40_000, () => liquidityRequest());
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(withdrawnFixture);
});

test.serial("distinguishes expired tombstones from unknown solver identities", async () => {
  solverLevels.publish(SOLVER_ID, [AB], 7n, T0);

  const expired = await atTime(T0 + 60_000, () => liquidityRequest());
  expect(expired.statusCode).toBe(200);
  expect(expired.json()).toEqual({
    schemaVersion: 1,
    source: "offer-files-solver",
    generatedAt: "2026-08-14T12:01:00.000Z",
    snapshots: [{
      solverId: SOLVER_ID,
      version: "7",
      updatedAt: "2026-08-14T12:00:00.000Z",
      expiresAt: "2026-08-14T12:01:00.000Z",
      pairs: [],
    }],
  });

  const unknown = await atTime(T0 + 61_000, () => liquidityRequest(
    "/v1/solver/liquidity?solver_id=never-published",
  ));
  expect(unknown.statusCode).toBe(200);
  expect(unknown.json()).toEqual({
    schemaVersion: 1,
    source: "offer-files-solver",
    generatedAt: "2026-08-14T12:01:01.000Z",
    snapshots: [],
  });
});

test.serial("fails closed instead of returning an oversized or noncanonical source response", async () => {
  Object.defineProperty(solverLevels, "liquidityEnvelope", {
    configurable: true,
    value: () => ({
      schemaVersion: 1,
      source: "offer-files-solver",
      generatedAt: "2026-08-14T12:00:10.000Z",
      snapshots: [],
      padding: "x".repeat(MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES),
    }),
  });
  try {
    const response = await liquidityRequest();
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("LIQUIDITY_UNAVAILABLE");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Buffer.byteLength(response.body, "utf8")).toBeLessThan(1_024);
  } finally {
    delete (solverLevels as any).liquidityEnvelope;
  }
});

test.serial("leaves legacy flattened levels and executable quote byte-shapes unchanged", async () => {
  solverLevels.publish(SOLVER_ID, [AB], 8n, T0);
  process.env["SOLVER_LEVELS_QUOTE_ENABLED"] = "true";
  const quoteUrl = `/v1/quote?from_token=${A}&to_token=${B}&from_amount=1000`;

  await atTime(T0 + 10_000, async () => {
    const levelsBefore = await server.inject({ method: "GET", url: "/v1/solver/levels" });
    const quoteBefore = await server.inject({ method: "GET", url: quoteUrl });
    const grouped = await liquidityRequest();
    const levelsAfter = await server.inject({ method: "GET", url: "/v1/solver/levels" });
    const quoteAfter = await server.inject({ method: "GET", url: quoteUrl });

    expect(grouped.statusCode).toBe(200);
    expect(levelsAfter.body).toBe(levelsBefore.body);
    expect(quoteAfter.body).toBe(quoteBefore.body);
    expect(Object.keys(levelsAfter.json())).toEqual(["levels"]);
    expect(Object.keys(levelsAfter.json().levels[0]).sort()).toEqual(
      ["levels", "solverId", "tokenIn", "tokenOut", "updatedAt", "version"].sort(),
    );
    expect(Object.keys(quoteAfter.json()).sort()).toEqual([
      "discount",
      "from_amount",
      "from_token",
      "from_usd",
      "implied_rate",
      "levels_version",
      "market_rate",
      "quote_semantics",
      "solver_id",
      "source",
      "sponsored",
      "suggested_to_amount",
      "to_amount",
      "to_token",
      "to_usd",
    ].sort());
  });
});
