import { describe, expect, test } from "bun:test";

import { PriceLookup, parsePricesBody, MAX_TOKENS_PER_REQUEST } from "./price-lookup.ts";
import { loadSponsorshipConfig } from "./config.ts";

// The batcher's only source of prices is the node, over HTTP, ONE request per
// offer for that offer's leg colours (Q-11). These tests drive the real
// PriceLookup with `fetch` replaced, because the behaviours that matter — "a
// cached colour is not re-asked", "a failed lookup serves a stale answer up to
// max age, then gives up" and "which colours the request actually named" — are
// invisible unless the clock and the transport are both controlled.

const WBTC = "aa".repeat(32);
const TESTA = "bb".repeat(32);

/** A minimal but SHAPE-ACCURATE GET /v1/prices body (master plan §3). */
const body = (overrides: Record<string, unknown> = {}) => ({
  sponsor_discount: 0.025,
  feed: { provider: "coingecko", last_run_at: null, last_ok_at: null, last_error: null },
  assets: [
    { asset_id: "bitcoin", price_usd: "77387", source: "feed", provider_updated_at: null, updated_at: "x" },
  ],
  tokens: [
    {
      token_color: "AA".repeat(32), // upper case on purpose — colours are compared lower-cased
      name: "WBTC",
      kind: "shielded",
      // 6 decimals (00024) — so the token price the node serves is the
      // asset's 77387 per COIN divided by 1e6, per BASE UNIT.
      decimals: 6,
      asset_id: "bitcoin",
      price_usd: "0.077387",
      source: "feed",
      updated_at: "x",
    },
    {
      token_color: TESTA,
      name: "TESTTOKENA",
      kind: "shielded",
      decimals: 6,
      asset_id: null,
      price_usd: "13.02",
      source: "fallback",
      updated_at: "x",
    },
  ],
  ...overrides,
});

const okResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Records the URL of every request the lookup makes. */
function lookupWith(
  respond: (url: string) => Response | Promise<Response>,
  now: () => number,
  options: { fallbackDiscount?: number; ttlMs?: number; maxAgeMs?: number } = {},
) {
  const logs: string[] = [];
  const errors: string[] = [];
  const urls: string[] = [];
  const lookup = new PriceLookup({
    url: "http://node.test:9999",
    ttlMs: options.ttlMs ?? 600_000,
    maxAgeMs: options.maxAgeMs ?? 172_800_000,
    fallbackDiscount: options.fallbackDiscount ?? 0.05,
    fetchImpl: (async (input: any) => {
      urls.push(String(input));
      return await respond(String(input));
    }) as unknown as typeof fetch,
    now,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  });
  return { lookup, logs, errors, urls };
}

/** The colours one recorded request asked about. */
const askedFor = (url: string): string[] =>
  (new URL(url).searchParams.get("tokens") ?? "").split(",").filter((c) => c !== "");

