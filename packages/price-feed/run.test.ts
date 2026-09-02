import { expect, test } from "bun:test";

// The process's own behaviour: exit codes, the missing-key rule, and the loop
// schedule. The database and the clock are fakes — what is under test is the
// control flow an operator sees, not SQL (that is cycle.test.ts).

import { CoinGeckoError, type AssetQuote, type BatchResult } from "./src/coingecko.ts";
import type { DbConnection } from "./src/cycle.ts";
import {
  EXIT_CONFIG,
  EXIT_CYCLE_INCOMPLETE,
  EXIT_OK,
  RETRY_LADDER_MS,
  parseArgs,
  runLoop,
  runOnce,
  type RunDeps,
} from "./src/run.ts";
import type { PriceFeedConfig } from "./src/config.ts";

const CONFIG: PriceFeedConfig = {
  apiKey: "demo-key-not-a-real-one",
  baseUrl: "https://api.example.test/api/v3",
  intervalMs: 86_400_000,
  spacingMs: 1_000,
  requestTimeoutMs: 20_000,
  batchSize: 50,
  assetIds: ["bitcoin", "ethereum"],
  db: { host: "127.0.0.1", port: 5432, user: "postgres", password: "postgres", database: "postgres" },
};

/** A database that answers the two statements a cycle issues, and nothing else. */
function fakeDb(options: { tables?: string[] } = {}): DbConnection {
  const tables = options.tables ?? ["asset_prices", "price_feed_status"];
  return {
    async query(text) {
      const answer = (rows: unknown[]) => ({ rows, rowCount: rows.length });
      if (text.includes("information_schema.tables")) {
        return answer(tables.map((table_name) => ({ table_name })));
      }
      if (text.includes("INSERT INTO asset_prices")) {
        // RETURNING asset_id — one row means "written".
        return answer([{ asset_id: "written" }]);
      }
      if (text.includes("price_feed_status")) return answer([]);
      throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
    },
  };
}

interface Harness {
  deps: RunDeps;
  waits: number[];
  logs: string[];
  errors: string[];
  cycles: number;
}

function harness(
  respond: (assetId: string, cycle: number) => AssetQuote | Error,
  options: { db?: DbConnection; connectError?: Error; stopAfterCycles?: number } = {},
): Harness & { controller: AbortController } {
  const waits: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const controller = new AbortController();
  const state = { cycles: 0 };

  const deps: RunDeps = {
    connect: async () => {
      if (options.connectError) throw options.connectError;
      state.cycles++;
      return { db: options.db ?? fakeDb(), end: async () => {} };
    },
    fetchAssets: async (assetIds) => {
      const batch: BatchResult = { quotes: [], failures: [], rateLimit: {} };
      for (const assetId of assetIds) {
        const answer = respond(assetId, state.cycles - 1);
        // A CoinGeckoError is a REQUEST failure, exactly as the real module
        // throws it; anything else is a per-id problem inside a 200.
        if (answer instanceof CoinGeckoError) throw answer;
        if (answer instanceof Error) {
          batch.failures.push({ assetId, kind: "malformed", message: answer.message });
          continue;
        }
        batch.quotes.push(answer);
      }
      return batch;
    },
    sleep: async () => {},
    wait: async (ms) => {
      waits.push(ms);
      if (options.stopAfterCycles !== undefined && state.cycles >= options.stopAfterCycles) {
        controller.abort();
      }
    },
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  };

  return {
    deps,
    waits,
    logs,
    errors,
    controller,
    get cycles() {
      return state.cycles;
    },
  };
}

const ok = (assetId: string): AssetQuote => ({
  assetId,
  usd: "1",
  providerUpdatedAt: null,
  rateLimit: {},
});

// ── arguments ──────────────────────────────────────────────────────────────

