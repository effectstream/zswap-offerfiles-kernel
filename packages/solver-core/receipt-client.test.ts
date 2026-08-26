import { describe, expect, test } from "bun:test";

import {
  MAX_RECEIPT_BODY_BYTES,
  ReceiptRequestError,
  canonicalRelayExtrinsicHash,
  getOfferConsumptionEvidence,
  getRelayJobStatus,
  parseOfferConsumptionResponse,
  parseRelayJobStatus,
} from "./receipt-client.ts";

const OFFER_A = "aa".repeat(32);
const OFFER_B = "bb".repeat(32);
const RELAY_TX = "CC".repeat(32);
const LEDGER_TX = "dd".repeat(32);

const jsonFetch = (body: unknown, init: ResponseInit = {}): typeof fetch =>
  (async () => new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })) as typeof fetch;

describe("relay receipt grammar", () => {
  test("accepts only the pinned exact union and canonicalizes the extrinsic", () => {
    expect(parseRelayJobStatus({ status: "pending" })).toEqual({ status: "pending" });
    expect(parseRelayJobStatus({ status: "solving" })).toEqual({ status: "solving" });
    expect(parseRelayJobStatus({ status: "done", txId: RELAY_TX })).toEqual({
      status: "done",
      txId: `0x${RELAY_TX.toLowerCase()}`,
    });
    expect(parseRelayJobStatus({ status: "error", reason: "rejected" })).toEqual({
      status: "error",
      reason: "rejected",
    });
    expect(canonicalRelayExtrinsicHash(`0x${RELAY_TX}`)).toBe(`0x${RELAY_TX.toLowerCase()}`);
  });

  test("rejects unknown, extra, missing, and malformed terminal fields", () => {
    for (const body of [
      {},
      { status: "unknown" },
      { status: "pending", extra: true },
      { status: "done" },
      { status: "done", txId: "abcd" },
      { status: "done", txId: `0x${RELAY_TX}`, extra: true },
      { status: "error", reason: "" },
      { status: "error", reason: "x", extra: true },
    ]) expect(parseRelayJobStatus(body)).toBeNull();
  });
});

describe("backend consumption grammar", () => {
  test("binds the requested offer and accepts positive evidence only for consumed", () => {
    const positive = {
      version: 1,
      offerId: OFFER_A,
      status: "consumed",
      evidence: { ledgerTxHash: LEDGER_TX, height: 42 },
    };
    expect(parseOfferConsumptionResponse(positive, OFFER_A)).toEqual(positive);
    expect(parseOfferConsumptionResponse({ version: 1, offerId: OFFER_A, status: "live" }, OFFER_A))
      .toEqual({ version: 1, offerId: OFFER_A, status: "live" });
    expect(parseOfferConsumptionResponse(positive, OFFER_B)).toBeNull();
  });

  test("rejects loose envelopes and malformed, misplaced, or partial evidence", () => {
    for (const body of [
      { version: 2, offerId: OFFER_A, status: "live" },
      { version: 1, offerId: OFFER_A, status: "mystery" },
      { version: 1, offerId: OFFER_A, status: "live", extra: true },
      { version: 1, offerId: OFFER_A, status: "live", evidence: { ledgerTxHash: LEDGER_TX, height: 1 } },
      { version: 1, offerId: OFFER_A, status: "consumed", evidence: { ledgerTxHash: LEDGER_TX } },
      { version: 1, offerId: OFFER_A, status: "consumed", evidence: { ledgerTxHash: LEDGER_TX.toUpperCase(), height: 1 } },
      { version: 1, offerId: OFFER_A, status: "consumed", evidence: { ledgerTxHash: LEDGER_TX, height: -1 } },
      { version: 1, offerId: OFFER_A, status: "consumed", evidence: { ledgerTxHash: LEDGER_TX, height: 1, extra: true } },
    ]) expect(parseOfferConsumptionResponse(body, OFFER_A)).toBeNull();
  });
});

describe("bounded receipt clients", () => {
  test("builds the pinned endpoints and returns strict responses", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ status: "done", txId: RELAY_TX }));
    }) as typeof fetch;
    await expect(getRelayJobStatus("job/a", {
      baseUrl: "https://relay.example/api/v1/",
      fetchImpl,
    })).resolves.toEqual({ status: "done", txId: `0x${RELAY_TX.toLowerCase()}` });
    expect(urls).toEqual(["https://relay.example/api/v1/jobs/job%2Fa"]);

    await expect(getOfferConsumptionEvidence(OFFER_A, {
      baseUrl: "https://backend.example/",
      fetchImpl: jsonFetch({
        version: 1,
        offerId: OFFER_A,
        status: "consumed",
        evidence: { ledgerTxHash: LEDGER_TX, height: 9 },
      }),
    })).resolves.toMatchObject({ evidence: { ledgerTxHash: LEDGER_TX, height: 9 } });
  });

  test("HTTP and malformed responses remain typed unknown errors", async () => {
    await expect(getRelayJobStatus("job", {
      baseUrl: "https://relay.example",
      fetchImpl: jsonFetch({ error: "not found" }, { status: 404 }),
    })).rejects.toMatchObject({ kind: "http", status: 404 });
    await expect(getRelayJobStatus("job", {
      baseUrl: "https://relay.example",
      fetchImpl: jsonFetch({ status: "done", txId: "bad" }),
    })).rejects.toMatchObject({ kind: "malformed" });
  });

  test("absolute timeout wins even when a fetch implementation ignores AbortSignal", async () => {
    const never: typeof fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const started = Date.now();
    await expect(getRelayJobStatus("job", {
      baseUrl: "https://relay.example",
      timeoutMs: 10,
      fetchImpl: never,
    })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("rejects declared and streamed bodies over the fixed ceiling", async () => {
    const declared: typeof fetch = (async () => new Response("{}", {
      headers: { "content-length": String(MAX_RECEIPT_BODY_BYTES + 1) },
    })) as typeof fetch;
    await expect(getRelayJobStatus("job", {
      baseUrl: "https://relay.example",
      fetchImpl: declared,
    })).rejects.toBeInstanceOf(ReceiptRequestError);
    await expect(getRelayJobStatus("job", {
      baseUrl: "https://relay.example",
      fetchImpl: (async () => new Response("x".repeat(MAX_RECEIPT_BODY_BYTES + 1))) as typeof fetch,
    })).rejects.toMatchObject({ kind: "malformed" });
  });
});