describe("PriceLookup — one GET /v1/prices?tokens= per offer", () => {
  test("a lookup asks for exactly the colours it was given, in one request", async () => {
    const c = clock();
    const { lookup, urls } = lookupWith(() => okResponse(body()), c.now);

    const result = await lookup.lookup([WBTC, TESTA]);

    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).pathname).toBe("/v1/prices");
    expect(askedFor(urls[0]!)).toEqual([WBTC, TESTA]);
    expect(result.requested).toBe(true);
    expect(result.unavailable).toEqual([]);
    // Colour keys are lower-cased so a differently-cased node answer still
    // matches the validator's legs.
    expect(result.prices.get(WBTC)).toEqual({ price_usd: "0.077387", source: "feed" });
    // A `fallback` row is CARRIED, not dropped: evaluateSponsorship reads it as
    // unpriced, and dropping it would be indistinguishable from "unknown token".
    expect(result.prices.get(TESTA)).toEqual({ price_usd: "13.02", source: "fallback" });
    expect(result.discount).toBe(0.025);
  });

  test("colours are lower-cased and deduplicated before being asked for", async () => {
    const c = clock();
    const { lookup, urls } = lookupWith(() => okResponse(body()), c.now);
    await lookup.lookup([WBTC.toUpperCase(), WBTC, WBTC.toUpperCase()]);
    expect(askedFor(urls[0]!)).toEqual([WBTC]);
  });

  test("the URL is the node base plus /v1/prices, with no double slash", () => {
    const { lookup } = lookupWith(() => okResponse(body()), () => 0);
    expect(lookup.pricesUrl).toBe("http://node.test:9999/v1/prices");
    const trailing = new PriceLookup({
      url: "http://node.test:9999/",
      ttlMs: 1,
      maxAgeMs: 1,
      fallbackDiscount: 0,
    });
    expect(trailing.pricesUrl).toBe("http://node.test:9999/v1/prices");
  });

  // ── the cache ────────────────────────────────────────────────────────────

  test("a colour answered within the TTL is NOT asked for again", async () => {
    const c = clock();
    const { lookup, urls } = lookupWith(() => okResponse(body()), c.now, { ttlMs: 600_000 });

    await lookup.lookup([WBTC, TESTA]);
    expect(urls).toHaveLength(1);

    // Same pair, a minute later: served entirely from the cache. This is what
    // makes a busy pair cost one request per TTL instead of one per offer.
    c.advance(60_000);
    const second = await lookup.lookup([WBTC, TESTA]);
    expect(urls).toHaveLength(1);
    expect(second.requested).toBe(false);
    expect(second.prices.get(WBTC)).toEqual({ price_usd: "0.077387", source: "feed" });
  });

  test("only the MISSING colours are asked for", async () => {
    const c = clock();
    const CC = "cc".repeat(32);
    const { lookup, urls } = lookupWith(
      () => okResponse(body({ tokens: [{ token_color: CC, price_usd: "9", source: "seed" }] })),
      c.now,
    );

    await lookup.lookup([WBTC, TESTA]);
    await lookup.lookup([WBTC, CC]);

    expect(urls).toHaveLength(2);
    // WBTC was already known, so the second request named only CC.
    expect(askedFor(urls[1]!)).toEqual([CC]);
  });

  test("a colour past the TTL is asked for again", async () => {
    const c = clock();
    const { lookup, urls } = lookupWith(() => okResponse(body()), c.now, { ttlMs: 600_000 });

    await lookup.lookup([WBTC]);
    c.advance(600_000);
    await lookup.lookup([WBTC]); // exactly at the boundary is still current
    expect(urls).toHaveLength(1);

    c.advance(1);
    await lookup.lookup([WBTC]);
    expect(urls).toHaveLength(2);
  });

  test("a colour the node does not price is CACHED as an answer, not re-asked", async () => {
    const c = clock();
    const UNKNOWN = "dd".repeat(32);
    const { lookup, urls } = lookupWith(() => okResponse(body({ tokens: [] })), c.now);

    const first = await lookup.lookup([UNKNOWN]);
    // Absent from `prices` — evaluateSponsorship reads that as unpriced — but
    // NOT unavailable: the node answered.
    expect(first.prices.size).toBe(0);
    expect(first.unavailable).toEqual([]);

    c.advance(1000);
    const second = await lookup.lookup([UNKNOWN]);
    expect(urls).toHaveLength(1);
    expect(second.requested).toBe(false);
    expect(second.unavailable).toEqual([]);
  });

  test("more than 50 colours are paged, because the node refuses a longer list", async () => {
    const c = clock();
    const colors = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(2, "0") + "e".repeat(62));
    const { lookup, urls } = lookupWith(() => okResponse(body({ tokens: [] })), c.now);

    await lookup.lookup(colors);

    expect(urls).toHaveLength(2);
    expect(askedFor(urls[0]!)).toHaveLength(MAX_TOKENS_PER_REQUEST);
    expect(askedFor(urls[1]!)).toHaveLength(1);
  });

  // ── failure ──────────────────────────────────────────────────────────────

  test("a failed lookup serves the cached answer while it is inside max age", async () => {
    const c = clock();
    let fail = false;
    const { lookup, errors } = lookupWith(
      () => {
        if (fail) throw new Error("connection refused");
        return okResponse(body());
      },
      c.now,
      { ttlMs: 600_000, maxAgeMs: 172_800_000 },
    );

    await lookup.lookup([WBTC]);
    fail = true;
    c.advance(700_000); // past the TTL, so it re-asks — and the re-ask fails

    const result = await lookup.lookup([WBTC]);
    expect(result.requested).toBe(true);
    // Stale but usable: the last thing the node said beats nothing at all.
    expect(result.unavailable).toEqual([]);
    expect(result.prices.get(WBTC)).toEqual({ price_usd: "0.077387", source: "feed" });
    expect(errors.at(-1)).toContain("price lookup failed");
  });

  test("past max age a failed lookup makes the colour UNAVAILABLE", async () => {
    const c = clock();
    let fail = false;
    const { lookup } = lookupWith(
      () => {
        if (fail) throw new Error("connection refused");
        return okResponse(body());
      },
      c.now,
      { ttlMs: 600_000, maxAgeMs: 3_600_000 },
    );

    await lookup.lookup([WBTC]);
    fail = true;
    c.advance(3_600_001);

    const result = await lookup.lookup([WBTC]);
    expect(result.unavailable).toEqual([WBTC]);
    expect(result.prices.size).toBe(0);
    expect(result.detail).toContain("failed");
    expect(result.detail).toContain("last good answer");
  });

  test("a colour never answered for is unavailable when the node is down", async () => {
    const c = clock();
    const { lookup } = lookupWith(() => {
      throw new Error("ECONNREFUSED");
    }, c.now);

    const result = await lookup.lookup([WBTC, TESTA]);
    expect(result.unavailable).toEqual([WBTC, TESTA]);
    expect(result.detail).toContain("has never answered");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  test("a non-200 is a failure, not an empty price table", async () => {
    const c = clock();
    let status = 200;
    const { lookup, errors } = lookupWith(
      () => (status === 200 ? okResponse(body()) : new Response("nope", { status })),
      c.now,
      { ttlMs: 1000, maxAgeMs: 3_600_000 },
    );
    await lookup.lookup([WBTC]);
    status = 503;
    c.advance(2000);
    const result = await lookup.lookup([WBTC]);
    // An empty map would read as "this token is unpriced" — the opposite of
    // what a 503 means. The cached answer stands instead.
    expect(result.prices.get(WBTC)).toEqual({ price_usd: "0.077387", source: "feed" });
    expect(errors.at(-1)).toContain("HTTP 503");
  });

  test("a malformed body is a failure too (no `tokens` array)", async () => {
    const { lookup, errors } = lookupWith(() => okResponse({ sponsor_discount: 0.025 }), () => 0);
    const result = await lookup.lookup([WBTC]);
    expect(result.unavailable).toEqual([WBTC]);
    expect(errors.at(-1)).toContain("tokens");
  });

  test("a failed page stops the lookup instead of multiplying the timeout", async () => {
    const c = clock();
    const colors = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(2, "0") + "e".repeat(62));
    const { lookup, urls } = lookupWith(() => {
      throw new Error("ECONNREFUSED");
    }, c.now);

    await lookup.lookup(colors);
    expect(urls).toHaveLength(1);
  });

  // ── the threshold ────────────────────────────────────────────────────────

  test("the env discount applies ONLY before the node has ever answered", async () => {
    const c = clock();
    let ok = false;
    const { lookup } = lookupWith(
      () => {
        if (!ok) throw new Error("node down");
        return okResponse(body());
      },
      c.now,
      { fallbackDiscount: 0.05, ttlMs: 1000, maxAgeMs: 3_600_000 },
    );

    // Node never answered → the SPONSOR_DISCOUNT_BPS bootstrap.
    expect((await lookup.lookup([WBTC])).discount).toBe(0.05);

    ok = true;
    c.advance(2000);
    expect((await lookup.lookup([WBTC])).discount).toBe(0.025); // the node's number wins

    // …and it keeps winning across later failures: the last thing the node
    // said is a better answer than this process's own env var.
    ok = false;
    c.advance(2000);
    expect((await lookup.lookup([WBTC])).discount).toBe(0.025);
  });

  test("sponsor_discount and feed are refreshed from EVERY response", async () => {
    const c = clock();
    let discount = 0.025;
    const { lookup } = lookupWith(
      () =>
        okResponse(
          body({
            sponsor_discount: discount,
            feed: { provider: "coingecko", last_run_at: "t1", last_ok_at: "t1", last_error: null },
          }),
        ),
      c.now,
      { ttlMs: 1000 },
    );

    await lookup.lookup([WBTC]);
    expect(lookup.discount()).toBe(0.025);
    expect(lookup.feedStatus()).toEqual({
      provider: "coingecko",
      last_run_at: "t1",
      last_ok_at: "t1",
      last_error: null,
    });

    discount = 0.05;
    c.advance(2000);
    await lookup.lookup([WBTC]);
    expect(lookup.discount()).toBe(0.05);
  });

  test("an out-of-range sponsor_discount from the node falls back rather than throwing", async () => {
    const { lookup } = lookupWith(() => okResponse(body({ sponsor_discount: 1.5 })), () => 0, {
      fallbackDiscount: 0.05,
    });
    await lookup.lookup([WBTC]);
    expect(lookup.discount()).toBe(0.05);
  });

  // ── the startup probe ────────────────────────────────────────────────────

  test("probe() makes exactly ONE request and never throws", async () => {
    const c = clock();
    const { lookup, urls } = lookupWith(() => okResponse(body({ tokens: [] })), c.now);
    expect(await lookup.probe()).toBe(true);
    expect(urls).toHaveLength(1);
    // NIGHT's colour: seeded on every network, so it is a probe and not a guess.
    expect(askedFor(urls[0]!)).toEqual(["0".repeat(64)]);
    expect(lookup.requestCount).toBe(1);
  });

  test("probe() against a node that is down reports false rather than throwing", async () => {
    const { lookup } = lookupWith(() => {
      throw new Error("ECONNREFUSED");
    }, () => 0);
    expect(await lookup.probe()).toBe(false);
  });

  test("describe() names the node and what an operator needs", async () => {
    const c = clock();
    const { lookup } = lookupWith(() => okResponse(body()), c.now, {
      ttlMs: 600_000,
      maxAgeMs: 172_800_000,
    });
    expect(lookup.describe()).toContain("prices=NONE");
    expect(lookup.describe()).toContain("not asked yet");
    await lookup.lookup([WBTC, TESTA]);
    c.advance(90_000);
    expect(lookup.describe()).toBe(
      "prices=2 color(s) cached, last answer 90s ago, ttl=600s max_age=172800s " +
        "discount=2.50% node=http://node.test:9999/v1/prices",
    );
  });
});

