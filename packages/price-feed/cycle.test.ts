import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

// One cycle, against the real schema in PGlite with the network faked. What
// matters here is the control flow the operator's CoinGecko bill depends on:
// ids CHUNKED into batched requests, spaced, and a hard stop on the first 429.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

import { closeTestPglite } from "../database/test-pglite.ts";
import { CoinGeckoError, type AssetQuote, type BatchResult } from "./src/coingecko.ts";
import { chunkIds, runCycle, type CycleDeps } from "./src/cycle.ts";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, getAssetPrices, getPriceFeedStatus } = await import("@zswap-da/database");

const PORT = 54355;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const FEED = ["bitcoin", "ethereum", "usd-coin", "midnight-3", "usdm-2"];

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of migrationTable) await client.query(migration.sql);
});

afterAll(async () => {
  await closeTestPglite(handle, client);
});

beforeEach(async () => {
  // Back to the shipped seeds, so each test starts from a fresh stack.
  await client.query("DELETE FROM price_feed_status");
  await client.query(
    `UPDATE asset_prices SET price_usd = v.price, source = v.source, updated_at = NOW()
     FROM (VALUES ('bitcoin', 77387::numeric, 'seed'), ('ethereum', 2393.28, 'seed'),
                  ('usd-coin', 0.999818, 'seed'), ('midnight-3', 0.01918181, 'seed'),
                  ('usdm-2', 1.001, 'seed')) AS v(id, price, source)
     WHERE asset_prices.asset_id = v.id`,
  );
});

interface Harness {
  deps: CycleDeps;
  /** Every id the cycle asked for, flattened, in order. */
  requested: string[];
  /** The chunks, so a test can assert how many REQUESTS were made. */
  chunks: string[][];
  sleeps: number[];
  logs: string[];
}

/**
 * `respond` answers per id, and the harness assembles the batch the real
 * module would have produced:
 *   - an AssetQuote  → a quote in the response
 *   - a CoinGeckoError → the REQUEST failed, so the whole chunk throws (this is
 *     what the real fetchAssetPrices does for a 429/HTTP/network failure)
 *   - any other Error → a per-id failure inside an otherwise good response
 */
function harness(
  respond: (assetId: string, n: number) => AssetQuote | Error,
): Harness {
  const requested: string[] = [];
  const chunks: string[][] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let n = 0;
  return {
    requested,
    chunks,
    sleeps,
    logs,
    deps: {
      db: client as any,
      fetchAssets: async (assetIds) => {
        chunks.push([...assetIds]);
        requested.push(...assetIds);
        const batch: BatchResult = { quotes: [], failures: [], rateLimit: {} };
        for (const assetId of assetIds) {
          const answer = respond(assetId, n++);
          if (answer instanceof CoinGeckoError) throw answer;
          if (answer instanceof Error) {
            batch.failures.push({ assetId, kind: "malformed", message: answer.message });
            continue;
          }
          batch.quotes.push(answer);
          batch.rateLimit = answer.rateLimit;
        }
        return batch;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      log: (line) => logs.push(line),
    },
  };
}

const ok = (assetId: string, usd: string): AssetQuote => ({
  assetId,
  usd,
  providerUpdatedAt: "2026-09-03T00:00:00.000Z",
  rateLimit: { remaining: 90, limit: 100 },
});

const assets = async () =>
  new Map((await getAssetPrices.run(undefined, client)).map((r) => [r.asset_id, r]));

// ── the happy cycle ────────────────────────────────────────────────────────

test("today's five assets are ONE request, all rows written and marked `feed`", async () => {
  const h = harness((id) => ok(id, id === "bitcoin" ? "80000" : "1.5"));
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 1000 });

  expect(h.requested).toEqual(FEED);
  // SC-004: ceil(5 / 50) = ONE call, so no spacing is paid at all.
  expect(h.chunks).toEqual([FEED]);
  expect(h.sleeps).toEqual([]);
  expect(result.updated).toEqual(FEED);
  expect(result.failed).toEqual([]);
  expect(result.error).toBeNull();
  expect(result.stoppedOnRateLimit).toBe(false);

  const rows = await assets();
  expect(rows.get("bitcoin")!.price_usd).toBe("80000");
  expect(rows.get("bitcoin")!.source).toBe("feed");
  expect(rows.get("ethereum")!.source).toBe("feed");
  // The stablecoin is fetched like everything else — no asset is exempt.
  expect(rows.get("usdm-2")!.price_usd).toBe("1.5");
  expect(rows.get("usdm-2")!.source).toBe("feed");

  const status = (await getPriceFeedStatus.run(undefined, client))[0]!;
  expect(status.provider).toBe("coingecko");
  expect(new Date(status.last_ok_at as any).toISOString()).toBe("2026-09-03T00:00:00.000Z");
  expect(status.last_error).toBeNull();
});

