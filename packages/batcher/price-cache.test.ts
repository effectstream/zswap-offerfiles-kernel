import { describe, expect, test } from "bun:test";

import { PriceCache, parsePricesBody } from "./price-cache.ts";
import { loadSponsorshipConfig } from "./config.ts";

// The batcher's only source of prices is the node, over HTTP. These tests
// drive the real PriceCache with `fetch` replaced, because the two behaviours
// that matter — "a failed refresh keeps the last good answer" and "an answer
// eventually goes stale" — are invisible unless the clock and the transport
// are both controlled.

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
      decimals: 0,
      asset_id: "bitcoin",
      price_usd: "77387",
      source: "feed",
      updated_at: "x",
    },
    {
      token_color: "bb".repeat(32),
      name: "TESTTOKENA",
      kind: "shielded",
      decimals: 0,
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

function cacheWith(fetchImpl: typeof fetch, now: () => number, fallbackDiscount = 0.05) {
  const logs: string[] = [];
  const errors: string[] = [];
  const cache = new PriceCache({
    url: "http://node.test:9999",
    refreshMs: 600_000,
    fallbackDiscount,
    fetchImpl,
    now,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  });
  return { cache, logs, errors };
}

describe("PriceCache — polling GET /v1/prices", () => {
  test("the first successful fetch populates the snapshot", async () => {
    const c = clock();
    const { cache } = cacheWith(async () => okResponse(body()), c.now);

    expect(cache.snapshot()).toBeNull();
    expect(cache.ageMs()).toBeNull();

    expect(await cache.refresh()).toBe(true);

    const snap = cache.snapshot()!;
    expect(snap.fetchedAt).toBe(c.now());
    expect(snap.sponsorDiscount).toBe(0.025);
    // Colour keys are lower-cased so a differently-cased node answer still matches
    // the validator's legs.
    expect(snap.prices.get("aa".repeat(32))).toEqual({ price_usd: "77387", source: "feed" });
    // A `fallback` row is CARRIED, not dropped: evaluateSponsorship reads it as
    // unpriced, and dropping it would be indistinguishable from "unknown token".
    expect(snap.prices.get("bb".repeat(32))).toEqual({ price_usd: "13.02", source: "fallback" });
  });

  test("the URL is the node base plus /v1/prices, with no double slash", () => {
    const { cache } = cacheWith(async () => okResponse(body()), () => 0);
    expect(cache.pricesUrl).toBe("http://node.test:9999/v1/prices");
    const trailing = new PriceCache({ url: "http://node.test:9999/", refreshMs: 1, fallbackDiscount: 0 });
    expect(trailing.pricesUrl).toBe("http://node.test:9999/v1/prices");
  });

  test("a refresh REPLACES the snapshot — removed tokens really disappear", async () => {
    const c = clock();
    let payload: unknown = body();
    const { cache } = cacheWith(async () => okResponse(payload), c.now);

    await cache.refresh();
    expect(cache.snapshot()!.prices.size).toBe(2);

    c.advance(600_000);
    payload = body({
      sponsor_discount: 0.05,
      tokens: [
        { token_color: "cc".repeat(32), price_usd: "1", source: "manual", name: "X", kind: "shielded", decimals: 0, asset_id: null, updated_at: "x" },
      ],
    });
    await cache.refresh();

    const snap = cache.snapshot()!;
    expect(snap.prices.size).toBe(1);
    expect(snap.prices.has("aa".repeat(32))).toBe(false);
    expect(snap.sponsorDiscount).toBe(0.05);
    expect(snap.fetchedAt).toBe(c.now());
  });

  test("a failed refresh keeps the old snapshot and does NOT move fetchedAt", async () => {
    const c = clock();
    let fail = false;
    const { cache, errors } = cacheWith(async () => {
      if (fail) throw new Error("connection refused");
      return okResponse(body());
    }, c.now);

    await cache.refresh();
    const first = cache.snapshot()!;

    fail = true;
    c.advance(600_000);
    expect(await cache.refresh()).toBe(false);

    // Same object contents, same timestamp: the snapshot AGES rather than
    // being refreshed-by-failure. That is what lets isFresh() ever be false.
    expect(cache.snapshot()!.fetchedAt).toBe(first.fetchedAt);
    expect(cache.snapshot()!.prices.size).toBe(first.prices.size);
    expect(cache.ageMs()).toBe(600_000);
    expect(errors.at(-1)).toContain("price refresh failed");
    expect(errors.at(-1)).toContain("keeping the snapshot from");
  });

  test("a non-200 is a failure, not an empty price table", async () => {
    const c = clock();
    let status = 200;
    const { cache, errors } = cacheWith(
      async () => (status === 200 ? okResponse(body()) : new Response("nope", { status })),
      c.now,
    );
    await cache.refresh();
    status = 503;
    expect(await cache.refresh()).toBe(false);
    // An empty map would read as "every token unpriced" — the opposite of what
    // a 503 means.
    expect(cache.snapshot()!.prices.size).toBe(2);
    expect(errors.at(-1)).toContain("HTTP 503");
  });

  test("a malformed body is a failure too (no `tokens` array)", async () => {
    const { cache, errors } = cacheWith(async () => okResponse({ sponsor_discount: 0.025 }), () => 0);
    expect(await cache.refresh()).toBe(false);
    expect(cache.snapshot()).toBeNull();
    expect(errors.at(-1)).toContain("tokens");
  });

  test("isFresh() turns false once the snapshot passes maxAge", async () => {
    const c = clock();
    const { cache } = cacheWith(async () => okResponse(body()), c.now);

    expect(cache.isFresh(1000)).toBe(false); // nothing at all yet
    await cache.refresh();
    expect(cache.isFresh(1000)).toBe(true);

    c.advance(1000);
    expect(cache.isFresh(1000)).toBe(true); // exactly at the boundary still counts
    c.advance(1);
    expect(cache.isFresh(1000)).toBe(false);
    expect(cache.snapshot()).not.toBeNull(); // stale, but still readable
  });

  test("the env discount applies ONLY before the node has ever answered", async () => {
    const c = clock();
    let ok = false;
    const { cache } = cacheWith(async () => {
      if (!ok) throw new Error("node down");
      return okResponse(body());
    }, c.now, 0.05);

    // Node never answered → the SPONSOR_DISCOUNT_BPS bootstrap.
    await cache.refresh();
    expect(cache.discount()).toBe(0.05);

    ok = true;
    await cache.refresh();
    expect(cache.discount()).toBe(0.025); // the node's number wins

    // …and it keeps winning across later failures: the last thing the node
    // said is a better answer than this process's own env var.
    ok = false;
    c.advance(600_000);
    await cache.refresh();
    expect(cache.discount()).toBe(0.025);
  });

  test("an out-of-range sponsor_discount from the node falls back rather than throwing", async () => {
    const { cache } = cacheWith(async () => okResponse(body({ sponsor_discount: 1.5 })), () => 0, 0.05);
    expect(await cache.refresh()).toBe(true);
    expect(cache.discount()).toBe(0.05);
  });

  test("start() polls immediately, is idempotent, and stop() clears the timer", async () => {
    const c = clock();
    let calls = 0;
    const { cache } = cacheWith(async () => {
      calls++;
      return okResponse(body());
    }, c.now);

    cache.start();
    cache.start(); // second call must not add a second timer or a second fetch
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    cache.stop();
    cache.stop(); // idempotent
  });

  test("a node that is down at startup does not throw out of start()", () => {
    const { cache } = cacheWith(async () => {
      throw new Error("ECONNREFUSED");
    }, () => 0);
    expect(() => cache.start()).not.toThrow();
    cache.stop();
  });

  test("describe() names the node and the age an operator needs", async () => {
    const c = clock();
    const { cache } = cacheWith(async () => okResponse(body()), c.now);
    expect(cache.describe()).toContain("prices=NONE");
    await cache.refresh();
    c.advance(90_000);
    expect(cache.describe()).toBe(
      "prices=2 tokens age=90s discount=2.50% node=http://node.test:9999/v1/prices",
    );
  });
});

describe("parsePricesBody — what counts as a market price", () => {
  test("feed | seed | fixed | manual are priced; fallback is not", () => {
    const sources = ["feed", "seed", "fixed", "manual", "fallback"];
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
    BATCHER_PRICE_REFRESH_MS: undefined,
    BATCHER_PRICE_MAX_AGE_MS: undefined,
    BATCHER_SPONSOR_POLICY: undefined,
    BATCHER_SPONSOR_UNPRICED: undefined,
    SPONSOR_DISCOUNT_BPS: undefined,
  };

  test("the defaults are D7's rollout defaults", () => {
    const config = withEnv(cleared, loadSponsorshipConfig);
    expect(config).toEqual({
      nodeApiUrl: "http://127.0.0.1:9999",
      priceRefreshMs: 600_000,
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
        BATCHER_PRICE_REFRESH_MS: "1000",
        BATCHER_PRICE_MAX_AGE_MS: "2000",
        SPONSOR_DISCOUNT_BPS: "500",
      },
      loadSponsorshipConfig,
    );
    expect(config.policy).toBe("enforce");
    expect(config.unpriced).toBe("reject");
    expect(config.nodeApiUrl).toBe("http://kernel:9999");
    expect(config.priceRefreshMs).toBe(1000);
    expect(config.priceMaxAgeMs).toBe(2000);
    expect(config.fallbackDiscountBps).toBe(500);
  });

  test.each([
    ["BATCHER_SPONSOR_POLICY", "enfroce", "enforce | warn | off"],
    ["BATCHER_SPONSOR_UNPRICED", "deny", "allow | reject"],
    ["BATCHER_PRICE_REFRESH_MS", "soon", "positive number"],
    ["BATCHER_PRICE_MAX_AGE_MS", "0", "positive number"],
    ["BATCHER_NODE_API_URL", "kernel:9999", "absolute http(s) URL"],
    ["BATCHER_NODE_API_URL", "not a url", "absolute http(s) URL"],
    ["SPONSOR_DISCOUNT_BPS", "10000", "[0, 10000)"],
  ])("%s=%s throws at startup", (key, value, message) => {
    expect(() => withEnv({ ...cleared, [key]: value }, loadSponsorshipConfig)).toThrow(message);
  });
});
