import { afterEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import {
  ApiRequestError,
  getOfferStatus,
  getZswapByHash,
  getZswapsPage,
  openSseStream,
} from "./api-client.ts";

const HASH = "a".repeat(64);
const VALID_BLOB = readFileSync(
  new URL("../validator/fixtures/valid-offer.bech32", import.meta.url),
  "utf8",
).trim();
const VALID_HASH = createHash("sha256").update(OfferFiles.decode(VALID_BLOB)).digest("hex");
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
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiRequestError);
  return caught as ApiRequestError;
}

for (const status of [429, 500]) {
  test(`status HTTP ${status} is a typed failure, never a business status`, async () => {
    installFetch(mock(async () => new Response(JSON.stringify({ error: "no" }), { status })) as typeof fetch);

    const err = await failure(getOfferStatus(HASH, { api: "http://node", timeoutMs: 100 }));
    expect(err.kind).toBe("http");
    expect(err.status).toBe(status);
  });
}

test("a network failure remains a typed unknown boundary", async () => {
  installFetch(mock(async () => {
    throw new TypeError("socket offline");
  }) as typeof fetch);

  const err = await failure(getOfferStatus(HASH, { api: "http://node", timeoutMs: 100 }));
  expect(err.kind).toBe("network");
  expect(err.message).toContain("socket offline");
});

test("a fetch that ignores AbortSignal still settles at the absolute deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return await new Promise<Response>(() => {});
  }) as typeof fetch);

  const started = Date.now();
  const err = await failure(getOfferStatus(HASH, { api: "http://node", timeoutMs: 20 }));
  expect(err.kind).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(250);
  expect(requestSignal?.aborted).toBe(true);
});

test("the deadline covers a response body that never finishes", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return {
      ok: true,
      status: 200,
      json: async () => await new Promise<unknown>(() => {}),
    } as Response;
  }) as typeof fetch);

  const err = await failure(getOfferStatus(HASH, { api: "http://node", timeoutMs: 20 }));
  expect(err.kind).toBe("timeout");
  expect(requestSignal?.aborted).toBe(true);
});

test("caller cancellation is composed with the request deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return await new Promise<Response>(() => {});
  }) as typeof fetch);
  const owner = new AbortController();
  const pending = getOfferStatus(HASH, {
    api: "http://node",
    timeoutMs: 1_000,
    signal: owner.signal,
  });
  owner.abort(new Error("owner stopped"));

  const err = await failure(pending);
  expect(err.kind).toBe("aborted");
  expect(requestSignal?.aborted).toBe(true);
});

test("unknown status text is rejected instead of entering the status union", async () => {
  installFetch(mock(async () => new Response(JSON.stringify({ offerId: HASH, status: "LIVE" }))) as typeof fetch);

  const err = await failure(getOfferStatus(HASH, { api: "http://node", timeoutMs: 100 }));
  expect(err.kind).toBe("malformed");
  expect(err.message).toContain("unknown or missing");
});

test("a status response must be bound to the requested offer", async () => {
  installFetch(mock(async () => new Response(JSON.stringify({
    offerId: "b".repeat(64),
    status: "live",
  }))) as typeof fetch);

  const err = await failure(getOfferStatus(HASH, { api: "http://node", timeoutMs: 100 }));
  expect(err.kind).toBe("malformed");
  expect(err.message).toContain("not bound");
});

test("offer detail rejects a non-canonical requested hash before fetch", async () => {
  let fetchCalls = 0;
  installFetch(mock(async () => {
    fetchCalls++;
    throw new Error("must not fetch");
  }) as typeof fetch);

  const err = await failure(getZswapByHash("A".repeat(64), { api: "http://node" }));
  expect(err.kind).toBe("malformed");
  expect(err.message).toContain("lowercase hexadecimal");
  expect(fetchCalls).toBe(0);
});

test("offer detail must carry the requested offerId", async () => {
  installFetch(mock(async () => new Response(JSON.stringify({
    offerId: "b".repeat(64),
    offerBech32: VALID_BLOB,
  }))) as typeof fetch);

  const err = await failure(getZswapByHash(VALID_HASH, { api: "http://node" }));
  expect(err.kind).toBe("malformed");
  expect(err.message).toContain("not bound");
});

test("offer detail rejects a malformed MIP-0005 blob", async () => {
  installFetch(mock(async () => new Response(JSON.stringify({
    offerId: VALID_HASH,
    offerBech32: "not-a-bech32m-offer",
  }))) as typeof fetch);

  const err = await failure(getZswapByHash(VALID_HASH, { api: "http://node" }));
  expect(err.kind).toBe("malformed");
  expect(err.message).toContain("not a valid MIP-0005 blob");
});

