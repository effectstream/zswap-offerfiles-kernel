import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { Transaction } from "@midnight-ntwrk/ledger-v8";

import {
  declaredLedgerSegments,
  BatcherRequestTimeoutError,
  ImbalanceUnreadableError,
  parseBatcherAcknowledgement,
  settleViaBatcher,
  tokenImbalances,
} from "./batcher.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const installFetch = (implementation: typeof fetch): void => {
  globalThis.fetch = implementation;
};

// Asserted through tokenImbalances so the test pins the primitive enumeration
// independently of the small nonDustImbalances filter.
const nonDust = (tx: unknown) => tokenImbalances(tx as any).filter((i) => i.tag !== "dust");

// The non-dust imbalance check is the guard that stops the solver handing the
// batcher a merge which spends the makers' inputs without delivering what they
// asked for. It used to swallow every error and return an empty list, so a
// changed SDK shape read as "balanced" — the guard failed OPEN, waving through
// exactly what it exists to stop. These pin it closed.

const entries = (rows: Array<[unknown, bigint]>) => new Map(rows);
const tag = (t: string) => ({ tag: t, raw: "aa" });

const settleableTx = () => ({
  intents: new Map(),
  fallibleOffer: new Map(),
  imbalances: () => entries([[tag("dust"), 1n]]),
  serialize: () => new Uint8Array([0xab]),
});

const txWith = (
  bySegment: Record<number, unknown>,
  declarations: { intents?: number[]; fallibleOffer?: number[] } = {},
) => ({
  intents: new Map((declarations.intents ?? []).map((seg) => [seg, {}])),
  fallibleOffer: new Map((declarations.fallibleOffer ?? []).map((seg) => [seg, {}])),
  imbalances: (seg: number) => {
    if (!(seg in bySegment)) throw new Error("no such segment");
    return bySegment[seg];
  },
});

test("a balanced transaction reports no non-dust imbalance", () => {
  const tx = txWith({ 0: entries([[tag("dust"), 500n]]) });
  expect(nonDust(tx)).toEqual([]);
});

test("a non-dust imbalance is reported", () => {
  const tx = txWith({ 0: entries([[tag("shielded"), 42n]]) });
  const found = nonDust(tx);
  expect(found.length).toBe(1);
  expect(found[0].amount).toBe(42n);
});

test("zero entries are not imbalances", () => {
  const tx = txWith({ 0: entries([[tag("shielded"), 0n]]) });
  expect(nonDust(tx)).toEqual([]);
});

test("a transaction exposing no imbalances() throws instead of reading as balanced", () => {
  expect(() => tokenImbalances({} as any)).toThrow(ImbalanceUnreadableError);
  expect(() => tokenImbalances(null as any)).toThrow(ImbalanceUnreadableError);
});

test("a throwing imbalances() throws instead of reading as balanced", () => {
  const tx = {
    imbalances: () => {
      throw new Error("SDK changed");
    },
  };
  expect(() => tokenImbalances(tx as any)).toThrow(/declared segment 0 could not be read/);
});

test("an imbalances() returning an unusable shape throws", () => {
  expect(() => tokenImbalances(txWith({ 0: "not-a-map" }) as any)).toThrow(ImbalanceUnreadableError);
  expect(() => tokenImbalances(txWith({ 0: null }) as any)).toThrow(ImbalanceUnreadableError);
});

test("a non-bigint amount throws rather than being coerced", () => {
  const tx = txWith({ 0: entries([[tag("shielded"), 42 as unknown as bigint]]) });
  expect(() => tokenImbalances(tx as any)).toThrow(/non-bigint/);
});

test("arbitrary declared intent and fallible segments are all enumerated", () => {
  const tx = txWith(
    {
      0: entries([[tag("dust"), 1n]]),
      7: entries([[tag("shielded"), 2n]]),
      65_000: entries([[tag("unshielded"), -2n]]),
    },
    { intents: [7], fallibleOffer: [65_000] },
  );
  expect(declaredLedgerSegments(tx as any)).toEqual([0, 7, 65_000]);
  expect(nonDust(tx).map((i) => [i.seg, i.amount])).toEqual([[7, 2n], [65_000, -2n]]);
});

