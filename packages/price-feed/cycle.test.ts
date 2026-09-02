import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

// One cycle, against the real schema in PGlite with the network faked. What
// matters here is the control flow the operator's CoinGecko bill depends on:
// one request per asset, spaced, and a hard stop on the first 429.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

import { closeTestPglite } from "../database/test-pglite.ts";
import { CoinGeckoError, type AssetQuote } from "./src/coingecko.ts";
import { runCycle, type CycleDeps } from "./src/cycle.ts";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, getAssetPrices, getPriceFeedStatus } = await import("@zswap-da/database");

const PORT = 54355;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const FEED = ["bitcoin", "ethereum", "usd-coin", "midnight-3"];

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
                  ('usdm', 1, 'fixed')) AS v(id, price, source)
     WHERE asset_prices.asset_id = v.id`,
  );
});

interface Harness {
  deps: CycleDeps;
  requested: string[];
  sleeps: number[];
  logs: string[];
}

function harness(
  respond: (assetId: string, n: number) => AssetQuote | Error,
): Harness {
  const requested: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let n = 0;
  return {
    requested,
    sleeps,
    logs,
    deps: {
      db: client as any,
      fetchAsset: async (assetId) => {
        requested.push(assetId);
        const answer = respond(assetId, n++);
        if (answer instanceof Error) throw answer;
        return answer;
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

test("one request per asset, spaced, all rows written and marked `feed`", async () => {
  const h = harness((id) => ok(id, id === "bitcoin" ? "80000" : "1.5"));
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 1000 });

  expect(h.requested).toEqual(FEED);
  // n assets = n-1 waits: nothing is paid before the first request.
  expect(h.sleeps).toEqual([1000, 1000, 1000]);
  expect(result.updated).toEqual(FEED);
  expect(result.failed).toEqual([]);
  expect(result.error).toBeNull();
  expect(result.stoppedOnRateLimit).toBe(false);

  const rows = await assets();
  expect(rows.get("bitcoin")!.price_usd).toBe("80000");
  expect(rows.get("bitcoin")!.source).toBe("feed");
  expect(rows.get("ethereum")!.source).toBe("feed");
  // The peg is untouched: it was never in the list.
  expect(rows.get("usdm")!.price_usd).toBe("1");
  expect(rows.get("usdm")!.source).toBe("fixed");

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

test("a single-asset cycle sleeps not at all", async () => {
  const h = harness((id) => ok(id, "1"));
  await runCycle(h.deps, { assetIds: ["bitcoin"], spacingMs: 1000 });
  expect(h.sleeps).toEqual([]);
});

// ── SC-004: never more than one request per second, stop on 429 ────────────

test("the first 429 stops the cycle and keeps what was already written", async () => {
  const h = harness((id) =>
    id === "usd-coin"
      ? new CoinGeckoError("usd-coin: rate limited (429)", "rate_limit", "usd-coin", 429, {
          remaining: 0,
        })
      : ok(id, "111"),
  );
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 1000 });

  // midnight-3 was never asked for.
  expect(h.requested).toEqual(["bitcoin", "ethereum", "usd-coin"]);
  expect(result.stoppedOnRateLimit).toBe(true);
  expect(result.notRequested).toEqual(["midnight-3"]);
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
  expect(status.last_error).toContain("not requested: midnight-3");
  expect(status.last_ok_at).toBeNull();
});

// ── partial failure ────────────────────────────────────────────────────────

test("a 500 on one asset does not stop the next one", async () => {
  const h = harness((id) =>
    id === "ethereum"
      ? new CoinGeckoError("ethereum: HTTP 500", "http", "ethereum", 500)
      : ok(id, "7"),
  );
  const result = await runCycle(h.deps, { assetIds: FEED, spacingMs: 1000 });

  expect(h.requested).toEqual(FEED);
  expect(result.updated).toEqual(["bitcoin", "usd-coin", "midnight-3"]);
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

test("a non-CoinGecko throw is recorded, not propagated", async () => {
  const h = harness((id) => (id === "bitcoin" ? new TypeError("boom") : ok(id, "3")));
  const result = await runCycle(h.deps, { assetIds: ["bitcoin", "ethereum"], spacingMs: 0 });
  expect(result.failed[0]).toEqual({ assetId: "bitcoin", kind: "unknown", message: "boom" });
  expect(result.updated).toEqual(["ethereum"]);
});

// ── fixed assets ───────────────────────────────────────────────────────────

test("a fixed asset in the list is skipped WITHOUT a request", async () => {
  const h = harness((id) => ok(id, "0.5"));
  const result = await runCycle(h.deps, {
    assetIds: ["bitcoin", "usdm"],
    spacingMs: 1000,
  });

  expect(h.requested).toEqual(["bitcoin"]);
  expect(result.skipped).toEqual(["usdm"]);
  expect(result.error).toBeNull(); // not a failure
  expect(h.logs.join("\n")).toContain("usdm: fixed peg — not requested");

  const rows = await assets();
  expect(rows.get("usdm")!.price_usd).toBe("1");
});

test("a status row is written even when nothing was requested at all", async () => {
  const h = harness((id) => ok(id, "1"));
  const result = await runCycle(h.deps, { assetIds: ["usdm"], spacingMs: 1000 });
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
  expect([...rows.values()].filter((r) => r.source === "feed")).toHaveLength(4);
  const statuses = await client.query("SELECT COUNT(*)::int AS n FROM price_feed_status");
  expect(statuses.rows[0].n).toBe(1);
});
