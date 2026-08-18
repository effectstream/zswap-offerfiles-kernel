import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { closeTestPglite } from "../database/test-pglite.ts";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
process.env["SOLVER_LEVELS_AUTH_KEYS"] = JSON.stringify({
  "solver-one": "solver-one-test-secret",
  "solver-two": "solver-two-test-secret",
});

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const { quoteWithPrices } = await import("./market-mock.ts");
const {
  interpolateQuote,
  parseLevelsVersion,
  SolverLevelsRegistry,
  solverLevels,
  validateLevels,
  validatePair,
} = await import("./solver-levels.ts");

const PORT = 54353;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;
let server: any;

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const LEVELS = [
  { input: "1000", output: "1000" },
  { input: "100000", output: "99000" },
];
const pair = (tokenIn = A, tokenOut = B, levels = LEVELS) => ({ tokenIn, tokenOut, levels });

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of migrationTable) await client.query(migration.sql);
  server = fastify();
  await apiRouter(server, client);
  await server.ready();
});

afterAll(async () => {
  try {
    await server?.close();
  } finally {
    await closeTestPglite(handle, client);
  }
});

beforeEach(() => {
  solverLevels.clear();
  delete process.env["SOLVER_LEVELS_QUOTE_ENABLED"];
});

const post = (body: unknown, token = "solver-one-test-secret") =>
  server.inject({
    method: "POST",
    url: "/v1/solver/levels",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

test("shared ladder validation and exact interpolation remain strict", () => {
  expect(validateLevels(LEVELS)).toBe(true);
  expect(validateLevels([{ input: "100", output: "1" }, { input: "100", output: "2" }])).toBe(false);
  expect(validateLevels([{ input: "1.5", output: "1" }])).toBe(false);
  expect(validateLevels([{ input: "01", output: "1" }])).toBe(false);
  expect(validateLevels([{ input: "1", output: ((1n << 256n)).toString() }])).toBe(false);
  expect(validatePair(pair())).toBe(true);
  expect(validatePair(pair(A, A))).toBe(false);
  expect(interpolateQuote(LEVELS, 999n)).toBeNull();
  expect(interpolateQuote(LEVELS, 1000n)).toBe(1000n);
});

test("versions are positive canonical decimal u64 strings", () => {
  expect(parseLevelsVersion("1")).toBe(1n);
  expect(parseLevelsVersion("18446744073709551615")).toBe((1n << 64n) - 1n);
  for (const invalid of [
    "0",
    "01",
    "-1",
    "1.0",
    1,
    "18446744073709551616",
    "9".repeat(100),
  ]) {
    expect(parseLevelsVersion(invalid)).toBeNull();
  }
});

test("registry keeps per-solver declarations and picks best output deterministically", () => {
  const registry = new SolverLevelsRegistry({ ttlMs: 60_000, maxSolvers: 2 });
  expect(registry.publish("z-solver", [pair()], 1n, 1_000).ok).toBe(true);
  expect(registry.publish("a-solver", [pair(A, B, [{ input: "1000", output: "1200" }])], 1n, 1_000).ok).toBe(true);
  expect(registry.quoteDetails(A, B, 1000n, 1_001)).toMatchObject({
    amountOut: 1200n,
    solverId: "a-solver",
    version: "1",
  });
  expect(registry.all(1_001).length).toBe(2);
  const snapshot = registry.all(1_001);
  snapshot[0].levels[0].output = "999999";
  expect(registry.quoteDetails(A, B, 1000n, 1_001)?.amountOut).toBe(1200n);
});

test("full declaration withdraws omitted pairs and rejects stale versions", () => {
  const registry = new SolverLevelsRegistry({ ttlMs: 60_000 });
  expect(registry.publish("s1", [pair(), pair(A, C)], 7n, 1_000)).toMatchObject({
    ok: true,
    accepted: 2,
  });
  expect(registry.publish("s1", [pair(A, C)], 8n, 2_000)).toMatchObject({
    ok: true,
    accepted: 1,
    withdrawn: 1,
  });
  expect(registry.quote(A, B, 1000n, 2_001)).toBeNull();
  expect(registry.publish("s1", [pair()], 8n, 3_000)).toMatchObject({
    ok: false,
    code: "STALE_VERSION",
  });
  expect(registry.publish("s1", [], 9n, 4_000)).toMatchObject({
    ok: true,
    accepted: 0,
    withdrawn: 1,
  });
  expect(registry.all(4_001)).toEqual([]);
});

test("get/quote eagerly discard stale pair payloads and solver identities are bounded", () => {
  const registry = new SolverLevelsRegistry({ ttlMs: 10, maxSolvers: 2 });
  registry.publish("s1", [pair()], 1n, 100);
  expect(registry.quote(A, B, 1000n, 111)).toBeNull();
  expect(registry.all(111)).toEqual([]);
  expect(registry.publish("s2", [pair()], 1n, 111).ok).toBe(true);
  expect(registry.publish("s3", [pair()], 1n, 111)).toMatchObject({
    ok: false,
    code: "REGISTRY_FULL",
  });
  expect(registry.solverCount).toBe(2);
});

test("publication is disabled when no credential is configured", async () => {
  const priorKeys = process.env["SOLVER_LEVELS_AUTH_KEYS"];
  const priorSecret = process.env["SOLVER_LEVELS_AUTH_SECRET"];
  delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
  delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
  try {
    const res = await post({ version: "1", pairs: [pair()] });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("LEVELS_DISABLED");
  } finally {
    if (priorKeys === undefined) delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
    else process.env["SOLVER_LEVELS_AUTH_KEYS"] = priorKeys;
    if (priorSecret === undefined) delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
    else process.env["SOLVER_LEVELS_AUTH_SECRET"] = priorSecret;
  }
});

test("single-secret authentication derives a stable identity and malformed config fails closed", async () => {
  const priorKeys = process.env["SOLVER_LEVELS_AUTH_KEYS"];
  const priorSecret = process.env["SOLVER_LEVELS_AUTH_SECRET"];
  delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
  process.env["SOLVER_LEVELS_AUTH_SECRET"] = "single-solver-test-secret";
  try {
    const accepted = await post(
      { version: "1", pairs: [pair()] },
      "single-solver-test-secret",
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().solverId).toMatch(/^solver-[0-9a-f]{32}$/);

    process.env["SOLVER_LEVELS_AUTH_SECRET"] = "contains whitespace";
    const disabled = await post({ version: "2", pairs: [] }, "contains whitespace");
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().error).toBe("LEVELS_DISABLED");
  } finally {
    if (priorKeys === undefined) delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
    else process.env["SOLVER_LEVELS_AUTH_KEYS"] = priorKeys;
    if (priorSecret === undefined) delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
    else process.env["SOLVER_LEVELS_AUTH_SECRET"] = priorSecret;
  }
});

test("authentication derives identity and refuses spoofed or bad credentials", async () => {
  const unauthorized = await post({ version: "1", pairs: [pair()] }, "not-the-secret");
  expect(unauthorized.statusCode).toBe(401);

  const spoof = await post({ solverId: "solver-two", version: "1", pairs: [pair()] });
  expect(spoof.statusCode).toBe(400);
  expect(spoof.json().reason).toContain("derived from authentication");

  const accepted = await post({ version: "1", pairs: [pair()] });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toMatchObject({ solverId: "solver-one", version: "1", accepted: 1 });
});

test("route enforces monotonic version and empty-pairs withdrawal", async () => {
  expect((await post({ version: "0", pairs: [pair()] })).statusCode).toBe(400);
  expect((await post({ version: "10", pairs: [pair(), pair(A, C)] })).statusCode).toBe(200);
  const stale = await post({ version: "9", pairs: [pair()] });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ error: "STALE_VERSION", lastVersion: "10" });
  const withdrawn = await post({ version: "11", pairs: [] });
  expect(withdrawn.statusCode).toBe(200);
  expect(withdrawn.json()).toMatchObject({ accepted: 0, withdrawn: 2 });
});

