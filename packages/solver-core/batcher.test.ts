import { expect, test } from "bun:test";

import { ImbalanceUnreadableError, tokenImbalances } from "./batcher.ts";

// Asserted through tokenImbalances rather than nonDustImbalances: another test
// file mock.module()s the batcher, and bun applies that mock process-wide, so a
// test importing the mocked symbol would silently assert against the stub.
const nonDust = (tx: unknown) => tokenImbalances(tx as any).filter((i) => i.tag !== "dust");

// The non-dust imbalance check is the guard that stops the solver handing the
// batcher a merge which spends the makers' inputs without delivering what they
// asked for. It used to swallow every error and return an empty list, so a
// changed SDK shape read as "balanced" — the guard failed OPEN, waving through
// exactly what it exists to stop. These pin it closed.

const entries = (rows: Array<[unknown, bigint]>) => ({ entries: () => rows[Symbol.iterator]() });
const tag = (t: string) => ({ tag: t, raw: "aa" });

const txWith = (bySegment: Record<number, unknown>) => ({
  imbalances: (seg: number) => {
    if (!(seg in bySegment)) throw new Error("no such segment");
    return bySegment[seg];
  },
});

test("a balanced transaction reports no non-dust imbalance", () => {
  const tx = txWith({ 0: entries([[tag("dust"), 500n]]), 1: entries([]) });
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
  expect(() => tokenImbalances(tx as any)).toThrow(/no segment returned a readable/);
});

test("an imbalances() returning an unusable shape throws", () => {
  expect(() => tokenImbalances(txWith({ 0: "not-a-map" }) as any)).toThrow(ImbalanceUnreadableError);
  expect(() => tokenImbalances(txWith({ 0: null }) as any)).toThrow(ImbalanceUnreadableError);
});

test("a non-bigint amount throws rather than being coerced", () => {
  const tx = txWith({ 0: entries([[tag("shielded"), 42 as unknown as bigint]]) });
  expect(() => tokenImbalances(tx as any)).toThrow(/non-bigint/);
});

test("one readable segment is enough — a missing second segment is normal", () => {
  const tx = txWith({ 0: entries([[tag("dust"), 1n]]) });
  expect(nonDust(tx)).toEqual([]);
});
