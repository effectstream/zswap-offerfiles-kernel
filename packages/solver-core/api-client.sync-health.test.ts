import { afterEach, expect, mock, test } from "bun:test";

import {
  ApiRequestError,
  getBackendSyncHealth,
  getZswapsPage,
  MAX_SYNC_HEALTH_BODY_BYTES,
  reportsBackendProjectionCurrent,
} from "./api-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const installFetch = (implementation: typeof fetch): void => {
  globalThis.fetch = implementation;
};

async function failure(promise: Promise<unknown>): Promise<ApiRequestError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiRequestError);
  return caught as ApiRequestError;
}

const healthyResponse = () => ({
  ts: 1_750_800_000_000,
  now: "2025-06-24T00:00:00.000Z",
  status: "ok",
  blockL2: {
    height: "1270",
    timestamp: 1_750_800_000_000,
    block_hash: null,
    main_chain_block_hash: null,
    block_time: 1_000,
    lag: 1,
  },
  ntp: {
    current: 1_270,
    tip: 1_271,
    pct: 99.9,
    lag_blocks: 1,
    lag_seconds: 1,
  },
  midnight: {
    current: 127_000,
    fetched: 127_004,
    tip: 127_010,
    pct: 99.9,
    lag_blocks: 10,
  },
  celestia: {
    current: 12_233_196,
    fetched: 12_233_200,
    tip: 12_233_200,
    pct: 100,
    lag_blocks: 4,
  },
  // These backend diagnostics are deliberately not part of the trusted solver
  // projection. Their presence remains forward-compatible.
  sets: {},
  recent_rejections: [],
});

test("sync health uses the versioned backend route and projects the exact trusted grammar", async () => {
  let requestedUrl = "";
  let requestedAccept = "";
  installFetch(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedAccept = new Headers(init?.headers).get("accept") ?? "";
    return new Response(JSON.stringify(healthyResponse()));
  }) as unknown as typeof fetch);

  const result = await getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 });

  expect(requestedUrl).toBe("http://backend/v1/health/sync");
  expect(requestedAccept).toBe("application/json");
  expect(result).toEqual({
    ts: 1_750_800_000_000,
    status: "ok",
    blockL2: { height: "1270" },
    ntp: {
      current: 1_270,
      tip: 1_271,
      pct: 99.9,
      lagBlocks: 1,
      lagSeconds: 1,
    },
    midnight: {
      current: 127_000,
      fetched: 127_004,
      tip: 127_010,
      pct: 99.9,
      lagBlocks: 10,
    },
    celestia: {
      current: 12_233_196,
      fetched: 12_233_200,
      tip: 12_233_200,
      pct: 100,
      lagBlocks: 4,
    },
  });
  expect(reportsBackendProjectionCurrent(result)).toBe(true);
  expect("sets" in result).toBe(false);
});

test("syncing and error remain explicit fail-closed domain states", async () => {
  const responses = [
    {
      ...healthyResponse(),
      status: "syncing",
      celestia: {
        ...healthyResponse().celestia,
        current: 12_233_195,
        lag_blocks: 5,
      },
    },
    {
      ...healthyResponse(),
      status: "error",
      midnight: {
        current: null,
        fetched: null,
        tip: null,
        pct: null,
        lag_blocks: null,
      },
    },
  ];
  let index = 0;
  installFetch(mock(async () => new Response(JSON.stringify(responses[index++]))) as unknown as typeof fetch);

  expect(reportsBackendProjectionCurrent(await getBackendSyncHealth("http://backend"))).toBe(false);
  expect(reportsBackendProjectionCurrent(await getBackendSyncHealth("http://backend"))).toBe(false);
});

test("sync health accepts the maximum canonical u64 L2 generation", async () => {
  const body = healthyResponse();
  body.blockL2.height = "18446744073709551615";
  installFetch(mock(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch);

  const health = await getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 });
  expect(health.blockL2?.height).toBe("18446744073709551615");
});