test("publication bounds every ladder amount to the quote u256 domain", async () => {
  const tooLarge = (1n << 256n).toString();
  const response = await post({
    version: "1",
    pairs: [pair(A, B, [{ input: "1", output: tooLarge }])],
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().reason).toContain("u256");
  expect(solverLevels.all(Date.now())).toEqual([]);

  const overlong = await post({
    version: "2",
    pairs: [pair(A, B, [{ input: "1", output: "9".repeat(79) }])],
  });
  expect(overlong.statusCode).toBe(400);
  expect(overlong.json().reason).toContain("u256");
});

test("solver quote precedence is explicit opt-in and preserves response fields", async () => {
  await post({ version: "1", pairs: [pair()] });
  const url = `/v1/quote?from_token=${A}&to_token=${B}&from_amount=1000`;

  const disabled = await server.inject({ method: "GET", url });
  expect(disabled.statusCode).toBe(200);
  expect(disabled.json().source).toBe("demo-fallback");

  process.env["SOLVER_LEVELS_QUOTE_ENABLED"] = "TRUE";
  const malformedOptIn = await server.inject({ method: "GET", url });
  expect(malformedOptIn.json().source).toBe("demo-fallback");

  process.env["SOLVER_LEVELS_QUOTE_ENABLED"] = "true";
  const enabled = await server.inject({ method: "GET", url });
  expect(enabled.statusCode).toBe(200);
  expect(enabled.json()).toMatchObject({
    source: "solver-levels",
    quote_semantics: "indicative",
    solver_id: "solver-one",
    levels_version: "1",
    suggested_to_amount: "1000",
  });
  for (const field of ["from_usd", "to_usd", "market_rate", "implied_rate", "discount", "sponsored"]) {
    expect(Object.hasOwn(enabled.json(), field)).toBe(true);
  }
});

test("quote amount grammar rejects signs, separators, exponents, leading zeroes and same-token pairs", async () => {
  for (const amount of ["-100", "+100", "1e3", "1_000", "1.5", "001", "", "0"]) {
    const res = await server.inject({
      method: "GET",
      url: `/v1/quote?from_token=${A}&to_token=${B}&from_amount=${encodeURIComponent(amount)}`,
    });
    expect(res.statusCode).toBe(400);
  }
  const same = await server.inject({
    method: "GET",
    url: `/v1/quote?from_token=${A}&to_token=${A}&from_amount=1`,
  });
  expect(same.statusCode).toBe(400);
});

test("fallback quote derives huge base-unit output with exact bigint arithmetic", async () => {
  const fromAmount = 2n ** 120n;
  const res = await server.inject({
    method: "GET",
    url: `/v1/quote?from_token=${A}&to_token=${B}&from_amount=${fromAmount}`,
  });
  expect(res.statusCode).toBe(200);
  // Unknown tokens are 1:1 and the 2.5% spread is exactly 975/1000.
  expect(res.json().suggested_to_amount).toBe((fromAmount * 975n / 1000n).toString());
});

test("token-price quote keeps decimal price ratios out of base-unit Number math", () => {
  const fromAmount = (1n << 200n) + 123n;
  const quoted = quoteWithPrices(A, B, fromAmount, 0.1, 0.2);
  expect(quoted.suggested_to_amount).toBe((fromAmount * 975n / 2000n).toString());
});
