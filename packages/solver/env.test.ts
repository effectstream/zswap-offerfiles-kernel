import { expect, test } from "bun:test";

import {
  loadRelayClientEnv,
  loadSolverRelayHttpEnv,
  loadSolverJournalEnv,
  loadSolverAdmissionEnv,
  loadSolverRuntimeEnv,
  parseBooleanEnv,
  parseBoundedIntegerEnv,
  parseSolverRelayHttpUrl,
} from "./env.ts";

const reader = (values: Record<string, string>) => (name: string): string | undefined => values[name];
const A = "a".repeat(64);
const B = "b".repeat(64);

test("relay HTTP authority is explicit, required only for execution, and canonical", () => {
  expect(() => loadSolverRelayHttpEnv(reader({}), { relayExecutionEnabled: true })).toThrow(
    /SOLVER_RELAY_HTTP_URL.*required/,
  );
  expect(loadSolverRelayHttpEnv(reader({}), { relayExecutionEnabled: false })).toBeNull();
  expect(parseSolverRelayHttpUrl("https://relay.example/api/v1/")).toBe(
    "https://relay.example/api/v1",
  );
  expect(loadSolverRelayHttpEnv(
    reader({ SOLVER_RELAY_HTTP_URL: "http://127.0.0.1:13017/api/v1" }),
    { relayExecutionEnabled: true },
  )).toBe("http://127.0.0.1:13017/api/v1");
});

test("relay HTTP authority rejects implicit, ambiguous, or non-HTTP forms", () => {
  for (const raw of [
    "", " ws://relay.example", "ws://relay.example", "wss://relay.example",
    "relay.example", "https://user:pass@relay.example", "https://relay.example?x=1",
    "https://relay.example#fragment", "https://relay.example/api//v1", "https://relay.example\0",
  ]) {
    expect(() => parseSolverRelayHttpUrl(raw)).toThrow(/SOLVER_RELAY_HTTP_URL/);
  }
});

test("bounded integer parser rejects coercible, zero, negative, and out-of-range values", () => {
  for (const raw of ["", "0", "-1", "1.5", "1e3", "10ms", " 10", "9007199254740992"]) {
    expect(() => parseBoundedIntegerEnv("TEST_LIMIT", raw, 5, 1, 100)).toThrow(/TEST_LIMIT/);
  }
  expect(parseBoundedIntegerEnv("TEST_LIMIT", "100", 5, 1, 100)).toBe(100);
  expect(parseBoundedIntegerEnv("TEST_LIMIT", undefined, 5, 1, 100)).toBe(5);
});

test("admission config accepts exact SET grammar and records no OPEN groups", () => {
  const env = loadSolverAdmissionEnv(reader({
    SOLVER_SUPPORTED_PAIRS: JSON.stringify([`${A}->${B}`]),
    SOLVER_MIN_JOB_OUTPUT: JSON.stringify({ [B]: "25" }),
    SOLVER_DUST_MAX_PER_JOB: "7",
    SOLVER_DUST_MAX_PER_WINDOW: "20",
    SOLVER_DUST_WINDOW_MS: "60000",
    SOLVER_ADMISSION_WARNING_INTERVAL_MS: "1234",
  }));
  expect([...env.supportedPairs!]).toEqual([`${A}->${B}`]);
  expect([...env.minJobOutput!]).toEqual([[B, 25n]]);
  expect(env.dust).toEqual({ maxPerJob: 7n, maxPerWindow: 20n, windowMs: 60_000 });
  expect(env.warningIntervalMs).toBe(1234);
  expect(env.openGroups).toEqual([]);
});

test("unset admission groups are OPEN under Q-RF-2 and use the warning default", () => {
  const env = loadSolverAdmissionEnv(reader({}));
  expect(env.supportedPairs).toBeNull();
  expect(env.minJobOutput).toBeNull();
  expect(env.dust).toBeNull();
  expect(env.warningIntervalMs).toBe(900_000);
  expect(env.openGroups).toHaveLength(3);
});