describe("parsePricesBody — what counts as a market price", () => {
  test("feed | seed | manual are priced; fallback is not", () => {
    const sources = ["feed", "seed", "manual", "fallback"];
    const parsed = parsePricesBody(
      body({
        tokens: sources.map((source, i) => ({
          token_color: String(i).repeat(64),
          price_usd: "1",
          source,
        })),
      }),
      0.05,
    );
    for (const [i, source] of sources.entries()) {
      expect(parsed.prices.get(String(i).repeat(64))!.source).toBe(source as any);
    }
    expect(parsed.downgraded).toBe(0);
  });

  test("an unknown source is downgraded to `fallback`, not trusted", () => {
    const parsed = parsePricesBody(
      body({ tokens: [{ token_color: "e".repeat(64), price_usd: "5", source: "oracle-v2" }] }),
      0.05,
    );
    // A newer node inventing a source must not make this batcher sponsor at a
    // price it cannot vouch for — it becomes "unpriced", and the unpriced
    // policy decides.
    expect(parsed.prices.get("e".repeat(64))).toEqual({ price_usd: "5", source: "fallback" });
    expect(parsed.downgraded).toBe(1);
  });

  test("a non-numeric price is downgraded, and a nameless entry is skipped", () => {
    const parsed = parsePricesBody(
      body({
        tokens: [
          { token_color: "d".repeat(64), price_usd: "not-a-number", source: "feed" },
          { price_usd: "1", source: "feed" },
          null,
        ],
      }),
      0.05,
    );
    expect(parsed.prices.get("d".repeat(64))!.source).toBe("fallback");
    expect(parsed.prices.size).toBe(1);
    expect(parsed.downgraded).toBe(3);
  });

  test("a body that is not the documented shape throws", () => {
    expect(() => parsePricesBody(null, 0.025)).toThrow("not an object");
    expect(() => parsePricesBody([], 0.025)).toThrow("not an object");
    expect(() => parsePricesBody({ tokens: "no" }, 0.025)).toThrow("tokens");
  });
});