test("the per-asset log line carries the price and the provider timestamp", async () => {
  const h = harness((id) => ok(id, "42"));
  await runCycle(h.deps, { assetIds: ["bitcoin"], spacingMs: 1000 });
  expect(h.logs.join("\n")).toContain(
    "[price-feed] bitcoin usd=42 provider_updated_at=2026-09-03T00:00:00.000Z",
  );
  expect(h.logs.join("\n")).toContain("rate limit: remaining=90 limit=100");
});

test("a single-chunk cycle sleeps not at all", async () => {
  const h = harness((id) => ok(id, "1"));
  await runCycle(h.deps, { assetIds: ["bitcoin"], spacingMs: 1000 });
  expect(h.sleeps).toEqual([]);
});

// ── chunking (Q-11) ────────────────────────────────────────────────────────

test("chunkIds splits in order and survives a nonsense size", () => {
  expect(chunkIds(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  expect(chunkIds(["a"], 50)).toEqual([["a"]]);
  expect(chunkIds([], 50)).toEqual([]);
  // 0 or a fraction would loop forever / slice nothing: fall back to the default.
  expect(chunkIds(["a", "b"], 0)).toEqual([["a", "b"]]);
  expect(chunkIds(["a", "b"], 1.5)).toEqual([["a", "b"]]);
});

test("a batch size below the asset count makes several spaced requests", async () => {
  const h = harness((id) => ok(id, "3"));
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 1000, batchSize: 2 });

  // ceil(5 / 2) = 3 requests, and n chunks = n-1 waits.
  expect(h.chunks).toEqual([
    ["bitcoin", "ethereum"],
    ["usd-coin", "midnight-3"],
    ["usdm-2"],
  ]);
  expect(h.sleeps).toEqual([1000, 1000]);
  expect(result.updated).toEqual(FEED);
  expect(h.logs.join("\n")).toContain("cycle done: 5 updated, 0 failed in 3 request(s)");
});

test("a chunk-level failure records EVERY id in that chunk and still asks the next chunk", async () => {
  const h = harness((id) =>
    id === "bitcoin"
      ? new CoinGeckoError("chunk: HTTP 502", "http", ["bitcoin", "ethereum"], 502)
      : ok(id, "9"),
  );
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 0, batchSize: 2 });

  // Blaming one id would be a guess: the request carried both.
  expect(result.failed).toEqual([
    { assetId: "bitcoin", kind: "http", message: "chunk: HTTP 502" },
    { assetId: "ethereum", kind: "http", message: "chunk: HTTP 502" },
  ]);
  // …and one 502 does not cost the other chunks their refresh.
  expect(result.updated).toEqual(["usd-coin", "midnight-3", "usdm-2"]);
  expect(result.stoppedOnRateLimit).toBe(false);

  const rows = await assets();
  expect(rows.get("ethereum")!.price_usd).toBe("2393.28");
  expect(rows.get("ethereum")!.source).toBe("seed");
  expect(rows.get("usd-coin")!.source).toBe("feed");
});

test("one unusable id inside a good response fails only that id", async () => {
  const h = harness((id) => (id === "ethereum" ? new Error("ethereum: usd is null") : ok(id, "4")));
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 0 });

  expect(h.chunks).toHaveLength(1);
  expect(result.failed).toEqual([
    { assetId: "ethereum", kind: "malformed", message: "ethereum: usd is null" },
  ]);
  expect(result.updated).toEqual(["bitcoin", "usd-coin", "midnight-3", "usdm-2"]);
});

// ── SC-004: never more than one request per second, stop on 429 ────────────

test("the first 429 stops the cycle and keeps what was already written", async () => {
  const h = harness((id) =>
    id === "usd-coin"
      ? new CoinGeckoError(
          "usd-coin,midnight-3: rate limited (429)",
          "rate_limit",
          ["usd-coin", "midnight-3"],
          429,
          { remaining: 0 },
        )
      : ok(id, "111"),
  );
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 1000, batchSize: 2 });

  // The chunk that hit the 429 was asked; nothing after it was.
  expect(h.requested).toEqual(["bitcoin", "ethereum", "usd-coin", "midnight-3"]);
  expect(result.stoppedOnRateLimit).toBe(true);
  expect(result.notRequested).toEqual(["usdm-2"]);
  expect(result.updated).toEqual(["bitcoin", "ethereum"]);

  const rows = await assets();
  // Written before the 429 — kept.
  expect(rows.get("bitcoin")!.price_usd).toBe("111");
  expect(rows.get("bitcoin")!.source).toBe("feed");
  // Never fetched — the seed survives, it is not blanked.
  expect(rows.get("midnight-3")!.price_usd).toBe("0.01918181");
  expect(rows.get("midnight-3")!.source).toBe("seed");

  const status = (await getPriceFeedStatus.run(undefined, client))[0]!;
  expect(status.last_error).toContain("429");
  expect(status.last_error).toContain("not requested: usdm-2");
  expect(status.last_ok_at).toBeNull();
});