test("admission config fails closed on malformed, noncanonical, duplicate, and partial values", () => {
  for (const values of [
    { SOLVER_SUPPORTED_PAIRS: "not-json" },
    { SOLVER_SUPPORTED_PAIRS: JSON.stringify([`${A.toUpperCase()}->${B}`]) },
    { SOLVER_SUPPORTED_PAIRS: JSON.stringify([`${A}->${A}`]) },
    { SOLVER_SUPPORTED_PAIRS: JSON.stringify([`${A}->${B}`, `${A}->${B}`]) },
    { SOLVER_MIN_JOB_OUTPUT: JSON.stringify({ [B]: 1 }) },
    { SOLVER_MIN_JOB_OUTPUT: JSON.stringify({ [B]: "01" }) },
    { SOLVER_DUST_MAX_PER_JOB: "1" },
    { SOLVER_DUST_MAX_PER_JOB: "0", SOLVER_DUST_MAX_PER_WINDOW: "1", SOLVER_DUST_WINDOW_MS: "1" },
    { SOLVER_DUST_MAX_PER_JOB: "1", SOLVER_DUST_MAX_PER_WINDOW: "1", SOLVER_DUST_WINDOW_MS: "1e3" },
    { SOLVER_ADMISSION_WARNING_INTERVAL_MS: "0" },
  ]) {
    expect(() => loadSolverAdmissionEnv(reader(values))).toThrow();
  }
});

test("boolean parser rejects malformed or ambiguous values", () => {
  expect(parseBooleanEnv("FEATURE", undefined, false)).toBe(false);
  expect(parseBooleanEnv("FEATURE", "true", false)).toBe(true);
  expect(parseBooleanEnv("FEATURE", "false", true)).toBe(false);
  for (const raw of ["TRUE", "False", "1", "yes", " true", ""]) {
    expect(() => parseBooleanEnv("FEATURE", raw, false)).toThrow(/FEATURE/);
  }
});

test("journal config is required for relay execution and uses an absolute durable path", () => {
  expect(() => loadSolverJournalEnv(reader({}), { relayExecutionEnabled: true })).toThrow(
    /SOLVER_JOURNAL_PATH.*required/,
  );
  expect(loadSolverJournalEnv(reader({}), { relayExecutionEnabled: false })).toBeNull();
  expect(
    loadSolverJournalEnv(
      reader({ SOLVER_JOURNAL_PATH: "/var/lib/cow-solver/operations.sqlite" }),
      { relayExecutionEnabled: true },
    ),
  ).toEqual({ path: "/var/lib/cow-solver/operations.sqlite", allowMemory: false });
  for (const path of ["", "relative.sqlite", " /journal.sqlite", "/journal.sqlite ", "/bad\0path"]) {
    expect(() =>
      loadSolverJournalEnv(reader({ SOLVER_JOURNAL_PATH: path }), { relayExecutionEnabled: true }),
    ).toThrow(/SOLVER_JOURNAL_PATH/);
  }
});

test("memory journal requires both canonical flag and explicit test-harness mode", () => {
  expect(() =>
    loadSolverJournalEnv(reader({ SOLVER_JOURNAL_PATH: ":memory:" }), {
      relayExecutionEnabled: true,
      runtimeMode: "test-harness",
    }),
  ).toThrow(/SOLVER_JOURNAL_ALLOW_MEMORY/);
  expect(() =>
    loadSolverJournalEnv(
      reader({ SOLVER_JOURNAL_PATH: ":memory:", SOLVER_JOURNAL_ALLOW_MEMORY: "true" }),
      { relayExecutionEnabled: true },
    ),
  ).toThrow(/test harness/);

  const warnings: string[] = [];
  expect(
    loadSolverJournalEnv(
      reader({ SOLVER_JOURNAL_PATH: ":memory:", SOLVER_JOURNAL_ALLOW_MEMORY: "true" }),
      {
        relayExecutionEnabled: true,
        runtimeMode: "test-harness",
        warn: (message) => warnings.push(message),
      },
    ),
  ).toEqual({ path: ":memory:", allowMemory: true });
  expect(warnings).toEqual([expect.stringContaining("will not survive restart")]);

  expect(() =>
    loadSolverJournalEnv(
      reader({ SOLVER_JOURNAL_PATH: ":memory:", SOLVER_JOURNAL_ALLOW_MEMORY: "TRUE" }),
      { relayExecutionEnabled: true, runtimeMode: "test-harness" },
    ),
  ).toThrow(/expected exactly "true" or "false"/);
  expect(() =>
    loadSolverJournalEnv(
      reader({
        SOLVER_JOURNAL_PATH: "/journal.sqlite",
        SOLVER_JOURNAL_ALLOW_MEMORY: "true",
      }),
      { relayExecutionEnabled: true },
    ),
  ).toThrow(/valid only/);
});

