import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeTestPglite } from "../database/test-pglite.ts";

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
      `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, ttl_seconds, created_at, first_seen_at)
       VALUES ($1, $2, $3, $4, 3600, TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($5 || ' minutes')::interval, NOW())`,
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

// ── Reference prices (00005) ───────────────────────────────────────────────
//
// The same real router over the same real migrations, so the seeds under test
// are literally the ones a fresh deployment gets.

const WBTC = `e7${"5".repeat(62)}`;
const WETH = `fd${"a".repeat(62)}`;
const WSBTC8 = `b8${"8".repeat(62)}`;
const TESTA = `d1${"3".repeat(62)}`;
const OVERRIDDEN = `c0${"f".repeat(62)}`;

const COLOR_NIGHT = "0".repeat(64);
const COLOR_USDC = "1".repeat(64);
const COLOR_USDM = "003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73";

/** `GET /v1/prices` for a set of colours — `tokens` is required (Q-11). */
const pricesFor = (...colors: string[]) => getJson(`/v1/prices?tokens=${colors.join(",")}`);

const registerToken = (
  color: string,
  name: string,
  kind: "shielded" | "unshielded" = "shielded",
  decimals = 0,
  assetId: string | null = null,
) =>
  client.query(
    "INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES ($1,$2,$3,$4,$5)",
    [color, name, kind, decimals, assetId],
  );

describe("GET /v1/prices", () => {
  test("a fresh database already serves the seeded reference prices", async () => {
    const { status, body } = await pricesFor(COLOR_NIGHT, COLOR_USDC, COLOR_USDM);
    expect(status).toBe(200);
    expect(body.sponsor_discount).toBe(0.025);

    // Never ran here — every field null, and the shape is still present so a
    // client does not have to special-case a missing object.
    expect(body.feed).toEqual({
      provider: "coingecko",
      last_run_at: null,
      last_ok_at: null,
      last_error: null,
    });

    // ONLY the assets the requested tokens reference — bitcoin and ethereum
    // are seeded but nothing here points at them, so listing them would be
    // payload nobody asked for.
    const assets = new Map<string, any>(body.assets.map((a: any) => [a.asset_id, a]));
    expect([...assets.keys()].sort()).toEqual(["midnight-3", "usd-coin", "usdm-2"]);
    // The stablecoin is an observed price like the rest — not 1, and with a
    // provider timestamp of its own.
    expect(assets.get("usdm-2")).toMatchObject({
      price_usd: "1.001",
      source: "seed",
      provider_updated_at: "2026-09-02T22:40:50.000Z",
    });
    expect(assets.get("midnight-3").provider_updated_at).toBe("2026-09-02T20:26:20.000Z");

    // The three seeded tokens, priced PER BASE UNIT.
    const tokens = new Map<string, any>(body.tokens.map((t: any) => [t.name, t]));
    expect([...tokens.keys()].sort()).toEqual(["NIGHT", "USDC", "USDM"]);
    expect(tokens.get("NIGHT")).toMatchObject({
      asset_id: "midnight-3",
      decimals: 0,
      price_usd: "0.01918181",
      source: "seed",
    });
    // 6 decimals: the seeded usdm-2 price divided by 1e6, and this is the
    // number the sponsorship gate multiplies amounts by.
    expect(tokens.get("USDM")).toMatchObject({
      kind: "unshielded",
      decimals: 6,
      price_usd: "0.000001001",
      source: "seed",
    });
  });

  test("the endpoint is read-only — polling it writes no demo rows", async () => {
    await registerToken(TESTA, "TESTTOKENA");
    const before = await client.query("SELECT COUNT(*)::int AS n FROM token_prices");
    await pricesFor(TESTA);
    await pricesFor(TESTA);
    const after = await client.query("SELECT COUNT(*)::int AS n FROM token_prices");
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // …and an unpriced token is simply absent rather than invented.
    const { body } = await pricesFor(TESTA);
    expect(body.tokens.map((t: any) => t.name)).not.toContain("TESTTOKENA");
  });

  // ── `tokens` is required and bounded (Q-11) ──────────────────────────────

  test("only the requested colours come back, and unknown ones are silently absent", async () => {
    const unknown = `ab${"9".repeat(62)}`;
    const { status, body } = await pricesFor(COLOR_USDC, unknown);
    expect(status).toBe(200);
    // NIGHT and USDM are seeded and priced, but were not asked for.
    expect(body.tokens.map((t: any) => t.name)).toEqual(["USDC"]);
    // An unknown colour is an answer ("no reference price"), not a client
    // error: the batcher asks about whatever colours an offer's legs carry.
    expect(body.tokens.map((t: any) => t.token_color)).not.toContain(unknown);
    expect(body.assets.map((a: any) => a.asset_id)).toEqual(["usd-coin"]);
    // The two always-present fields survive a request that matched nothing.
    const { body: none } = await pricesFor(unknown);
    expect(none.tokens).toEqual([]);
    expect(none.assets).toEqual([]);
    expect(none.sponsor_discount).toBe(0.025);
    expect(none.feed.provider).toBe("coingecko");
  });

  test("a missing, empty or malformed `tokens` is 400 VALIDATION with a reason", async () => {
    const cases: [string, RegExp][] = [
      ["/v1/prices", /tokens is required/],
      ["/v1/prices?tokens=", /tokens is required/],
      ["/v1/prices?tokens=,,", /tokens is required/],
      [`/v1/prices?tokens=${COLOR_USDC},nothex`, /not a 64-hex token color/],
      [`/v1/prices?tokens=${"1".repeat(63)}`, /not a 64-hex token color/],
      [`/v1/prices?tokens=${"1".repeat(65)}`, /not a 64-hex token color/],
      // Two `tokens=` params arrive as an array, which is not a colour list.
      [`/v1/prices?tokens=${COLOR_USDC}&tokens=${COLOR_NIGHT}`, /single comma-separated string/],
    ];
    for (const [url, reason] of cases) {
      const { status, body } = await getJson(url);
      expect(status).toBe(400);
      expect(body.error).toBe("VALIDATION");
      expect(body.reason).toMatch(reason);
    }
  });

  test("more than 50 colours is refused; exactly 50 is served", async () => {
    const color = (i: number) => i.toString(16).padStart(2, "0") + "e".repeat(62);
    const fifty = Array.from({ length: 50 }, (_, i) => color(i));
    const { status: okStatus } = await getJson(`/v1/prices?tokens=${fifty.join(",")}`);
    expect(okStatus).toBe(200);

    const { status, body } = await getJson(`/v1/prices?tokens=${[...fifty, color(50)].join(",")}`);
    expect(status).toBe(400);
    expect(body.reason).toContain("at most 50 colors, got 51");
  });

  test("colours are normalised: upper case and duplicates are accepted", async () => {
    // GET /v1/quote already lower-cases from_token/to_token; two routes in one
    // API disagreeing about the case of the same 64 hex characters would be a
    // trap. Duplicates collapse rather than duplicating rows in the response.
    const { status, body } = await pricesFor(
      COLOR_USDM.toUpperCase(),
      COLOR_USDM,
      ` ${COLOR_USDM} `.replace(/ /g, ""),
    );
    expect(status).toBe(200);
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].token_color).toBe(COLOR_USDM);
  });

  test("feed status is reported once the service has run", async () => {
    await client.query(
      `INSERT INTO price_feed_status (id, provider, last_run_at, last_ok_at, last_error)
       VALUES (1, 'coingecko', TIMESTAMPTZ '2026-09-03 00:00:00+00', TIMESTAMPTZ '2026-09-03 00:00:00+00', NULL)`,
    );
    const { body } = await pricesFor(COLOR_NIGHT);
    expect(body.feed).toEqual({
      provider: "coingecko",
      last_run_at: "2026-09-03T00:00:00.000Z",
      last_ok_at: "2026-09-03T00:00:00.000Z",
      last_error: null,
    });
    await client.query("DELETE FROM price_feed_status");
  });
});