test("offer detail rejects a valid blob whose content hash does not match", async () => {
  const bytes = OfferFiles.decode(VALID_BLOB);
  const changed = new Uint8Array(bytes);
  changed[0] ^= 1;
  const wrongBlob = OfferFiles.encode(changed);
  installFetch(mock(async () => new Response(JSON.stringify({
    offerId: VALID_HASH,
    offerBech32: wrongBlob,
  }))) as typeof fetch);

  const err = await failure(getZswapByHash(VALID_HASH, { api: "http://node" }));
  expect(err.kind).toBe("malformed");
  expect(err.message).toContain("content hash does not match");
});

test("list requests check HTTP status instead of parsing an error as a book", async () => {
  installFetch(mock(async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as typeof fetch);

  const err = await failure(getZswapsPage({ api: "http://node", timeoutMs: 100 }));
  expect(err.kind).toBe("http");
  expect(err.status).toBe(500);
});

test("SSE close cancels a long reconnect backoff and awaits lifecycle exit", async () => {
  let fetchCalls = 0;
  let errors = 0;
  installFetch(mock(async () => {
    fetchCalls++;
    return { ok: false, status: 503, body: null } as Response;
  }) as typeof fetch);

  const stream = openSseStream(() => {}, {
    api: "http://node",
    baseBackoffMs: 10_000,
    maxBackoffMs: 10_000,
    onError: () => {
      errors++;
    },
  });
  while (errors === 0) await new Promise((resolve) => setTimeout(resolve, 1));

  const closing = stream.close();
  expect(closing).toBeInstanceOf(Promise);
  await Promise.race([
    closing,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("SSE close left reconnect backoff alive")), 100),
    ),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fetchCalls).toBe(1);
});

test("a clean SSE EOF is reported as a disconnect before reconnect backoff", async () => {
  let opens = 0;
  let disconnects = 0;
  const reader = {
    read: async () => ({ done: true, value: undefined }),
    cancel: async () => {},
    releaseLock: () => {},
  };
  installFetch(mock(async () => ({
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  }) as unknown as Response) as typeof fetch);

  const stream = openSseStream(() => {}, {
    api: "http://node",
    baseBackoffMs: 10_000,
    maxBackoffMs: 10_000,
    onOpen: () => {
      opens++;
    },
    onDisconnect: () => {
      disconnects++;
    },
  });
  while (disconnects === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(opens).toBe(1);
  expect(disconnects).toBe(1);
  await stream.close();
  expect(disconnects).toBe(1);
});

test("SSE close cancels and drains an active read pump with no late event", async () => {
  let fetchCalls = 0;
  let cancelCalls = 0;
  let releaseRead!: (value: ReadableStreamReadResult<Uint8Array>) => void;
  let opened!: () => void;
  const didOpen = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
      releaseRead = resolve;
    }),
    cancel: async () => {
      cancelCalls++;
    },
    releaseLock: () => {},
  };
  installFetch(mock(async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response;
  }) as typeof fetch);

  const events: unknown[] = [];
  const stream = openSseStream((event) => events.push(event), {
    api: "http://node",
    onOpen: opened,
  });
  await didOpen;
  await stream.close();
  expect(cancelCalls).toBe(1);

  releaseRead({
    done: false,
    value: new TextEncoder().encode(
      'data: {"type":"connected","timestamp":1}\n\n',
    ),
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual([]);
  expect(fetchCalls).toBe(1);
});

test("an oversized unterminated SSE frame is discarded and cannot hold close", async () => {
  let fetchCalls = 0;
  let cancelCalls = 0;
  let errors = 0;
  const reader = {
    read: async () => ({
      done: false,
      value: new TextEncoder().encode(`data: ${"x".repeat(64)}`),
    }),
    // Deliberately ignore cancellation. Stream lifecycle ownership must not
    // depend on a cooperative transport.
    cancel: () => {
      cancelCalls++;
      return new Promise<void>(() => {});
    },
    releaseLock: () => {},
  };
  installFetch(mock(async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response;
  }) as typeof fetch);

  const stream = openSseStream(() => {
    throw new Error("unterminated input must never dispatch");
  }, {
    api: "http://node",
    maxFrameBytes: 32,
    baseBackoffMs: 10_000,
    maxBackoffMs: 10_000,
    onError: () => {
      errors++;
    },
  });
  while (errors === 0) await new Promise((resolve) => setTimeout(resolve, 1));

  await Promise.race([
    stream.close(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("oversized SSE frame held close open")), 100),
    ),
  ]);
  expect(fetchCalls).toBe(1);
  expect(cancelCalls).toBe(1);
});

test("SSE rejects an invalid frame limit before opening a connection", () => {
  expect(() => openSseStream(() => {}, { maxFrameBytes: 0 })).toThrow(/positive safe integer/);
  expect(() => openSseStream(() => {}, { maxFrameBytes: Number.POSITIVE_INFINITY })).toThrow(
    /positive safe integer/,
  );
});
