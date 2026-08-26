import { afterEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import { ApiRequestError, readExactOfferFiles } from "./api-client.ts";
import {
  EXACT_FILES_PROFILE,
  EXACT_FILES_SCHEMA_VERSION,
  MAX_EXACT_FILES_RESPONSE_BYTES,
  type ExactFilesResponse,
} from "./exact-files-contract.ts";
import {
  OFFER_VALIDATION_SCHEMA_VERSION,
  type OfferValidationVerdict,
} from "./validation-contract.ts";

const BLOB = readFileSync(
  new URL("../validator/fixtures/valid-offer.bech32", import.meta.url),
  "utf8",
).trim();
const ID = createHash("sha256").update(OfferFiles.decode(BLOB)).digest("hex");
const OTHER = "ef".repeat(32);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const verdict = (offerId = ID): OfferValidationVerdict => ({
  schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
  profile: EXACT_FILES_PROFILE,
  valid: true,
  live: true,
  claimedOfferId: offerId,
  computedOfferId: offerId,
  stateVersion: "9",
  validatedAt: "2026-08-20T12:00:00.000Z",
  status: "live",
  code: "VALID",
  computed: {
    gives: [{ token: "00".repeat(32), amount: "1000000", kind: "SHIELDED" }],
    wants: [{ token: "ff".repeat(32), amount: "5000000", kind: "SHIELDED" }],
    inputNullifiers: ["11".repeat(32)],
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
});

const response = (): ExactFilesResponse => ({
  schemaVersion: EXACT_FILES_SCHEMA_VERSION,
  profile: EXACT_FILES_PROFILE,
  files: [{ offerId: ID, verdict: verdict(), offer: BLOB }],
});

async function failure(work: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    return error as ApiRequestError;
  }
  throw new Error("expected request failure");
}

test("job-time exact-files client sends the closed unauthenticated v1 request and binds bytes", async () => {
  let url = "";
  let init: RequestInit | undefined;
  globalThis.fetch = mock(async (input: RequestInfo | URL, request?: RequestInit) => {
    url = String(input);
    init = request;
    return new Response(JSON.stringify(response()));
  }) as typeof fetch;

  expect(await readExactOfferFiles([ID], { api: "http://backend", timeoutMs: 100 }))
    .toEqual(response());
  expect(url).toBe("http://backend/v1/offers/files");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("authorization")).toBeNull();
  expect(JSON.parse(String(init?.body))).toEqual({
    schemaVersion: EXACT_FILES_SCHEMA_VERSION,
    profile: EXACT_FILES_PROFILE,
    offerIds: [ID],
  });
});

test("exact-files client refuses missing, extra, reordered, and byte-mismatched HTTP-200 responses", async () => {
  const malformed: unknown[] = [
    { ...response(), files: [] },
    { ...response(), files: [...response().files, { offerId: OTHER, verdict: verdict(OTHER), offer: BLOB }] },
    { ...response(), files: [{ offerId: OTHER, verdict: verdict(OTHER), offer: BLOB }] },
    { ...response(), files: [{ offerId: ID, verdict: verdict(), offer: OfferFiles.encode(new Uint8Array([1, 2, 3])) }] },
  ];
  let index = 0;
  globalThis.fetch = mock(async () => new Response(JSON.stringify(malformed[index++]))) as typeof fetch;
  for (let attempt = 0; attempt < malformed.length; attempt += 1) {
    expect((await failure(readExactOfferFiles([ID], "http://backend"))).kind).toBe("malformed");
  }
});

test("exact-files client preserves a bound negative verdict for the job executor", async () => {
  const negative: ExactFilesResponse = {
    ...response(),
    files: [{
      offerId: ID,
      verdict: {
        ...verdict(),
        valid: false,
        live: false,
        status: "consumed",
        code: "NOT_LIVE",
        reason: "already consumed",
        computed: undefined,
      },
    }],
  };
  globalThis.fetch = mock(async () => new Response(JSON.stringify(negative))) as typeof fetch;
  expect(await readExactOfferFiles([ID], "http://backend")).toEqual(negative);
});

test("exact-files decoded body cap and absolute timeout fail closed", async () => {
  globalThis.fetch = mock(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(MAX_EXACT_FILES_RESPONSE_BYTES + 1) }),
    body: { cancel: () => Promise.resolve() },
  }) as Response) as typeof fetch;
  expect((await failure(readExactOfferFiles([ID], "http://backend"))).kind).toBe("malformed");

  globalThis.fetch = mock(async () => await new Promise<Response>(() => {})) as typeof fetch;
  const timed = await failure(readExactOfferFiles([ID], { api: "http://backend", timeoutMs: 10 }));
  expect(timed.kind).toBe("timeout");
});
