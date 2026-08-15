import { expect, test } from "bun:test";

import {
  PARTIAL_OVERLAP_COINS,
  PARTIAL_OVERLAP_GIVES,
  exactSubsetIndexes,
} from "./p3b-closeout.ts";
import { submitConcurrentlyToBalancer } from "../actors/wallets.ts";

test("T-E2 denominations select {A,B} and {B,C}, with exactly B shared", () => {
  const [offer1, offer2] = PARTIAL_OVERLAP_GIVES.map((amount) =>
    exactSubsetIndexes(PARTIAL_OVERLAP_COINS, amount),
  );
  expect(offer1).toEqual([[0, 1]]);
  expect(offer2).toEqual([[1, 2]]);
  expect(offer1[0]!.filter((i) => offer2[0]!.includes(i))).toEqual([1]);
});

test("T-E5 submitter has both requests in flight before the first receipt", async () => {
  let active = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => (release = resolve));

  const outcome = await submitConcurrentlyToBalancer(
    [{ id: 1 }, { id: 2 }],
    async (tx) => {
      active++;
      if (active === 2) release();
      await bothStarted;
      active--;
      return {
        ok: tx.id === 1,
        status: 200,
        body: tx.id === 1 ? { success: true } : { success: false, error: "double spend" },
      };
    },
  );

  expect(outcome.peakInFlight).toBe(2);
  expect(outcome.allStartedBeforeFirstReceipt).toBe(true);
  expect(outcome.results.filter((result) => result.ok)).toHaveLength(1);
});