for (const [name, mutate, expectedField] of [
  ["an unknown aggregate status", (body: any) => { body.status = "ready"; }, "status"],
  ["a missing protocol object", (body: any) => { delete body.midnight; }, "midnight"],
  ["an unknown top-level field", (body: any) => { body.synced = true; }, "response.synced"],
  ["an unknown protocol field", (body: any) => { body.midnight.lag = 0; }, "midnight.lag"],
  ["a coerced height", (body: any) => { body.celestia.current = "12233196"; }, "celestia.current"],
  ["a negative height", (body: any) => { body.midnight.tip = -1; }, "midnight.tip"],
  ["a non-integer lag", (body: any) => { body.ntp.lag_blocks = 0.5; }, "ntp.lag_blocks"],
  ["a coerced fetched cursor", (body: any) => { body.midnight.fetched = "127004"; }, "midnight.fetched"],
  ["a zero L2 generation", (body: any) => { body.blockL2.height = 0; }, "blockL2.height"],
  [
    "an L2 generation above u64",
    (body: any) => { body.blockL2.height = "18446744073709551616"; },
    "blockL2.height",
  ],
  [
    "an overlong L2 generation token",
    (body: any) => { body.blockL2.height = "1".repeat(1_000); },
    "blockL2.height",
  ],
  ["an ok token without an L2 generation", (body: any) => { body.blockL2 = null; }, "status"],
  [
    "an ok token with an unknown chain position",
    (body: any) => {
      body.celestia.current = null;
      body.celestia.lag_blocks = null;
    },
    "status",
  ],
] as const) {
  test(`sync health rejects ${name}`, async () => {
    const body = healthyResponse();
    mutate(body);
    installFetch(mock(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch);

    const error = await failure(getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 }));
    expect(error.kind).toBe("malformed");
    expect(error.message).toContain(expectedField);
  });
}

test("sync health rejects malformed JSON within the body bound", async () => {
  installFetch(mock(async () => new Response("{not-json")) as unknown as typeof fetch);

  const error = await failure(getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 }));
  expect(error.kind).toBe("malformed");
  expect(error.message).toContain("not valid JSON");
});

test("sync health rejects an oversized declared body before reading it", async () => {
  let bodyRead = false;
  installFetch(mock(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      "content-length": String(MAX_SYNC_HEALTH_BODY_BYTES + 1),
    }),
    get body() {
      bodyRead = true;
      throw new Error("oversized body must not be consumed");
    },
    // A deliberately partial Response: the point of the case is that the
    // reader must refuse on content-length before touching `body`.
  }) as unknown as Response) as unknown as typeof fetch);

  const error = await failure(getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 }));
  expect(error.kind).toBe("malformed");
  expect(error.message).toContain(`${MAX_SYNC_HEALTH_BODY_BYTES}-byte limit`);
  expect(bodyRead).toBe(false);
});

test("sync health cancels a streamed body once its decoded bytes exceed the bound", async () => {
  let cancelled = false;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return;
      sent = true;
      controller.enqueue(new Uint8Array(MAX_SYNC_HEALTH_BODY_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  installFetch(mock(async () => new Response(stream)) as unknown as typeof fetch);

  const error = await failure(getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 }));
  expect(error.kind).toBe("malformed");
  expect(error.message).toContain(`${MAX_SYNC_HEALTH_BODY_BYTES}-byte limit`);
  expect(cancelled).toBe(true);
});

for (const status of [429, 500]) {
  test(`sync health HTTP ${status} is unavailable, never current`, async () => {
    installFetch(mock(async () => new Response("{}", { status })) as unknown as typeof fetch);

    const error = await failure(getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 }));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(status);
  });
}

test("sync health's absolute deadline includes a stalled response body", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({}));
  }) as unknown as typeof fetch);

  const started = Date.now();
  const error = await failure(getBackendSyncHealth({ api: "http://backend", timeoutMs: 20 }));
  expect(error.kind).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(250);
  expect(requestSignal?.aborted).toBe(true);
});

test("sync health's absolute deadline settles a fetch that ignores cancellation", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return await new Promise<Response>(() => {});
  }) as unknown as typeof fetch);

  const started = Date.now();
  const error = await failure(getBackendSyncHealth({ api: "http://backend", timeoutMs: 20 }));
  expect(error.kind).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(250);
  expect(requestSignal?.aborted).toBe(true);
});

test("sync health composes owner cancellation with its deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return await new Promise<Response>(() => {});
  }) as unknown as typeof fetch);
  const owner = new AbortController();
  const pending = getBackendSyncHealth({
    api: "http://backend",
    timeoutMs: 1_000,
    signal: owner.signal,
  });
  owner.abort(new Error("sync generation stopped"));

  const error = await failure(pending);
  expect(error.kind).toBe("aborted");
  expect(requestSignal?.aborted).toBe(true);
});

test("a complete offer page and backend currentness are independent boundaries", async () => {
  const calls: string[] = [];
  const behind = healthyResponse();
  behind.status = "syncing";
  behind.celestia.current -= 1;
  behind.celestia.lag_blocks += 1;
  installFetch(mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/offers?")) {
      return new Response(JSON.stringify({ offers: [], nextCursor: null }));
    }
    if (url.endsWith("/v1/health/sync")) {
      return new Response(JSON.stringify(behind));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch);

  const page = await getZswapsPage({ api: "http://backend", timeoutMs: 100 });
  const health = await getBackendSyncHealth({ api: "http://backend", timeoutMs: 100 });

  expect(page).toEqual({ offers: [], nextCursor: null });
  expect(reportsBackendProjectionCurrent(health)).toBe(false);
  expect(calls).toEqual([
    "http://backend/v1/offers?limit=100",
    "http://backend/v1/health/sync",
  ]);
});