// ── partial failure ────────────────────────────────────────────────────────

test("a 500 on one chunk does not stop the next one", async () => {
  const h = harness((id) =>
    id === "ethereum"
      ? new CoinGeckoError("ethereum: HTTP 500", "http", ["ethereum"], 500)
      : ok(id, "7"),
  );
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 1000, batchSize: 1 });

  expect(h.requested).toEqual(FEED);
  expect(result.updated).toEqual(["bitcoin", "usd-coin", "midnight-3", "usdm-2"]);
  expect(result.failed).toEqual([
    { assetId: "ethereum", kind: "http", message: "ethereum: HTTP 500" },
  ]);
  expect(result.stoppedOnRateLimit).toBe(false);

  const rows = await assets();
  expect(rows.get("bitcoin")!.price_usd).toBe("7");
  // ethereum keeps its last good price rather than being cleared.
  expect(rows.get("ethereum")!.price_usd).toBe("2393.28");
  expect(rows.get("ethereum")!.source).toBe("seed");

  const status = (await getPriceFeedStatus.run(undefined, client))[0]!;
  expect(status.last_error).toBe("ethereum: ethereum: HTTP 500");
  expect(status.last_ok_at).toBeNull();
});

test("a non-CoinGecko throw from the fetcher is recorded, not propagated", async () => {
  const h: any = harness((id) => ok(id, "3"));
  const good = h.deps.fetchAssets;
  h.deps.fetchAssets = async (ids: readonly string[]) => {
    if (ids.includes("bitcoin")) throw new TypeError("boom");
    return good(ids);
  };
  const result = await runCycle(h.deps, {
    assetIds: ["bitcoin", "ethereum"],
    spacingMs: 0,
    batchSize: 1,
  });
  expect(result.failed[0]).toEqual({ assetId: "bitcoin", kind: "unknown", message: "boom" });
  expect(result.updated).toEqual(["ethereum"]);
});

// ── no asset is exempt ─────────────────────────────────────────────────────

test("the stablecoin is requested and written like any other asset", async () => {
  const h = harness((id) => ok(id, id === "usdm-2" ? "0.94" : "80000"));
  const result = await runCycle(h.deps, {
    assetIds: ["bitcoin", "usdm-2"],
    spacingMs: 1000,
  });

  expect(h.requested).toEqual(["bitcoin", "usdm-2"]);
  expect(result.updated).toEqual(["bitcoin", "usdm-2"]);
  expect(result.error).toBeNull();

  const rows = await assets();
  // A depeg reaches the database instead of being clamped to 1.
  expect(rows.get("usdm-2")!.price_usd).toBe("0.94");
  expect(rows.get("usdm-2")!.source).toBe("feed");
});

test("a status row is written even when nothing was requested at all", async () => {
  const h = harness((id) => ok(id, "1"));
  const result = await runCycle(h.deps, { assetIds: [], spacingMs: 1000 });
  expect(h.chunks).toEqual([]);
  expect(h.requested).toEqual([]);
  expect(result.updated).toEqual([]);
  const status = (await getPriceFeedStatus.run(undefined, client))[0]!;
  expect(new Date(status.last_run_at as any).toISOString()).toBe("2026-09-03T00:00:00.000Z");
});

// ── the whole cycle is idempotent ──────────────────────────────────────────

test("running twice leaves the same rows and one status row", async () => {
  const h1 = harness((id) => ok(id, "5"));
  await runCycle(h1.deps, { assetIds: FEED, spacingMs: 0 });
  const h2 = harness((id) => ok(id, "5"));
  await runCycle(h2.deps, { assetIds: FEED, spacingMs: 0 });

  const rows = await assets();
  expect([...rows.values()].filter((r) => r.source === "feed")).toHaveLength(5);
  const statuses = await client.query("SELECT COUNT(*)::int AS n FROM price_feed_status");
  expect(statuses.rows[0].n).toBe(1);
});
