import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const { interpolateQuote, solverLevels, validateLevels, validatePair } = await import(
  "./solver-levels.ts"
);

// Continues the every-other-port sequence the sibling test files use.
const PORT = 54353;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;
let server: any;

const A = "a".repeat(64);
const B = "b".repeat(64);
const LEVELS = [
  { input: "1000", output: "1000" },
  { input: "100000", output: "99000" },
];

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
  await server?.close();
  await client?.end();
  await handle?.close();
});

beforeEach(() => solverLevels.clear());

const post = (body: unknown) =>
  server.inject({ method: "POST", url: "/v1/solver/levels", payload: body });

// ── validation ───────────────────────────────────────────────────────────────

test("rungs must be strictly ascending in input", () => {
  expect(validateLevels(LEVELS)).toBe(true);
  expect(validateLevels([{ input: "100", output: "1" }, { input: "100", output: "2" }])).toBe(false);
  expect(validateLevels([{ input: "200", output: "1" }, { input: "100", output: "2" }])).toBe(false);
  expect(validateLevels([])).toBe(false);
});

test("amounts must be decimal integer strings", () => {
  expect(validateLevels([{ input: "1.5", output: "1" }])).toBe(false);
  expect(validateLevels([{ input: "-1", output: "1" }])).toBe(false);
  expect(validateLevels([{ input: 100 as unknown as string, output: "1" }])).toBe(false);
});

test("a pair needs two distinct 64-hex colors", () => {
  expect(validatePair({ tokenIn: A, tokenOut: B, levels: LEVELS })).toBe(true);
  expect(validatePair({ tokenIn: A, tokenOut: A, levels: LEVELS })).toBe(false);
  expect(validatePair({ tokenIn: "short", tokenOut: B, levels: LEVELS })).toBe(false);
});

test("sizes outside the ladder are refused rather than extrapolated", () => {
  expect(interpolateQuote(LEVELS, 999n)).toBeNull();
  expect(interpolateQuote(LEVELS, 100001n)).toBeNull();
  expect(interpolateQuote(LEVELS, 1000n)).toBe(1000n);
});

// ── registry ─────────────────────────────────────────────────────────────────

test("a ladder stops quoting once it goes stale", () => {
  const now = 1_000_000;
  solverLevels.publish("s1", [{ tokenIn: A, tokenOut: B, levels: LEVELS }], now);
  expect(solverLevels.quote(A, B, 1000n, now)).toBe(1000n);
  // A solver that stopped pushing has stopped standing behind its prices.
  expect(solverLevels.quote(A, B, 1000n, now + 61_000)).toBeNull();
  expect(solverLevels.all(now + 61_000)).toEqual([]);
});

test("a later push replaces the same pair", () => {
  const now = 1_000_000;
  solverLevels.publish("s1", [{ tokenIn: A, tokenOut: B, levels: LEVELS }], now);
  solverLevels.publish(
    "s1",
    [{ tokenIn: A, tokenOut: B, levels: [{ input: "1000", output: "1200" }] }],
    now + 1000,
  );
  expect(solverLevels.quote(A, B, 1000n, now + 1000)).toBe(1200n);
  expect(solverLevels.all(now + 1000).length).toBe(1);
});

test("ladders are directional — the reverse pair is not implied", () => {
  const now = 1_000_000;
  solverLevels.publish("s1", [{ tokenIn: A, tokenOut: B, levels: LEVELS }], now);
  expect(solverLevels.quote(B, A, 1000n, now)).toBeNull();
});

// ── routes ───────────────────────────────────────────────────────────────────

test("POST accepts a well-formed push", async () => {
  const res = await post({ solverId: "s1", pairs: [{ tokenIn: A, tokenOut: B, levels: LEVELS }] });
  expect(res.statusCode).toBe(200);
  expect(res.json().accepted).toBe(1);
});

test("POST rejects a push with no solverId", async () => {
  const res = await post({ pairs: [{ tokenIn: A, tokenOut: B, levels: LEVELS }] });
  expect(res.statusCode).toBe(400);
  expect(res.json().reason).toContain("solverId");
});

test("a malformed pair rejects the whole push, naming its index", async () => {
  const res = await post({
    solverId: "s1",
    pairs: [
      { tokenIn: A, tokenOut: B, levels: LEVELS },
      { tokenIn: A, tokenOut: B, levels: [{ input: "200", output: "1" }, { input: "100", output: "2" }] },
    ],
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().reason).toContain("pairs[1]");
  // Nothing applied — a partial push would describe a curve nobody published.
  expect(solverLevels.all(Date.now())).toEqual([]);
});

test("GET returns the ladders currently fresh enough to quote from", async () => {
  await post({ solverId: "s1", pairs: [{ tokenIn: A, tokenOut: B, levels: LEVELS }] });
  const res = await server.inject({ method: "GET", url: "/v1/solver/levels" });
  expect(res.statusCode).toBe(200);
  expect(res.json().levels.length).toBe(1);
  expect(res.json().levels[0].solverId).toBe("s1");
});

// ── quote precedence ─────────────────────────────────────────────────────────

test("a posted ladder backs the quote instead of the demo fallback", async () => {
  await post({ solverId: "s1", pairs: [{ tokenIn: A, tokenOut: B, levels: LEVELS }] });
  const res = await server.inject({
    method: "GET",
    url: `/v1/quote?from_token=${A}&to_token=${B}&from_amount=1000`,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.source).toBe("solver-levels");
  expect(body.suggested_to_amount).toBe("1000");
});

test("an unpriced pair still falls back, and says so", async () => {
  const res = await server.inject({
    method: "GET",
    url: `/v1/quote?from_token=${A}&to_token=${B}&from_amount=1000`,
  });
  expect(res.statusCode).toBe(200);
  // No ladder posted, and these colors are not in known_tokens.
  expect(res.json().source).toBe("demo-fallback");
});

test("a size outside the posted ladder falls back rather than extrapolating", async () => {
  await post({ solverId: "s1", pairs: [{ tokenIn: A, tokenOut: B, levels: LEVELS }] });
  const res = await server.inject({
    method: "GET",
    url: `/v1/quote?from_token=${A}&to_token=${B}&from_amount=999999999`,
  });
  expect(res.json().source).not.toBe("solver-levels");
});
