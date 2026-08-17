import { expect, test } from "bun:test";

import type { BackendSyncHealth } from "@zswap-da/solver-core/api-client";
import {
  deriveSolverReadiness,
  type SolverReadinessSignals,
} from "./src/readiness-state.ts";

const backend: BackendSyncHealth = {
  ts: 1_750_800_000_000,
  status: "ok",
  blockL2: { height: "1270" },
  ntp: { current: 1_270, tip: 1_270, pct: 100, lagBlocks: 0, lagSeconds: 0 },
  midnight: { current: 100, fetched: 100, tip: 100, pct: 100, lagBlocks: 0 },
  celestia: { current: 200, fetched: 200, tip: 200, pct: 100, lagBlocks: 0 },
};

const readySignals = (): SolverReadinessSignals => ({
  backend,
  streamGeneration: 3,
  streamConnected: true,
  snapshotGeneration: 3,
  inventoryReady: true,
  validationGeneration: { streamGeneration: 3, backendBlockL2: "1270" },
});

test("the combined readiness state carries both stream and backend generations", () => {
  expect(deriveSolverReadiness(readySignals())).toEqual({
    kind: "ready",
    streamGeneration: 3,
    backendBlockL2: "1270",
  });
});

const blockedCases: Array<{
  name: string;
  mutate: (signals: SolverReadinessSignals) => void;
  reason: string;
}> = [
  {
    name: "backend transport is unavailable",
    mutate: (signals) => { signals.backend = null; },
    reason: "backend-unavailable",
  },
  {
    name: "backend reports syncing",
    mutate: (signals) => { signals.backend = { ...backend, status: "syncing" }; },
    reason: "backend-not-current",
  },
  {
    name: "backend has no merged L2 generation",
    mutate: (signals) => { signals.backend = { ...backend, blockL2: null }; },
    reason: "backend-not-current",
  },
  {
    name: "stream is disconnected",
    mutate: (signals) => { signals.streamConnected = false; },
    reason: "stream-disconnected",
  },
  {
    name: "stream generation is not established",
    mutate: (signals) => { signals.streamGeneration = 0; },
    reason: "stream-disconnected",
  },
  {
    name: "snapshot belongs to an older stream",
    mutate: (signals) => { signals.snapshotGeneration = 2; },
    reason: "snapshot-incomplete",
  },
  {
    name: "inventory is unavailable",
    mutate: (signals) => { signals.inventoryReady = false; },
    reason: "inventory-unready",
  },
  {
    name: "validation is unavailable",
    mutate: (signals) => { signals.validationGeneration = null; },
    reason: "validation-unavailable",
  },
  {
    name: "validation belongs to an older stream generation",
    mutate: (signals) => {
      signals.validationGeneration = { streamGeneration: 2, backendBlockL2: "1270" };
    },
    reason: "validation-unavailable",
  },
  {
    name: "validation belongs to another backend L2 generation",
    mutate: (signals) => {
      signals.validationGeneration = { streamGeneration: 3, backendBlockL2: "1269" };
    },
    reason: "validation-unavailable",
  },
];

for (const { name, mutate, reason } of blockedCases) {
  test(`readiness is blocked when ${name}`, () => {
    const signals = readySignals();
    mutate(signals);
    expect(deriveSolverReadiness(signals)).toEqual({
      kind: "blocked",
      reason,
      streamGeneration: signals.streamGeneration,
    });
  });
}
