import { expect, test } from "bun:test";

import {
  CoinGeckoError,
  fetchAssetPrice,
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

// ── the request ────────────────────────────────────────────────────────────

test("the key travels as a header and NEVER in the query string", async () => {
  const { fetchImpl, calls } = stub(() => json({ bitcoin: { usd: 77387, last_updated_at: 1788380750 } }));
  await fetchAssetPrice("bitcoin", opts(fetchImpl));

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

test("one asset per request — the id is never a comma list", async () => {
  const { fetchImpl, calls } = stub(() => json({ ethereum: { usd: 2393.28 } }));
  await fetchAssetPrice("ethereum", opts(fetchImpl));
  expect(calls[0]!.url).toContain("ids=ethereum&");
  expect(calls[0]!.url).not.toContain(",");
  expect(calls[0]!.url).not.toContain("%2C");
});

// ── the answer ─────────────────────────────────────────────────────────────

test("a good answer yields an exact decimal string and an ISO provider time", async () => {
  const { fetchImpl } = stub(() =>
    json({ "midnight-3": { usd: 0.01918181, last_updated_at: 1788380780 } }),
  );
  const quote = await fetchAssetPrice("midnight-3", opts(fetchImpl));
  expect(quote).toEqual({
    assetId: "midnight-3",
    usd: "0.01918181",
    providerUpdatedAt: "2026-09-02T20:26:20.000Z",
    rateLimit: {},
  });
});

test("a very small price is not rendered in exponent notation", async () => {
  const { fetchImpl } = stub(() => json({ tiny: { usd: 1e-9 } }));
  const quote = await fetchAssetPrice("tiny", opts(fetchImpl));
  expect(quote.usd).toBe("0.000000001");
  expect(quote.providerUpdatedAt).toBeNull();
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
  const quote = await fetchAssetPrice("bitcoin", opts(fetchImpl));
  expect(quote.rateLimit).toEqual({ limit: 100, remaining: 97, reset: "30" });
  expect(formatRateLimit(quote.rateLimit)).toBe("remaining=97 limit=100 reset=30");
  expect(formatRateLimit({})).toBeNull();
});

// ── the failures ───────────────────────────────────────────────────────────

test("429 is its own kind — it is the one that stops a cycle", async () => {
  const { fetchImpl } = stub(
    () =>
      new Response("rate limited", {
        status: 429,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  );
  const error = (await fetchAssetPrice("bitcoin", opts(fetchImpl)).catch((e) => e)) as CoinGeckoError;
  expect(error).toBeInstanceOf(CoinGeckoError);
  expect(error.kind).toBe("rate_limit");
  expect(error.status).toBe(429);
  expect(error.rateLimit).toEqual({ remaining: 0 });
  expect(error.message).toContain("remaining=0");
});

test("any other non-2xx is `http`", async () => {
  for (const status of [401, 404, 500, 503]) {
    const { fetchImpl } = stub(() => new Response("nope", { status }));
    const error = (await fetchAssetPrice("bitcoin", opts(fetchImpl)).catch((e) => e)) as CoinGeckoError;
    expect(error.kind).toBe("http");
    expect(error.status).toBe(status);
  }
});

test("a 200 with a body we cannot use is `malformed`, not a price of NaN", async () => {
  const bodies: unknown[] = [
    { bitcoin: { usd: "77387" } }, // string, not number
    { bitcoin: { usd: 0 } }, // non-positive
    { bitcoin: { usd: -1 } },
    { bitcoin: { usd: null } },
    { bitcoin: 77387 }, // entry is not an object
    [1, 2, 3],
  ];
  for (const body of bodies) {
    const { fetchImpl } = stub(() => json(body));
    const error = (await fetchAssetPrice("bitcoin", opts(fetchImpl)).catch((e) => e)) as CoinGeckoError;
    expect(error).toBeInstanceOf(CoinGeckoError);
    expect(error.kind).toBe("malformed");
  }

  const { fetchImpl } = stub(() => new Response("not json", { status: 200 }));
  const error = (await fetchAssetPrice("bitcoin", opts(fetchImpl)).catch((e) => e)) as CoinGeckoError;
  expect(error.kind).toBe("malformed");
});

test("a 200 that simply does not know the id is `missing`", async () => {
  const { fetchImpl } = stub(() => json({}));
  const error = (await fetchAssetPrice("midnight-42", opts(fetchImpl)).catch((e) => e)) as CoinGeckoError;
  expect(error.kind).toBe("missing");
  expect(error.message).toContain("unknown id");
});

test("a transport failure is `network` and names the asset", async () => {
  const { fetchImpl } = stub(() => {
    throw new Error("ECONNREFUSED");
  });
  const error = (await fetchAssetPrice("bitcoin", opts(fetchImpl)).catch((e) => e)) as CoinGeckoError;
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
  const error = (await fetchAssetPrice("bitcoin", {
    apiKey: KEY,
    baseUrl: "https://api.example.test/api/v3",
    fetchImpl,
    timeoutMs: 20,
  }).catch((e) => e)) as CoinGeckoError;
  expect(error.kind).toBe("network");
  expect(error.message).toContain("no response within 20 ms");
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a trailing slash on the base url does not produce a double slash", async () => {
  const { fetchImpl, calls } = stub(() => json({ bitcoin: { usd: 1 } }));
  await fetchAssetPrice("bitcoin", { apiKey: KEY, baseUrl: "https://x.test/api/v3/", fetchImpl });
  expect(calls[0]!.url).toStartWith("https://x.test/api/v3/simple/price?");
});
