import { describe, expect, test } from "bun:test";

import {
  accountWholeOfferBalances,
  buildWholeOfferReceipts,
  evaluateWholeOfferPair,
  findSafeWholeOfferMergeOrder,
  MAX_COIN_AMOUNT,
  MAX_SAFE_MERGE_ORDER_WORK,
  MAX_SETTLEMENT_AMOUNT,
  serializeWholeOfferTokenBalances,
  type WholeOfferBalanceSource,
} from "./whole-offer-balance.ts";

const token = (value: number): string => value.toString(16).padStart(64, "0");
const A = token(1);
const B = token(2);
const D = token(4);
const E = token(5);

const source = (
  givesToken: string,
  gives: bigint,
  wantsToken: string,
  wants: bigint,
): WholeOfferBalanceSource => ({
  gives: [{ token: givesToken, amount: gives }],
  wants: [{ token: wantsToken, amount: wants }],
});

describe("whole-offer token accounting", () => {
  test("preserves sorted gross terms and zero-net intermediate tokens", () => {
    const balances = accountWholeOfferBalances([
      source(A.toUpperCase(), 10n, B, 6n),
      source(B, 6n, D, 5n),
    ]);

    expect(balances).toEqual([
      { token: A, gives: 10n, wants: 0n, net: 10n },
      { token: B, gives: 6n, wants: 6n, net: 0n },
      { token: D, gives: 0n, wants: 5n, net: -5n },
    ]);
    expect(serializeWholeOfferTokenBalances(balances)).toEqual([
      { token: A, gives: "10", wants: "0", net: "10" },
      { token: B, gives: "6", wants: "6", net: "0" },
      { token: D, gives: "0", wants: "5", net: "-5" },
    ]);
  });

  test("evaluates net endpoints and rejects every additional deficit", () => {
    const valid = accountWholeOfferBalances([
      source(A, 10n, B, 3n),
      source(B, 6n, D, 5n),
    ]);
    expect(evaluateWholeOfferPair(valid, D, A)).toMatchObject({
      ok: true,
      pair: { tokenIn: D, tokenOut: A, input: 5n, output: 10n },
    });

    const deficit = accountWholeOfferBalances([
      source(A, 20n, B, 8n),
      source(B, 6n, D, 5n),
    ]);
    expect(evaluateWholeOfferPair(deficit, D, A)).toEqual({
      ok: false,
      reason: "additional-deficit",
      token: B,
    });
  });

  test("builds all positive endpoint and intermediate receipts", () => {
    const balances = accountWholeOfferBalances([
      source(A, 10n, B, 3n),
      source(B, 6n, D, 5n),
      source(D, 6n, E, 7n),
    ]);
    expect(buildWholeOfferReceipts(balances, {
      tokenIn: E,
      tokenOut: A,
      input: 8n,
      output: 9n,
    })).toEqual({
      ok: true,
      requiredInput: 7n,
      availableOutput: 10n,
      receipts: [
        { token: A, amount: 1n },
        { token: B, amount: 3n },
        { token: D, amount: 1n },
        { token: E, amount: 1n },
      ],
    });
  });

  test("does not impose an aggregate u128 cap on gross accounting", () => {
    const huge = 1n << 128n;
    const balances = accountWholeOfferBalances([
      source(A, huge, B, huge - 2n),
      source(B, huge - 1n, A, huge - 1n),
    ]);
    expect(balances).toEqual([
      { token: A, gives: huge, wants: huge - 1n, net: 1n },
      { token: B, gives: huge - 1n, wants: huge - 2n, net: 1n },
    ]);
  });

  test("exports separate u128 coin and supported i128 delta ceilings", () => {
    expect(MAX_COIN_AMOUNT).toBe((1n << 128n) - 1n);
    expect(MAX_SETTLEMENT_AMOUNT).toBe((1n << 127n) - 1n);
    expect(MAX_SAFE_MERGE_ORDER_WORK).toBe(1_024);
  });

  test("finds a deterministic safe merge order after the sorted-hash fast path overflows", () => {
    const result = findSafeWholeOfferMergeOrder([
      { offerHash: token(1), ...source(A, 10n, B, 1n) },
      { offerHash: token(2), ...source(A, 1n, B, 1n) },
      { offerHash: token(3), ...source(B, 1n, A, 10n) },
    ], { maximumDelta: 10n });
    expect(result).toEqual({
      ok: true,
      offerHashes: [token(1), token(3), token(2)],
      usedFallback: true,
      work: 4,
    });
  });

  test("distinguishes bounded fallback exhaustion from a proven unsafe order", () => {
    const sources = [
      { offerHash: token(1), ...source(A, 10n, B, 1n) },
      { offerHash: token(2), ...source(A, 1n, B, 1n) },
      { offerHash: token(3), ...source(B, 1n, A, 10n) },
    ];
    expect(findSafeWholeOfferMergeOrder(sources, {
      maximumDelta: 10n,
      maxWork: 0,
    })).toEqual({ ok: false, reason: "merge-order-work-cap", work: 0 });
    expect(findSafeWholeOfferMergeOrder([
      { offerHash: token(1), ...source(A, 10n, B, 1n) },
      { offerHash: token(2), ...source(A, 10n, B, 1n) },
    ], { maximumDelta: 10n })).toMatchObject({
      ok: false,
      reason: "unsafe-merge-order",
    });
  });

  test("does not let exported options raise the eight-maker or signed-delta bounds", () => {
    const one = [{ offerHash: token(1), ...source(A, 1n, B, 1n) }];
    expect(() => findSafeWholeOfferMergeOrder(one, { maxSources: 9 })).toThrow("maxSources");
    expect(() => findSafeWholeOfferMergeOrder(one, {
      maximumDelta: MAX_SETTLEMENT_AMOUNT + 1n,
    })).toThrow("maximumDelta");
    expect(() => findSafeWholeOfferMergeOrder(one, {
      maximumDelta: 1 as unknown as bigint,
    })).toThrow("maximumDelta");
    expect(findSafeWholeOfferMergeOrder(one, { maxWork: 0 })).toMatchObject({
      ok: true,
      usedFallback: false,
      work: 0,
    });
  });

  test("rejects malformed terms and unaffordable or excessive trades", () => {
    expect(() => accountWholeOfferBalances([
      source("not-a-token", 1n, B, 1n),
    ])).toThrow("invalid token id");
    expect(() => accountWholeOfferBalances([
      source(A, 0n, B, 1n),
    ])).toThrow("invalid gives amount");

    const balances = accountWholeOfferBalances([
      source(A, 10n, B, 3n),
      source(B, 6n, D, 5n),
    ]);
    expect(buildWholeOfferReceipts(balances, {
      tokenIn: D,
      tokenOut: A,
      input: 4n,
      output: 10n,
    })).toEqual({ ok: false, reason: "insufficient-input", token: D });
    expect(buildWholeOfferReceipts(balances, {
      tokenIn: D,
      tokenOut: A,
      input: 5n,
      output: 11n,
    })).toEqual({ ok: false, reason: "excess-output", token: A });
  });
});