test("a serialized ledger-v8 offer round-trip exposes every declared segment to the guard", () => {
  const blob = readFileSync(
    new URL("../validator/fixtures/valid-offer.bech32", import.meta.url),
    "utf8",
  ).trim();
  const parsed = Transaction.deserialize("signature", "proof", "binding", OfferFiles.decode(blob));
  const restored = Transaction.deserialize("signature", "proof", "binding", parsed.serialize());
  const expected = [
    0,
    ...(restored.intents?.keys() ?? []),
    ...(restored.fallibleOffer?.keys() ?? []),
  ].filter((segment, index, all) => all.indexOf(segment) === index).sort((a, b) => a - b);

  expect(declaredLedgerSegments(restored)).toEqual(expected);
  expect(() => tokenImbalances(restored)).not.toThrow();
});

test("one unreadable declared segment fails the entire guard closed", () => {
  const tx = txWith({ 0: entries([]), 7: entries([]) }, { intents: [7], fallibleOffer: [9] });
  expect(() => tokenImbalances(tx as any)).toThrow(/declared segment 9 could not be read/);
});

test("malformed ledger segment declarations are rejected", () => {
  expect(() => declaredLedgerSegments({ intents: [7], imbalances: () => entries([]) } as any)).toThrow(
    /not a keyed collection/,
  );
  expect(() =>
    declaredLedgerSegments({ intents: new Map([[65_536, {}]]), imbalances: () => entries([]) } as any),
  ).toThrow(/invalid ledger segment/);
});

test("unknown token tags are not silently classified as non-dust", () => {
  expect(() => tokenImbalances(txWith({ 0: entries([[tag("new-sdk-tag"), 1n]]) }) as any)).toThrow(
    /unknown token tag/,
  );
});

test("batcher acknowledgement requires the exact documented success shape", () => {
  const hash = "ab".repeat(32);
  expect(parseBatcherAcknowledgement({ success: true, message: "Input accepted", inputsProcessed: 1, transactionHash: `0x${hash}` })).toEqual({
    success: true,
    message: "Input accepted",
    inputsProcessed: 1,
    transactionHash: `0x${hash}`,
  });
  for (const body of [
    {},
    { success: true, message: "Input accepted" },
    { success: true, message: "Input accepted", inputsProcessed: 0, transactionHash: hash },
    { success: false, message: "Input accepted", inputsProcessed: 1, transactionHash: hash },
    { success: true, message: "Input accepted", inputsProcessed: 1, transactionHash: "wrong-hash" },
    "success",
    null,
  ]) {
    expect(parseBatcherAcknowledgement(body)).toBeNull();
  }
});

test("no-wait queue acknowledgement is explicit but does not impersonate a receipt", () => {
  expect(parseBatcherAcknowledgement({ success: true, message: "Input queued", inputsProcessed: 1 }, "no-wait")).toEqual({
    success: true,
    message: "Input queued",
    inputsProcessed: 1,
  });
  expect(parseBatcherAcknowledgement({ success: true, message: "Input queued" }, "no-wait")).toBeNull();
  expect(parseBatcherAcknowledgement({ success: true }, "no-wait")).toBeNull();
  expect(parseBatcherAcknowledgement({ success: false, message: "Input queued", inputsProcessed: 1 }, "no-wait")).toBeNull();
});

test("batcher deadline settles and aborts when fetch ignores its signal", async () => {
  let requestSignal: AbortSignal | undefined;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return await new Promise<Response>(() => {});
  }) as typeof fetch);

  const started = Date.now();
  let caught: unknown;
  try {
    await settleViaBatcher(settleableTx() as any, { timeoutMs: 20 });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(BatcherRequestTimeoutError);
  expect(Date.now() - started).toBeLessThan(250);
  expect(requestSignal?.aborted).toBe(true);
});

test("batcher deadline covers body consumption and safely observes cancellation", async () => {
  let requestSignal: AbortSignal | undefined;
  let cancelCalls = 0;
  installFetch(mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return {
      ok: true,
      status: 200,
      text: async () => await new Promise<string>(() => {}),
      body: {
        cancel: () => {
          cancelCalls++;
          return Promise.reject(new Error("body is locked"));
        },
      },
    } as unknown as Response;
  }) as typeof fetch);

  let caught: unknown;
  try {
    await settleViaBatcher(settleableTx() as any, { timeoutMs: 20 });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(BatcherRequestTimeoutError);
  expect(requestSignal?.aborted).toBe(true);
  expect(cancelCalls).toBe(1);
  await Promise.resolve();
});

test("batcher timeout must be positive and finite", async () => {
  for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    await expect(settleViaBatcher(settleableTx() as any, { timeoutMs })).rejects.toThrow(RangeError);
  }
});