describe("GET /v1/quote — reference prices (SC-001)", () => {
  test("WBTC→WETH registered BY NAME quotes the real BTC/ETH ratio", async () => {
    // Neither colour is seeded — faucet colours change on every redeploy — so
    // this is the whole name-mapping path, end to end over HTTP.
    await registerToken(WBTC, "WBTC");
    await registerToken(WETH, "WETH");

    const { status, body } = await getJson(
      `/v1/quote?from_token=${WBTC}&to_token=${WETH}&from_amount=1000`,
    );
    expect(status).toBe(200);
    expect(body.market_rate).toBeCloseTo(77387 / 2393.28, 12);
    // Before this project preprod answered 0.2153 here, from colour hashes.
    expect(body.market_rate).toBeGreaterThan(32);
    expect(body.source).toBe("token-prices");
    expect(body.from_source).toBe("seed");
    expect(body.to_source).toBe("seed");
    expect(body.sponsor_discount).toBe(0.025);
    expect(typeof body.prices_updated_at).toBe("string");
    expect(body.from_usd).toBeCloseTo(1000 * 77387, 6);
    // The auto-suggested amount is the sponsorship threshold, so it is sponsored.
    expect(body.sponsored).toBe(true);
    expect(body.discount).toBeGreaterThanOrEqual(0.025);
  });

  test("an offer priced AT reference is reported as not sponsored", async () => {
    const atReference = Math.floor(1000 * (77387 / 2393.28));
    const { body } = await getJson(
      `/v1/quote?from_token=${WBTC}&to_token=${WETH}&from_amount=1000&to_amount=${atReference}`,
    );
    expect(body.sponsored).toBe(false);
    expect(body.discount).toBeLessThan(0.025);
  });

  test("decimals divide the per-coin price into a per-base-unit one", async () => {
    // Same asset as WBTC, eight decimals: one base unit is 1e-8 of a coin.
    await registerToken(WSBTC8, "WSBTC", "shielded", 8);
    const { body } = await getJson(
      `/v1/quote?from_token=${WSBTC8}&to_token=${WETH}&from_amount=100000000`,
    );
    // 1e8 base units = 1 coin = one bitcoin's worth.
    expect(body.from_usd).toBeCloseTo(77387, 6);
    expect(body.from_source).toBe("seed");

    const { body: prices } = await pricesFor(WSBTC8);
    const wsbtc = prices.tokens.find((t: any) => t.name === "WSBTC");
    expect(wsbtc).toMatchObject({ decimals: 8, price_usd: "0.00077387", source: "seed" });
  });

  test("a `feed` row replaces the seed and is reported as `feed`", async () => {
    await client.query(
      "UPDATE asset_prices SET price_usd = 80000, source = 'feed' WHERE asset_id = 'bitcoin'",
    );
    const { body } = await getJson(
      `/v1/quote?from_token=${WBTC}&to_token=${WETH}&from_amount=1000`,
    );
    expect(body.from_source).toBe("feed");
    expect(body.market_rate).toBeCloseTo(80000 / 2393.28, 12);
    await client.query(
      "UPDATE asset_prices SET price_usd = 77387, source = 'seed' WHERE asset_id = 'bitcoin'",
    );
  });

  test("a manual override beats the asset price and is labelled `manual`", async () => {
    await registerToken(OVERRIDDEN, "WSETH");
    await client.query(
      "INSERT INTO token_prices (token_color, price_usd, source) VALUES ($1, '5', 'manual')",
      [OVERRIDDEN],
    );
    const { body } = await getJson(
      `/v1/quote?from_token=${OVERRIDDEN}&to_token=${WETH}&from_amount=1000`,
    );
    expect(body.from_source).toBe("manual");
    expect(body.from_usd).toBeCloseTo(5000, 6);

    // …and the quote does not overwrite it.
    const row = await client.query("SELECT price_usd, source FROM token_prices WHERE token_color = $1", [
      OVERRIDDEN,
    ]);
    expect(row.rows[0]).toMatchObject({ price_usd: "5", source: "manual" });
  });

  test("a registered token with no mapping falls back once, and stays put", async () => {
    const { body } = await getJson(
      `/v1/quote?from_token=${TESTA}&to_token=${WETH}&from_amount=1000`,
    );
    expect(body.from_source).toBe("fallback");
    expect(body.to_source).toBe("seed");
    // One side is a demo price, so the pair has no honest age.
    expect(body.prices_updated_at).toBeTruthy();
    expect(body.source).toBe("token-prices"); // both colours ARE registered

    const first = await client.query(
      "SELECT price_usd, source FROM token_prices WHERE token_color = $1",
      [TESTA],
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].source).toBe("fallback");

    // A second quote reuses the row rather than writing another one.
    await getJson(`/v1/quote?from_token=${TESTA}&to_token=${WETH}&from_amount=2000`);
    const second = await client.query(
      "SELECT price_usd, source FROM token_prices WHERE token_color = $1",
      [TESTA],
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].price_usd).toBe(first.rows[0].price_usd);

    // Now that it has a row it appears in /v1/prices, labelled honestly.
    // Q-11 keeps this write deliberately: the demo price stays inspectable
    // and overridable in token_prices.
    const { body: prices } = await pricesFor(TESTA);
    expect(prices.tokens.find((t: any) => t.name === "TESTTOKENA")).toMatchObject({
      source: "fallback",
      asset_id: null,
    });
  });

  test("an unregistered colour is `demo-fallback` and prices_updated_at is null", async () => {
    const unknown = `9${"9".repeat(63)}`;
    const { body } = await getJson(
      `/v1/quote?from_token=${WBTC}&to_token=${unknown}&from_amount=1000`,
    );
    expect(body.source).toBe("demo-fallback");
    expect(body.from_source).toBe("seed");
    expect(body.to_source).toBe("demo-fallback");
    expect(body.prices_updated_at).toBeNull();

    const persisted = await client.query("SELECT 1 FROM token_prices WHERE token_color = $1", [
      unknown,
    ]);
    expect(persisted.rows).toHaveLength(0);
  });
});
