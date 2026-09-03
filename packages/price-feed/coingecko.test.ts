import { expect, test } from "bun:test";

import {
  CoinGeckoError,
  describeIds,
  fetchAssetPrices,
  formatRateLimit,
  type FetchAssetOptions,
} from "./src/coingecko.ts";

const KEY = "demo-key-not-a-real-one";

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function stub(
  respond: (url: string) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), headers });
    return await respond(String(input));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const opts = (fetchImpl: typeof fetch): FetchAssetOptions => ({
  apiKey: KEY,
  baseUrl: "https://api.example.test/api/v3",
  fetchImpl,
});

/** The chunk-level rejection, as the cycle sees it. */
const failing = async (
  ids: readonly string[],
  fetchImpl: typeof fetch,
  options: Partial<FetchAssetOptions> = {},
): Promise<CoinGeckoError> =>
  (await fetchAssetPrices(ids, { ...opts(fetchImpl), ...options }).catch(
    (e: unknown) => e,
  )) as CoinGeckoError;

// ── the request ────────────────────────────────────────────────────────────

test("the key travels as a header and NEVER in the query string", async () => {
  const { fetchImpl, calls } = stub(() => json({ bitcoin: { usd: 77387, last_updated_at: 1788380750 } }));
  await fetchAssetPrices(["bitcoin"], opts(fetchImpl));

  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers["x-cg-demo-api-key"]).toBe(KEY);
  // Query strings reach access logs, proxies and error reports; this key is
  // shared and unrotated (Q-7), so it must never appear in one.
  expect(calls[0]!.url).not.toContain(KEY);
  expect(calls[0]!.url).not.toContain("x_cg");
  expect(calls[0]!.url).toBe(
    "https://api.example.test/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true",
  );
});

test("many ids travel in ONE request as a comma list", async () => {
  const { fetchImpl, calls } = stub(() =>
    json({
      bitcoin: { usd: 77387, last_updated_at: 1788380750 },
      ethereum: { usd: 2393.28, last_updated_at: 1788380750 },
      "usdm-2": { usd: 1.001, last_updated_at: 1788388850 },
    }),
  );
  const batch = await fetchAssetPrices(["bitcoin", "ethereum", "usdm-2"], opts(fetchImpl));

  // The whole point of Q-11: three assets, one call.
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(
    "https://api.example.test/api/v3/simple/price" +
      "?ids=bitcoin,ethereum,usdm-2&vs_currencies=usd&include_last_updated_at=true",
  );
  expect(batch.failures).toEqual([]);
  expect(batch.quotes.map((q) => [q.assetId, q.usd])).toEqual([
    ["bitcoin", "77387"],
    ["ethereum", "2393.28"],
    ["usdm-2", "1.001"],
  ]);
});

test("quotes come back in the order asked for, not the order the body listed them", async () => {
  const { fetchImpl } = stub(() =>
    json({ ethereum: { usd: 2 }, bitcoin: { usd: 1 } }),
  );
  const batch = await fetchAssetPrices(["bitcoin", "ethereum"], opts(fetchImpl));
  expect(batch.quotes.map((q) => q.assetId)).toEqual(["bitcoin", "ethereum"]);
});

test("an empty chunk makes no request at all", async () => {
  const { fetchImpl, calls } = stub(() => json({}));
  const batch = await fetchAssetPrices([], opts(fetchImpl));
  expect(calls).toHaveLength(0);
  expect(batch).toEqual({ quotes: [], failures: [], rateLimit: {} });
});

test("an id with a URL-unsafe character is encoded", async () => {
  const { fetchImpl, calls } = stub(() => json({}));
  await fetchAssetPrices(["a b", "c&d"], opts(fetchImpl));
  expect(calls[0]!.url).toContain("ids=a%20b,c%26d&");
});

// ── the answer ─────────────────────────────────────────────────────────────

test("a good answer yields an exact decimal string and an ISO provider time", async () => {
  const { fetchImpl } = stub(() =>
    json({ "midnight-3": { usd: 0.01918181, last_updated_at: 1788380780 } }),
  );
  const batch = await fetchAssetPrices(["midnight-3"], opts(fetchImpl));
  expect(batch.quotes).toEqual([
    {
      assetId: "midnight-3",
      usd: "0.01918181",
      providerUpdatedAt: "2026-09-02T20:26:20.000Z",
      rateLimit: {},
    },
  ]);
});

test("a very small price is not rendered in exponent notation", async () => {
  const { fetchImpl } = stub(() => json({ tiny: { usd: 1e-9 } }));
  const batch = await fetchAssetPrices(["tiny"], opts(fetchImpl));
  expect(batch.quotes[0]!.usd).toBe("0.000000001");
  expect(batch.quotes[0]!.providerUpdatedAt).toBeNull();
});

test("rate-limit headers are parsed when present, absent when not", async () => {
  const { fetchImpl } = stub(() =>
    json(
      { bitcoin: { usd: 1 } },
      {
        headers: {
          "content-type": "application/json",
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "97",
          "x-ratelimit-reset": "30",
        },
      },
    ),
  );
  const batch = await fetchAssetPrices(["bitcoin"], opts(fetchImpl));
  expect(batch.rateLimit).toEqual({ limit: 100, remaining: 97, reset: "30" });
  expect(batch.quotes[0]!.rateLimit).toEqual({ limit: 100, remaining: 97, reset: "30" });
  expect(formatRateLimit(batch.rateLimit)).toBe("remaining=97 limit=100 reset=30");
  expect(formatRateLimit({})).toBeNull();
});

