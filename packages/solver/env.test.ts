import { expect, test } from "bun:test";

import { loadSolverRuntimeEnv, parseBooleanEnv, parseBoundedIntegerEnv } from "./env.ts";

const reader = (values: Record<string, string>) => (name: string): string | undefined => values[name];

test("bounded integer parser rejects coercible, zero, negative, and out-of-range values", () => {
  for (const raw of ["", "0", "-1", "1.5", "1e3", "10ms", " 10", "9007199254740992"]) {
    expect(() => parseBoundedIntegerEnv("TEST_LIMIT", raw, 5, 1, 100)).toThrow(/TEST_LIMIT/);
  }
  expect(parseBoundedIntegerEnv("TEST_LIMIT", "100", 5, 1, 100)).toBe(100);
  expect(parseBoundedIntegerEnv("TEST_LIMIT", undefined, 5, 1, 100)).toBe(5);
});

test("boolean parser rejects malformed or ambiguous values", () => {
  expect(parseBooleanEnv("FEATURE", undefined, false)).toBe(false);
  expect(parseBooleanEnv("FEATURE", "true", false)).toBe(true);
  expect(parseBooleanEnv("FEATURE", "false", true)).toBe(false);
  for (const raw of ["TRUE", "False", "1", "yes", " true", ""]) {
    expect(() => parseBooleanEnv("FEATURE", raw, false)).toThrow(/FEATURE/);
  }
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