test("--once is the only flag, anywhere in argv", () => {
  expect(parseArgs([])).toEqual({ once: false });
  expect(parseArgs(["--once"])).toEqual({ once: true });
  expect(parseArgs(["--verbose", "--once"])).toEqual({ once: true });
});

// ── --once exit codes ──────────────────────────────────────────────────────

test("--once exits 0 when every asset updated", async () => {
  const h = harness((id) => ok(id));
  expect(await runOnce(h.deps, CONFIG)).toBe(EXIT_OK);
});

test("--once exits 2 when an asset failed", async () => {
  const h = harness((id) => (id === "ethereum" ? new Error("ethereum: usd is null") : ok(id)));
  expect(await runOnce(h.deps, CONFIG)).toBe(EXIT_CYCLE_INCOMPLETE);
});

test("--once exits 2 when a whole chunk failed", async () => {
  const h = harness((id) =>
    id === "bitcoin"
      ? new CoinGeckoError("boom", "http", ["bitcoin", "ethereum"], 500)
      : ok(id),
  );
  expect(await runOnce(h.deps, CONFIG)).toBe(EXIT_CYCLE_INCOMPLETE);
});

test("--once exits 2 when a 429 cut the cycle short", async () => {
  const h = harness((id) =>
    id === "bitcoin" ? new CoinGeckoError("429", "rate_limit", ["bitcoin"], 429) : ok(id),
  );
  expect(await runOnce(h.deps, CONFIG)).toBe(EXIT_CYCLE_INCOMPLETE);
});

test("--once counts the stablecoin like every other asset", async () => {
  // No asset is exempt from a cycle any more, so a stablecoin that did not
  // land makes the cycle incomplete exactly as a failed bitcoin would.
  const all = harness((id) => ok(id));
  expect(await runOnce(all.deps, { ...CONFIG, assetIds: ["bitcoin", "usdm-2"] })).toBe(
    EXIT_OK,
  );

  const partial = harness((id) =>
    id === "usdm-2" ? new Error("usdm-2: not present in the response (unknown id?)") : ok(id),
  );
  expect(await runOnce(partial.deps, { ...CONFIG, assetIds: ["bitcoin", "usdm-2"] })).toBe(
    EXIT_CYCLE_INCOMPLETE,
  );
});

test("--once without a key WARNS and exits non-zero, without running a cycle", async () => {
  const h = harness((id) => ok(id));
  const code = await runOnce(h.deps, { ...CONFIG, apiKey: null });
  expect(code).toBe(EXIT_CONFIG);
  expect(code).not.toBe(EXIT_OK);
  expect(h.cycles).toBe(0);
  // Q-11 asks for a WARNING, in those words: a stack with no key is a
  // supported configuration, not a broken one.
  expect(h.errors.join("\n")).toContain("WARNING");
  expect(h.errors.join("\n")).toContain("COINGECKO_API_KEY is not set");
  // It must also say the stack is fine without it, or an operator will think
  // the deployment is broken.
  expect(h.errors.join("\n")).toContain("seeded reference prices");
});

test("--once on a database without the 00005 schema exits 64 with a clear message", async () => {
  const h = harness((id) => ok(id), { db: fakeDb({ tables: [] }) });
  expect(await runOnce(h.deps, CONFIG)).toBe(EXIT_CONFIG);
  expect(h.errors.join("\n")).toContain("missing asset_prices and price_feed_status");
  expect(h.errors.join("\n")).toContain("000-init.sql");
});

test("--once on an unreachable database exits 64, not 2", async () => {
  const h = harness((id) => ok(id), { connectError: new Error("ECONNREFUSED 127.0.0.1:5432") });
  expect(await runOnce(h.deps, CONFIG)).toBe(EXIT_CONFIG);
  expect(h.errors.join("\n")).toContain("ECONNREFUSED");
});

test("the config line never prints the key", async () => {
  const h = harness((id) => ok(id));
  await runOnce(h.deps, CONFIG);
  const all = [...h.logs, ...h.errors].join("\n");
  expect(all).not.toContain(CONFIG.apiKey!);
  expect(all).toContain("key=present");
});