// ── per-id failures: what makes batching safe ──────────────────────────────

test("one unusable entry fails ONLY that id — the rest of the chunk is written", async () => {
  // This is the property the original one-asset-per-request design was chosen
  // to guarantee, and the reason batching is acceptable now.
  const { fetchImpl } = stub(() =>
    json({
      bitcoin: { usd: 77387 },
      ethereum: { usd: "2393.28" }, // string, not number
      "usd-coin": { usd: 0.999818 },
    }),
  );
  const batch = await fetchAssetPrices(["bitcoin", "ethereum", "usd-coin"], opts(fetchImpl));

  expect(batch.quotes.map((q) => q.assetId)).toEqual(["bitcoin", "usd-coin"]);
  expect(batch.failures).toEqual([
    {
      assetId: "ethereum",
      kind: "malformed",
      message: 'ethereum: usd is "2393.28", expected a positive finite number',
    },
  ]);
});

test("every unusable per-id shape is `malformed`, never a price of NaN", async () => {
  const entries: unknown[] = [{ usd: "1" }, { usd: 0 }, { usd: -1 }, { usd: null }, 77387];
  for (const entry of entries) {
    const { fetchImpl } = stub(() => json({ bitcoin: entry }));
    const batch = await fetchAssetPrices(["bitcoin"], opts(fetchImpl));
    expect(batch.quotes).toEqual([]);
    expect(batch.failures[0]!.kind).toBe("malformed");
  }
});

test("an id the response does not mention is `missing`, not malformed", async () => {
  const { fetchImpl } = stub(() => json({ bitcoin: { usd: 1 } }));
  const batch = await fetchAssetPrices(["bitcoin", "midnight-42"], opts(fetchImpl));
  expect(batch.quotes.map((q) => q.assetId)).toEqual(["bitcoin"]);
  expect(batch.failures[0]!.kind).toBe("missing");
  expect(batch.failures[0]!.message).toContain("unknown id");
});

// ── chunk failures: the request itself ─────────────────────────────────────

test("429 is its own kind — it is the one that stops a cycle — and names the chunk", async () => {
  const { fetchImpl } = stub(
    () =>
      new Response("rate limited", {
        status: 429,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  );
  const error = await failing(["bitcoin", "ethereum"], fetchImpl);
  expect(error).toBeInstanceOf(CoinGeckoError);
  expect(error.kind).toBe("rate_limit");
  expect(error.status).toBe(429);
  expect(error.rateLimit).toEqual({ remaining: 0 });
  expect(error.message).toContain("remaining=0");
  // The whole chunk is on the error, so the cycle can record every id in it
  // instead of guessing which one the provider objected to.
  expect(error.assetIds).toEqual(["bitcoin", "ethereum"]);
});

test("any other non-2xx is `http` and carries the whole chunk", async () => {
  for (const status of [401, 404, 500, 503]) {
    const { fetchImpl } = stub(() => new Response("nope", { status }));
    const error = await failing(["bitcoin", "ethereum"], fetchImpl);
    expect(error.kind).toBe("http");
    expect(error.status).toBe(status);
    expect(error.assetIds).toEqual(["bitcoin", "ethereum"]);
  }
});

test("a body that is not a JSON object fails the chunk, not one id", async () => {
  for (const body of [[1, 2, 3], "not json"]) {
    const { fetchImpl } = stub(() =>
      typeof body === "string" ? new Response(body, { status: 200 }) : json(body),
    );
    const error = await failing(["bitcoin"], fetchImpl);
    expect(error).toBeInstanceOf(CoinGeckoError);
    expect(error.kind).toBe("malformed");
  }
});

test("a transport failure is `network` and names the chunk", async () => {
  const { fetchImpl } = stub(() => {
    throw new Error("ECONNREFUSED");
  });
  const error = await failing(["bitcoin"], fetchImpl);
  expect(error.kind).toBe("network");
  expect(error.message).toContain("bitcoin");
  expect(error.message).toContain("ECONNREFUSED");
});

test("a hung request aborts on the timeout instead of holding the cycle open", async () => {
  // A server that never answers. The stub rejects on abort exactly as the
  // platform `fetch` does, so what is under test is the AbortController wiring.
  const fetchImpl = ((_input: any, init?: any) =>
    new Promise<Response>((_resolve, reject) => {
      const signal: AbortSignal = init.signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;

  const started = Date.now();
  const error = await failing(["bitcoin"], fetchImpl, { timeoutMs: 20 });
  expect(error.kind).toBe("network");
  expect(error.message).toContain("no response within 20 ms");
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a trailing slash on the base url does not produce a double slash", async () => {
  const { fetchImpl, calls } = stub(() => json({ bitcoin: { usd: 1 } }));
  await fetchAssetPrices(["bitcoin"], { apiKey: KEY, baseUrl: "https://x.test/api/v3/", fetchImpl });
  expect(calls[0]!.url).toStartWith("https://x.test/api/v3/simple/price?");
});

// ── error labels ───────────────────────────────────────────────────────────

test("a long chunk is summarised in messages instead of listing 50 ids", () => {
  expect(describeIds(["a"])).toBe("a");
  expect(describeIds(["a", "b", "c"])).toBe("a,b,c");
  expect(describeIds(["a", "b", "c", "d", "e"])).toBe("a,b,c+2 more");
});
