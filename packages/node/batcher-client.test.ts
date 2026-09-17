import { expect, test } from "bun:test";

import {
  parseCelestiaWaitReceipt,
  submitBlobViaBatcher,
} from "./batcher-client.ts";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("Celestia wait-receipt requires the pinned complete acknowledgement", () => {
  const valid = {
    success: true,
    message: "Input processed successfully",
    inputsProcessed: 1,
    transactionHash: "celestia-h123",
  };
  expect(parseCelestiaWaitReceipt(valid)).toEqual({ txhash: "celestia-h123", height: "" });
  for (const malformed of [
    {},
    { ...valid, success: false },
    { ...valid, inputsProcessed: 0 },
    { ...valid, message: "" },
    { ...valid, transactionHash: "" },
    { ...valid, transactionHash: "bad hash" },
    { ...valid, transactionHash: "x".repeat(257) },
    null,
    "ok",
  ]) {
    expect(parseCelestiaWaitReceipt(malformed)).toBeNull();
  }
});

test("batcher submission sends bounded wait-receipt request and returns verified identity", async () => {
  let sent: any;
  const result = await submitBlobViaBatcher("swapoffer1test", {
    timeoutMs: 1_500,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      expect(init?.signal).toBeDefined();
      return response({
        success: true,
        message: "Input processed successfully",
        inputsProcessed: 1,
        transactionHash: "ABCDEF0123",
      });
    }) as typeof fetch,
  });
  expect(sent.confirmationLevel).toBe("wait-receipt");
  expect(sent.timeoutMs).toBe(1_000);
  expect(result).toEqual({ txhash: "ABCDEF0123", height: "" });
});

test("successful HTTP with a partial receipt fails closed", async () => {
  await expect(submitBlobViaBatcher("blob", {
    timeoutMs: 1_000,
    fetchImpl: (async () => response({ success: true })) as typeof fetch,
  })).rejects.toThrow("malformed wait-receipt acknowledgement");
});

test("signal-ignoring never-resolving batcher fetch is bounded by the absolute deadline", async () => {
  const started = Date.now();
  await expect(submitBlobViaBatcher("blob", {
    timeoutMs: 1_000,
    fetchImpl: (() => new Promise<Response>(() => undefined)) as typeof fetch,
  })).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(2_500);
});

test("never-ending batcher response body is bounded by the same absolute deadline", async () => {
  const started = Date.now();
  await expect(submitBlobViaBatcher("blob", {
    timeoutMs: 1_000,
    fetchImpl: (async () => new Response(new ReadableStream({
      start() {
        // Deliberately never enqueue or close: Response.text() stays pending
        // and is not coupled to the request AbortSignal in this test double.
      },
    }))) as typeof fetch,
  })).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(2_500);
});
