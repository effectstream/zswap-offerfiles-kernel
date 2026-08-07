import { expect, test } from "bun:test";

import { LadderBook } from "./src/ladder.ts";
import { clipToStock } from "./src/levels-push.ts";
import { Stock } from "./src/stock.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

const LEVELS = [
  { input: "1000", output: "1000" },
  { input: "100000", output: "99000" },
  { input: "1000000", output: "970000" },
];

const ladders = () =>
  LadderBook.fromPairs([
    { tokenIn: A, tokenOut: B, levels: LEVELS },
    { tokenIn: B, tokenOut: A, levels: LEVELS },
  ]);

test("a fully funded solver publishes every rung", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n });
  const pairs = clipToStock(ladders(), stock);
  expect(pairs.length).toBe(2);
  expect(pairs[0].levels.length).toBe(3);
});

test("rungs the solver cannot pay are dropped, not published", () => {
  const stock = new Stock();
  // Enough for the 99000 rung, not the 970000 one.
  stock.setBalances({ [A]: 100_000n, [B]: 100_000n });
  const pairs = clipToStock(ladders(), stock);
  expect(pairs.every((p) => p.levels.length === 2)).toBe(true);
  expect(pairs.every((p) => p.levels.at(-1)!.output === "99000")).toBe(true);
});

test("a pair with nothing affordable is omitted entirely", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 10n });
  const pairs = clipToStock(ladders(), stock);
  // Paying B is unaffordable at every rung, so A→B goes; B→A stays.
  expect(pairs.length).toBe(1);
  expect(pairs[0].tokenIn).toBe(B);
});

test("an in-flight reservation shrinks what is published", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n });
  stock.reserve({ offerHashes: ["h1"], nullifiers: ["n1"], payouts: new Map([[B, 950_000n]]) });
  const aToB = clipToStock(ladders(), stock).find((p) => p.tokenIn === A)!;
  // 50,000 of B left: only the first rung is honourable.
  expect(aToB.levels.length).toBe(1);
});

test("a solver holding nothing publishes nothing", () => {
  expect(clipToStock(ladders(), new Stock())).toEqual([]);
});

test("clipping keeps rungs strictly ascending, so the result stays valid", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 100_000n, [B]: 100_000n });
  for (const pair of clipToStock(ladders(), stock)) {
    for (let i = 1; i < pair.levels.length; i++) {
      expect(BigInt(pair.levels[i].input)).toBeGreaterThan(BigInt(pair.levels[i - 1].input));
    }
  }
});