// ── the loop ───────────────────────────────────────────────────────────────

test("loop mode runs a cycle at start and then one per interval", async () => {
  const h = harness(() => ok("x"), { stopAfterCycles: 3 });
  await runLoop(h.deps, CONFIG, h.controller.signal);
  expect(h.cycles).toBe(3);
  expect(h.waits).toEqual([CONFIG.intervalMs, CONFIG.intervalMs, CONFIG.intervalMs]);
});

test("a failed cycle walks the retry ladder, which is bounded", async () => {
  // Every cycle fails, so the schedule is the ladder and then the interval —
  // never something that keeps shrinking, and never an unbounded backoff.
  const h = harness(() => new CoinGeckoError("down", "http", ["x"], 503), { stopAfterCycles: 6 });
  await runLoop(h.deps, CONFIG, h.controller.signal);
  expect(h.waits).toEqual([
    RETRY_LADDER_MS[0]!,
    RETRY_LADDER_MS[1]!,
    RETRY_LADDER_MS[2]!,
    CONFIG.intervalMs,
    CONFIG.intervalMs,
    CONFIG.intervalMs,
  ]);
  expect(RETRY_LADDER_MS).toEqual([300_000, 900_000, 2_700_000]);
});

test("the ladder resets after a success", async () => {
  // cycle 0 fails → 5 min; cycle 1 succeeds → interval; cycle 2 fails → 5 min again.
  const h = harness((_id, cycle) =>
    cycle === 1 ? ok("x") : new CoinGeckoError("down", "http", ["x"], 503),
  { stopAfterCycles: 3 });
  await runLoop(h.deps, CONFIG, h.controller.signal);
  expect(h.waits).toEqual([RETRY_LADDER_MS[0]!, CONFIG.intervalMs, RETRY_LADDER_MS[0]!]);
});

test("a cycle that throws (database down) does not kill the loop", async () => {
  const h = harness(() => ok("x"), {
    connectError: new Error("ECONNREFUSED"),
    stopAfterCycles: 0,
  });
  // stopAfterCycles: 0 aborts on the first wait, so exactly one attempt runs.
  await runLoop(h.deps, CONFIG, h.controller.signal);
  expect(h.errors.join("\n")).toContain("cycle aborted");
  expect(h.waits).toEqual([RETRY_LADDER_MS[0]!]);
});

test("loop mode without a key WARNS at start and on every tick, and runs nothing", async () => {
  const h = harness((id) => ok(id));
  // Three ticks, then abort — the loop must keep waiting the normal interval
  // rather than exiting (a non-zero exit under `restart: unless-stopped` is a
  // crash loop) and rather than idling silently forever.
  let ticks = 0;
  h.deps.wait = async () => {
    h.waits.push(CONFIG.intervalMs);
    if (++ticks >= 3) h.controller.abort();
  };
  const code = await runLoop(h.deps, { ...CONFIG, apiKey: null }, h.controller.signal);
  expect(code).toBe(EXIT_OK);
  expect(h.cycles).toBe(0);
  expect(h.waits).toEqual([CONFIG.intervalMs, CONFIG.intervalMs, CONFIG.intervalMs]);

  // One warning at start, then one per completed tick. A process that logged
  // once at startup and then went quiet for a week would be indistinguishable
  // from one that is quietly working.
  const warnings = h.errors.filter((line) => line.includes("WARNING"));
  expect(warnings).toHaveLength(3);
  expect(warnings[0]).toContain("COINGECKO_API_KEY is not set");
});

test("an already-aborted signal runs nothing", async () => {
  const h = harness((id) => ok(id));
  h.controller.abort();
  await runLoop(h.deps, CONFIG, h.controller.signal);
  expect(h.cycles).toBe(0);
  expect(h.waits).toEqual([]);
});