test("throwing memory-journal warning sink is contained", () => {
  expect(() =>
    loadSolverJournalEnv(
      reader({ SOLVER_JOURNAL_PATH: ":memory:", SOLVER_JOURNAL_ALLOW_MEMORY: "true" }),
      {
        relayExecutionEnabled: true,
        runtimeMode: "test-harness",
        warn: () => { throw new Error("logger failed"); },
      },
    ),
  ).not.toThrow();
});

test("runtime config validates expiry and health cross-field bounds", () => {
  expect(() =>
    loadSolverRuntimeEnv(reader({ SOLVER_EXPIRY_MARGIN_SECONDS: "3600", OFFER_TTL_SECONDS: "3600" })),
  ).toThrow(/SOLVER_EXPIRY_MARGIN_SECONDS.*OFFER_TTL_SECONDS/);
  expect(() =>
    loadSolverRuntimeEnv(
      reader({
        SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS: "15000",
        SOLVER_BACKEND_HEALTH_MAX_AGE_MS: "15000",
      }),
    ),
  ).toThrow(/SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS.*SOLVER_BACKEND_HEALTH_MAX_AGE_MS/);
});

test("runtime config accepts the bounded defaults", () => {
  expect(loadSolverRuntimeEnv(reader({}))).toMatchObject({
    maxCycleLen: 3,
    resyncIntervalMs: 300_000,
    backendHealthCheckIntervalMs: 5_000,
    backendHealthMaxAgeMs: 15_000,
    expiryMarginSeconds: 120,
    settleTtlMinutes: 30,
    statusPollMs: 5_000,
  });
});

test("every bounded runtime variable rejects malformed startup input by name", () => {
  for (const name of [
    "SOLVER_MAX_CYCLE_LEN",
    "SOLVER_RESYNC_INTERVAL_MS",
    "SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS",
    "SOLVER_BACKEND_HEALTH_MAX_AGE_MS",
    "SOLVER_EXPIRY_MARGIN_SECONDS",
    "OFFER_TTL_SECONDS",
    "SOLVER_SETTLE_TTL_MINUTES",
    "SOLVER_STATUS_POLL_MS",
  ]) {
    expect(() => loadSolverRuntimeEnv(reader({ [name]: "not-an-integer" }))).toThrow(name);
  }
});

test("relay client config accepts the bounded defaults", () => {
  expect(loadRelayClientEnv(reader({}))).toEqual({
    // FR-012's two contract cadences.
    pushIntervalMs: 1_000,
    reconnectDelayMs: 2_000,
    connectTimeoutMs: 10_000,
    withdrawTimeoutMs: 2_000,
    maxParallelSwaps: 8,
  });
  expect(
    loadRelayClientEnv(reader({ SOLVER_RELAY_PUSH_INTERVAL_MS: "250" })).pushIntervalMs,
  ).toBe(250);
});

test("every bounded relay variable rejects malformed startup input by name", () => {
  for (const name of [
    "SOLVER_RELAY_PUSH_INTERVAL_MS",
    "SOLVER_RELAY_RECONNECT_DELAY_MS",
    "SOLVER_RELAY_CONNECT_TIMEOUT_MS",
    "SOLVER_RELAY_WITHDRAW_TIMEOUT_MS",
    "SOLVER_RELAY_MAX_PARALLEL_SWAPS",
  ]) {
    expect(() => loadRelayClientEnv(reader({ [name]: "not-an-integer" }))).toThrow(name);
    expect(() => loadRelayClientEnv(reader({ [name]: "0" }))).toThrow(name);
  }
});
