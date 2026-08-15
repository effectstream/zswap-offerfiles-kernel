import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeTestPglite } from "../database/test-pglite.ts";

// HTTP-level tests: the REAL apiRouter registered on a real fastify instance
// over in-memory PGlite with the real migrations — no route copies, no mocks.
// Covers item #14 (cursor pagination over HTTP, including the 400s) and the
// previously missing item #20 test (token-registry gate).
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
process.env["POST_COMMIT_EVENT_BRIDGE_ENABLED"] = "false";
delete process.env["ENABLE_TOKEN_REGISTRY"]; // default-off is part of the contract

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");

const PORT = 54339;
let handle: Awaited<ReturnType<typeof startPglite>>;
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
      `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
       VALUES ($1, $2, '10', 'GIVING', 'SHIELDED')`,
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
  } finally {
    await closeTestPglite(handle, client);
  }
});

const getJson = async (url: string) => {
  const res = await server.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

describe("GET /v1/offers — keyset pagination over HTTP", () => {
  test("first page returns {offers, next_cursor}; cursor chains to the end exactly once", async () => {
    const seen: string[] = [];
    let url = "/v1/offers?limit=3";
    for (;;) {
      const { status, body } = await getJson(url);
      expect(status).toBe(200);
      expect(Array.isArray(body.offers)).toBe(true);
      seen.push(...body.offers.map((o: any) => o.offerId));
      if (!body.nextCursor) {
        expect(body.offers.length).toBeLessThan(3);
        break;
      }
      expect(body.nextCursor).toBe(body.offers[body.offers.length - 1].offerId);
      url = `/v1/offers?limit=3&after_hash=${body.nextCursor}`;
    }
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  });

  test("offset is gone: the parameter is ignored, not honored", async () => {
    const a = await getJson("/v1/offers?limit=2");
    const b = await getJson("/v1/offers?limit=2&offset=4");
    expect(b.body.offers.map((o: any) => o.offerId)).toEqual(
      a.body.offers.map((o: any) => o.offerId),
    );
  });

  test("list rows are MIP-0006 payloads: offerId + computed, offerBech32 OMITTED", async () => {
    const { body } = await getJson("/v1/offers?limit=1");
    const offer = body.offers[0];
    expect(offer.version).toBe(1);
    expect(offer.offerId).toMatch(/^[0-9a-f]{64}$/);
    // The presence rule: at least one of offerId/offerBech32. Lists serve the
    // id — a 100-row page of 16–25 KB strings would be megabytes.
    expect(offer.offerBech32).toBeUndefined();
    expect(offer.computed.gives.length).toBe(1);
    expect(offer.computed.gives[0].type).toBe("SHIELDED"); // MIP TokenLeg.type
    expect(Array.isArray(offer.computed.inputNullifiers)).toBe(true);
    expect(offer.computed.status).toBe("live");
    expect(offer.blobChars).toBeGreaterThan(0);
  });

  test("detail response DOES carry offerBech32 (spec: MUST for single offer)", async () => {
    const { status, body } = await getJson(`/v1/offers/${hashOf(1)}`);
    expect(status).toBe(200);
    expect(body.version).toBe(1);
    expect(body.offerId).toBe(hashOf(1));
    expect(typeof body.offerBech32).toBe("string");
    expect(body.computed.status).toBe("live");
    expect(Array.isArray(body.computed.inputNullifiers)).toBe(true);
  });

  test("token filter composes with the cursor", async () => {
    const color = "a".repeat(64); // even ids
    const p1 = await getJson(`/v1/offers?limit=2&token=${color}`);
    expect(p1.body.offers.length).toBe(2);
    const p2 = await getJson(
      `/v1/offers?limit=2&token=${color}&after_hash=${p1.body.nextCursor}`,
    );
    const ids = [...p1.body.offers, ...p2.body.offers].map((o: any) => o.offerId);
    expect(new Set(ids).size).toBe(3); // ids 2,4,6
    expect(p2.body.nextCursor === null || p2.body.offers.length < 2).toBe(true);
  });

  test("no auth_* / maker-note / snake_case leakage in responses (spec removals + camelCase)", async () => {
    const { body } = await getJson(`/v1/offers/${hashOf(1)}`);
    const keys = Object.keys(body);
    expect(keys.some((k) => k.startsWith("auth_"))).toBe(false);
    expect(keys).not.toContain("metadata_maker_note");
    // MIP payloads are camelCase (A2) — no snake_case survivors.
    expect(keys.some((k) => k.includes("_"))).toBe(false);
    expect(Object.keys(body.computed).some((k) => k.includes("_"))).toBe(false);
  });

  test("old /api/* paths are gone (404) — proves a move, not a copy", async () => {
    for (const p of ["/api/zswaps", "/api/zswaps/" + "0".repeat(64), "/api/pairs"]) {
      const res = await server.inject({ method: "GET", url: p });
      expect(res.statusCode).toBe(404);
    }
  });

  test("GET /v1/health returns liveness", async () => {
    const { status, body } = await getJson("/v1/health");
    expect(status).toBe(200);
    expect(typeof body.status).toBe("string");
    expect(typeof body.synced).toBe("boolean");
  });

  test("malformed cursor → 400 INVALID_CURSOR", async () => {
    const { status, body } = await getJson("/v1/offers?after_hash=nonsense");
    expect(status).toBe(400);
    expect(body.error).toBe("INVALID_CURSOR");
  });

  test("well-formed but unknown cursor → 400 (never a silent first page)", async () => {
    const { status, body } = await getJson(`/v1/offers?after_hash=${"f".repeat(64)}`);
    expect(status).toBe(400);
    expect(body.error).toBe("INVALID_CURSOR");
  });
});

describe("POST /v1/known-tokens — registry gate (item #20)", () => {
  const payload = {
    color: "c".repeat(64),
    name: "GATETEST",
    kind: "shielded",
  };

  test("404 NOT_ENABLED when ENABLE_TOKEN_REGISTRY is unset", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/known-tokens",
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
        url: "/v1/known-tokens",
        payload,
      });
      expect(res.statusCode).toBe(200);
      const listed = await getJson("/v1/known-tokens");
      expect(listed.body.some((t: any) => t.name === "GATETEST")).toBe(true);
    } finally {
      delete process.env["ENABLE_TOKEN_REGISTRY"];
    }
  });

  test("gate closes again once the env var is removed", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/known-tokens",
      payload: { ...payload, name: "GATETEST2", color: "d".repeat(64) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/quote — unknown-token demo fallback", () => {
  test("unregistered colors quote 1:1 at $1 instead of erroring", async () => {
    // DEMO FALLBACK (see api.ts): there is no token-tracking story yet, so
    // unknown colors must not wall off the demo with UNKNOWN_TOKEN. Two
    // unknowns ⇒ equal $1 prices ⇒ 1:1. Loudly logged server-side; the $1
    // price must NOT be persisted (a later registration starts clean).
    const u1 = "7".repeat(64);
    const u2 = "8".repeat(64);
    const { status, body } = await getJson(
      `/v1/quote?from_token=${u1}&to_token=${u2}&from_amount=1000000`,
    );
    expect(status).toBe(200);
    expect(body.market_rate).toBe(1); // the 1:1 claim — equal $1 prices
    expect(body.from_usd).toBe(1000000); // fallback price is exactly $1
    // The standard market spread applies to fallback quotes like any other;
    // assert spread-agnostically rather than pinning its current value.
    const suggested = Number(body.suggested_to_amount);
    expect(suggested).toBeGreaterThan(900000);
    expect(suggested).toBeLessThanOrEqual(1000000);
    const persisted = await client.query(
      "SELECT 1 FROM token_prices WHERE token_color = ANY($1)",
      [[u1, u2]],
    );
    expect(persisted.rows.length).toBe(0);
  });

  test("malformed colors still answer 400", async () => {
    const { status } = await getJson("/v1/quote?from_token=zzz&to_token=abc&from_amount=1");
    expect(status).toBe(400);
  });
});
