import { expect, test } from "bun:test";

// The process's own behaviour: exit codes, the missing-key rule, and the loop
// schedule. The database and the clock are fakes — what is under test is the
// control flow an operator sees, not SQL (that is cycle.test.ts).

import { CoinGeckoError, type AssetQuote } from "./src/coingecko.ts";
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
    fetchAsset: async (assetId) => {
      const answer = respond(assetId, state.cycles - 1);
      if (answer instanceof Error) throw answer;
      return answer;
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
  const h = harness((id) =>
    id === "ethereum" ? new CoinGeckoError("boom", "http", "ethereum", 500) : ok(id),
  );
  expect(await runOnce(h.deps, CONFIG)).toBe(EXIT_CYCLE_INCOMPLETE);
});

test("--once exits 2 when a 429 cut the cycle short", async () => {
  const h = harness((id) =>
    id === "bitcoin" ? new CoinGeckoError("429", "rate_limit", "bitcoin", 429) : ok(id),
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
    id === "usdm-2" ? new CoinGeckoError("boom", "http", "usdm-2", 500) : ok(id),
  );
  expect(await runOnce(partial.deps, { ...CONFIG, assetIds: ["bitcoin", "usdm-2"] })).toBe(
    EXIT_CYCLE_INCOMPLETE,
  );
});

test("--once without a key exits 64 and says why, without running a cycle", async () => {
  const h = harness((id) => ok(id));
  expect(await runOnce(h.deps, { ...CONFIG, apiKey: null })).toBe(EXIT_CONFIG);
  expect(h.cycles).toBe(0);
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
  const h = harness(() => new CoinGeckoError("down", "http", "x", 503), { stopAfterCycles: 6 });
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
    cycle === 1 ? ok("x") : new CoinGeckoError("down", "http", "x", 503),
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

test("loop mode without a key idles instead of crash-looping", async () => {
  const h = harness((id) => ok(id));
  // The idle wait is what the abort has to interrupt.
  h.deps.wait = async () => {
    h.waits.push(-1);
  };
  const code = await runLoop(h.deps, { ...CONFIG, apiKey: null }, h.controller.signal);
  expect(code).toBe(EXIT_OK);
  expect(h.cycles).toBe(0);
  expect(h.logs.join("\n")).toContain("idling");
  expect(h.waits).toEqual([-1]);
});

test("an already-aborted signal runs nothing", async () => {
  const h = harness((id) => ok(id));
  h.controller.abort();
  await runLoop(h.deps, CONFIG, h.controller.signal);
  expect(h.cycles).toBe(0);
  expect(h.waits).toEqual([]);
});
