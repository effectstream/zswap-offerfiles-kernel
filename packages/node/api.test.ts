import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// HTTP-level tests: the REAL apiRouter registered on a real fastify instance
// over in-memory PGlite with the real migrations — no route copies, no mocks.
// Covers item #14 (cursor pagination over HTTP, including the 400s) and the
// previously missing item #20 test (token-registry gate).
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
delete process.env["ENABLE_TOKEN_REGISTRY"]; // default-off is part of the contract

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");

const PORT = 54339;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;
let server: any;

const hashOf = (i: number) => i.toString(16).padStart(64, "0");

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of migrationTable) {
    await client.query(migration.sql);
  }
  // 7 offers, one shared created_at pair in the middle, one GIVING leg each.
  for (let i = 1; i <= 7; i++) {
    const minute = i === 4 ? 3 : i > 4 ? i - 1 : i; // ids 3 and 4 share a timestamp
    await client.query(
      `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, ttl_seconds, created_at)
       VALUES ($1, $2, $3, $4, 3600, TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($5 || ' minutes')::interval)`,
      [i, 100 + i, `blob-${i}`, hashOf(i), String(minute)],
    );
    await client.query(
      `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction)
       VALUES ($1, $2, '10', 'GIVING')`,
      [i, (i % 2 === 0 ? "a" : "b").repeat(64)],
    );
  }
  server = fastify();
  await apiRouter(server, client);
  await server.ready();
});

afterAll(async () => {
  try {
    await server?.close();
    await handle?.close();
  } catch { /* noop */ }
});

const getJson = async (url: string) => {
  const res = await server.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

describe("GET /api/zswaps — keyset pagination over HTTP", () => {
  test("first page returns {offers, next_cursor}; cursor chains to the end exactly once", async () => {
    const seen: string[] = [];
    let url = "/api/zswaps?limit=3";
    for (;;) {
      const { status, body } = await getJson(url);
      expect(status).toBe(200);
      expect(Array.isArray(body.offers)).toBe(true);
      seen.push(...body.offers.map((o: any) => o.offer_hash));
      if (!body.next_cursor) {
        expect(body.offers.length).toBeLessThan(3);
        break;
      }
      expect(body.next_cursor).toBe(body.offers[body.offers.length - 1].offer_hash);
      url = `/api/zswaps?limit=3&after_hash=${body.next_cursor}`;
    }
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  });

  test("offset is gone: the parameter is ignored, not honored", async () => {
    const a = await getJson("/api/zswaps?limit=2");
    const b = await getJson("/api/zswaps?limit=2&offset=4");
    expect(b.body.offers.map((o: any) => o.offer_hash)).toEqual(
      a.body.offers.map((o: any) => o.offer_hash),
    );
  });

  test("rows carry legs and no blob", async () => {
    const { body } = await getJson("/api/zswaps?limit=1");
    const offer = body.offers[0];
    expect(offer.gives.length).toBe(1);
    expect(offer.transaction_hex).toBeUndefined();
    expect(offer.blob_chars).toBeGreaterThan(0);
  });

  test("token filter composes with the cursor", async () => {
    const color = "a".repeat(64); // even ids
    const p1 = await getJson(`/api/zswaps?limit=2&token=${color}`);
    expect(p1.body.offers.length).toBe(2);
    const p2 = await getJson(
      `/api/zswaps?limit=2&token=${color}&after_hash=${p1.body.next_cursor}`,
    );
    const ids = [...p1.body.offers, ...p2.body.offers].map((o: any) => o.offer_hash);
    expect(new Set(ids).size).toBe(3); // ids 2,4,6
    expect(p2.body.next_cursor === null || p2.body.offers.length < 2).toBe(true);
  });

  test("malformed cursor → 400 INVALID_CURSOR", async () => {
    const { status, body } = await getJson("/api/zswaps?after_hash=nonsense");
    expect(status).toBe(400);
    expect(body.error).toBe("INVALID_CURSOR");
  });

  test("well-formed but unknown cursor → 400 (never a silent first page)", async () => {
    const { status, body } = await getJson(`/api/zswaps?after_hash=${"f".repeat(64)}`);
    expect(status).toBe(400);
    expect(body.error).toBe("INVALID_CURSOR");
  });
});

describe("POST /api/known-tokens — registry gate (item #20)", () => {
  const payload = {
    color: "c".repeat(64),
    name: "GATETEST",
    kind: "shielded",
  };

  test("404 NOT_ENABLED when ENABLE_TOKEN_REGISTRY is unset", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/known-tokens",
      payload,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("NOT_ENABLED");
  });

  test("200 when enabled, and the token is actually written", async () => {
    process.env["ENABLE_TOKEN_REGISTRY"] = "true";
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/known-tokens",
        payload,
      });
      expect(res.statusCode).toBe(200);
      const listed = await getJson("/api/known-tokens");
      expect(listed.body.some((t: any) => t.name === "GATETEST")).toBe(true);
    } finally {
      delete process.env["ENABLE_TOKEN_REGISTRY"];
    }
  });

  test("gate closes again once the env var is removed", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/known-tokens",
      payload: { ...payload, name: "GATETEST2", color: "d".repeat(64) },
    });
    expect(res.statusCode).toBe(404);
  });
});