describe("loadSponsorshipConfig — a typo must never become a silent default", () => {
  const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const cleared = {
    BATCHER_NODE_API_URL: undefined,
    BATCHER_PRICE_TTL_MS: undefined,
    BATCHER_PRICE_MAX_AGE_MS: undefined,
    BATCHER_SPONSOR_POLICY: undefined,
    BATCHER_SPONSOR_UNPRICED: undefined,
    SPONSOR_DISCOUNT_BPS: undefined,
  };

  test("the defaults are D7's rollout defaults", () => {
    const config = withEnv(cleared, loadSponsorshipConfig);
    expect(config).toEqual({
      nodeApiUrl: "http://127.0.0.1:9999",
      priceTtlMs: 600_000,
      priceMaxAgeMs: 172_800_000,
      policy: "warn",
      unpriced: "allow",
      fallbackDiscountBps: 250,
    });
  });

  test("values are read and case-normalised", () => {
    const config = withEnv(
      {
        ...cleared,
        BATCHER_NODE_API_URL: "http://kernel:9999",
        BATCHER_SPONSOR_POLICY: "ENFORCE",
        BATCHER_SPONSOR_UNPRICED: "Reject",
        BATCHER_PRICE_TTL_MS: "1000",
        BATCHER_PRICE_MAX_AGE_MS: "2000",
        SPONSOR_DISCOUNT_BPS: "500",
      },
      loadSponsorshipConfig,
    );
    expect(config.policy).toBe("enforce");
    expect(config.unpriced).toBe("reject");
    expect(config.nodeApiUrl).toBe("http://kernel:9999");
    expect(config.priceTtlMs).toBe(1000);
    expect(config.priceMaxAgeMs).toBe(2000);
    expect(config.fallbackDiscountBps).toBe(500);
  });

  test.each([
    ["BATCHER_SPONSOR_POLICY", "enfroce", "enforce | warn | off"],
    ["BATCHER_SPONSOR_UNPRICED", "deny", "allow | reject"],
    ["BATCHER_PRICE_TTL_MS", "soon", "positive number"],
    ["BATCHER_PRICE_MAX_AGE_MS", "0", "positive number"],
    ["BATCHER_NODE_API_URL", "kernel:9999", "absolute http(s) URL"],
    ["BATCHER_NODE_API_URL", "not a url", "absolute http(s) URL"],
    ["SPONSOR_DISCOUNT_BPS", "10000", "[0, 10000)"],
  ])("%s=%s throws at startup", (key, value, message) => {
    expect(() => withEnv({ ...cleared, [key]: value }, loadSponsorshipConfig)).toThrow(message);
  });

  test("a max age below the TTL is refused at startup, not discovered in an outage", () => {
    // Otherwise: "re-ask after 10 minutes, but refuse anything older than 5" —
    // every failed re-ask would strand a colour that has a perfectly recent
    // answer in hand.
    expect(() =>
      withEnv(
        { ...cleared, BATCHER_PRICE_TTL_MS: "600000", BATCHER_PRICE_MAX_AGE_MS: "300000" },
        loadSponsorshipConfig,
      ),
    ).toThrow("must be >= BATCHER_PRICE_TTL_MS");
  });

  test("BATCHER_PRICE_REFRESH_MS is gone: setting it changes nothing", () => {
    // The poll it configured no longer exists (Q-11). It is deliberately NOT
    // an error — an operator upgrading a compose file should not be blocked by
    // a leftover variable — but it must not silently keep working either.
    const config = withEnv(
      { ...cleared, BATCHER_PRICE_REFRESH_MS: "1234" },
      loadSponsorshipConfig,
    );
    expect(config.priceTtlMs).toBe(600_000);
    expect(config).not.toHaveProperty("priceRefreshMs");
  });
});
