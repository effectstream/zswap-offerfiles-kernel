import { afterEach, expect, mock, test } from "bun:test";

import {
  getBackendSyncHealth,
  reportsBackendProjectionCurrent,
} from "@zswap-da/solver-core/api-client";
import { startBookSync } from "./src/sse-sync.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("REST/SSE book readiness remains blocked while the backend reports syncing", async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    ts: 1_750_800_000_000,
    status: "syncing",
    blockL2: { height: 1 },
    ntp: {
      current: 1,
      tip: 1,
      pct: 100,
      lag_blocks: 0,
      lag_seconds: 0,
    },
    midnight: {
      current: 100,
      fetched: 100,
      tip: 100,
      pct: 100,
      lag_blocks: 0,
    },
    celestia: {
      current: 100,
      fetched: 100,
      tip: 105,
      pct: 95.2,
      lag_blocks: 5,
    },
  }))) as typeof fetch;

  const dependencies = {
    getZswapsPage: async () => ({ offers: [], nextCursor: null }),
    getZswapByHash: async () => {
      throw new Error("empty snapshot must not fetch detail");
    },
    getBackendSyncHealth,
    openSseStream: (
      _onEvent: (event: unknown) => void,
      options: { onOpen?: () => void },
    ) => {
      options.onOpen?.();
      return { close: async () => {} };
    },
  } as any;

  const sync = startBookSync({
    api: "http://backend",
    dependencies,
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 1_000,
  });
  let readySettled = false;
  const observedReady = sync.ready.then(
    () => { readySettled = true; },
    (error) => { readySettled = true; return error; },
  );
  try {
    const health = await getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sync.book.size).toBe(0);
    expect(reportsBackendProjectionCurrent(health)).toBe(false);
    expect(sync.isCurrent()).toBe(false);
    expect(readySettled).toBe(false);
  } finally {
    await sync.stop();
  }
  expect(await observedReady).toBeInstanceOf(Error);
});
