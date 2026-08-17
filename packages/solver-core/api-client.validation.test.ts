import { afterEach, expect, mock, test } from "bun:test";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ApiRequestError,
  MAX_OFFER_VALIDATION_RESPONSE_BYTES,
  validateOfferForUse,
} from "./api-client.ts";
import {
  OFFER_VALIDATION_PROFILE,
  OFFER_VALIDATION_SCHEMA_VERSION,
  type OfferValidationVerdict,
} from "./validation-contract.ts";

const VALID_BLOB = readFileSync(
  new URL("../validator/fixtures/valid-offer.bech32", import.meta.url),
  "utf8",
).trim();
const VALID_HASH = createHash("sha256").update(OfferFiles.decode(VALID_BLOB)).digest("hex");
const OTHER_HASH = "f".repeat(64);
const AUTH = "solver-validation-secret";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const installFetch = (implementation: typeof fetch): void => {
  globalThis.fetch = implementation;
};

const validVerdict = (): OfferValidationVerdict => ({
  schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
  profile: OFFER_VALIDATION_PROFILE,
  valid: true,
  live: true,
  claimedOfferId: VALID_HASH,
  computedOfferId: VALID_HASH,
  stateVersion: "42",
  validatedAt: new Date().toISOString(),
  status: "live",
  code: "VALID",
  computed: {
    gives: [{ token: "01".repeat(32), amount: "100", kind: "SHIELDED" }],
    wants: [{ token: "02".repeat(32), amount: "200", kind: "SHIELDED" }],
    inputNullifiers: ["03".repeat(32)],
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
});

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

test("validate-for-use binds local bytes before an authenticated exact v1 request", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const expectedVerdict = validVerdict();
  installFetch(mock(async (input: RequestInfo | URL, request?: RequestInit) => {
    url = String(input);
    init = request;
    return new Response(JSON.stringify(expectedVerdict));
  }) as typeof fetch);

  const verdict = await validateOfferForUse(VALID_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
    timeoutMs: 100,
  });

  expect(url).toBe("http://backend/v1/offers/validate");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${AUTH}`);
  expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  expect(new Headers(init?.headers).get("accept")).toBe("application/json");
  expect(JSON.parse(String(init?.body))).toEqual({
    schemaVersion: 1,
    profile: OFFER_VALIDATION_PROFILE,
    offerId: VALID_HASH,
    offer: VALID_BLOB,
  });
  expect(verdict).toEqual(expectedVerdict);
});

test("validate-for-use refuses a local blob/hash mismatch before fetch", async () => {
  let fetchCalls = 0;
  installFetch(mock(async () => {
    fetchCalls++;
    throw new Error("must not fetch");
  }) as typeof fetch);

  const error = await failure(validateOfferForUse(OTHER_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
  }));
  expect(error.kind).toBe("malformed");
  expect(error.message).toContain("content hash does not match");
  expect(fetchCalls).toBe(0);
});

test("validate-for-use refuses a missing or malformed solver bearer before fetch", async () => {
  let fetchCalls = 0;
  installFetch(mock(async () => {
    fetchCalls++;
    throw new Error("must not fetch");
  }) as typeof fetch);

  for (const authToken of ["", "short", "contains whitespace"]) {
    const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
      api: "http://backend",
      authToken,
    }));
    expect(error.kind).toBe("malformed");
  }
  expect(fetchCalls).toBe(0);
});

test("a closed HTTP-200 negative remains a bound domain verdict", async () => {
  const expired: OfferValidationVerdict = {
    ...validVerdict(),
    valid: false,
    live: false,
    status: "live",
    code: "EXPIRED",
    reason: "expired before archival",
    computed: undefined,
  };
  installFetch(mock(async () => new Response(JSON.stringify(expired))) as typeof fetch);

  const verdict = await validateOfferForUse(VALID_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
  });
  expect(verdict).toMatchObject({ valid: false, live: false, status: "live", code: "EXPIRED" });
});

for (const [name, verdict, expected] of [
  [
    "profile echo",
    {
      ...validVerdict(),
      profile: "future-profile-v2",
      valid: false,
      live: false,
      computedOfferId: null,
      status: "unknown",
      code: "UNSUPPORTED_PROFILE",
      computed: undefined,
    },
    "profile",
  ],
  [
    "claimed identity",
    { ...validVerdict(), claimedOfferId: OTHER_HASH, computedOfferId: OTHER_HASH },
    "claimedOfferId",
  ],
  [
    "computed identity",
    {
      ...validVerdict(),
      valid: false,
      live: false,
      computedOfferId: OTHER_HASH,
      status: "unknown",
      code: "HASH_MISMATCH",
      computed: undefined,
    },
    "computedOfferId",
  ],
] as const) {
  test(`validate-for-use rejects a verdict with the wrong ${name}`, async () => {
    installFetch(mock(async () => new Response(JSON.stringify(verdict))) as typeof fetch);
    const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
      api: "http://backend",
      authToken: AUTH,
    }));
    expect(error.kind).toBe("malformed");
    expect(error.message).toContain(expected);
  });
}

test("validate-for-use rejects malformed JSON and unknown verdict fields", async () => {
  const responses = [
    new Response("{not-json"),
    new Response(JSON.stringify({ ...validVerdict(), surprise: true })),
  ];
  let index = 0;
  installFetch(mock(async () => responses[index++]) as typeof fetch);

  for (let attempt = 0; attempt < responses.length; attempt++) {
    const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
      api: "http://backend",
      authToken: AUTH,
    }));
    expect(error.kind).toBe("malformed");
  }
});

for (const status of [400, 401, 404, 413, 429, 500, 503]) {
  test(`validate-for-use HTTP ${status} is unavailable, never a domain verdict`, async () => {
    installFetch(mock(async () => new Response("{}", { status })) as typeof fetch);
    const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
      api: "http://backend",
      authToken: AUTH,
    }));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(status);
  });
}

test("validate-for-use network failure is unavailable, never a domain verdict", async () => {
  installFetch(mock(async () => { throw new Error("connection refused"); }) as typeof fetch);
  const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
  }));
  expect(error.kind).toBe("network");
});

test("validate-for-use rejects an oversized declared response before body consumption", async () => {
  let bodyRead = false;
  installFetch(mock(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      "content-length": String(MAX_OFFER_VALIDATION_RESPONSE_BYTES + 1),
    }),
    get body() {
      bodyRead = true;
      throw new Error("must not read oversized response");
    },
  }) as Response) as typeof fetch);

  const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
  }));
  expect(error.kind).toBe("malformed");
  expect(error.message).toContain(`${MAX_OFFER_VALIDATION_RESPONSE_BYTES}-byte limit`);
  expect(bodyRead).toBe(false);
});

test("validate-for-use cancels a streamed response over the decoded-byte cap", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(MAX_OFFER_VALIDATION_RESPONSE_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  installFetch(mock(async () => new Response(body)) as typeof fetch);

  const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
  }));
  expect(error.kind).toBe("malformed");
  expect(cancelled).toBe(true);
});

test("validate-for-use deadline covers a response body that never finishes", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({}));
  }) as typeof fetch);

  const error = await failure(validateOfferForUse(VALID_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
    timeoutMs: 20,
  }));
  expect(error.kind).toBe("timeout");
  expect(requestSignal?.aborted).toBe(true);
});

test("validate-for-use composes owner cancellation", async () => {
  installFetch(mock(async () => await new Promise<Response>(() => {})) as typeof fetch);
  const owner = new AbortController();
  const pending = validateOfferForUse(VALID_HASH, VALID_BLOB, {
    api: "http://backend",
    authToken: AUTH,
    timeoutMs: 1_000,
    signal: owner.signal,
  });
  owner.abort(new Error("validation generation superseded"));

  const error = await failure(pending);
  expect(error.kind).toBe("aborted");
});
