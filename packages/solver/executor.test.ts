import { expect, mock, test } from "bun:test";

import type { BookOffer } from "./src/book.ts";
import { Executor, type WalletLike } from "./src/executor.ts";
import { Stock } from "./src/stock.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

// The executor reads status and blobs through the api-client module; the offers
// below always carry a blob so only status has to be stubbed.
const statusByHash = new Map<string, string[]>();
mock.module("@zswap-da/solver-core/api-client", () => ({
  getOfferStatus: async (hash: string) => {
    const queue = statusByHash.get(hash) ?? ["live"];
    const status = queue.length > 1 ? queue.shift()! : queue[0];
    return { offerId: hash, status };
  },
  getZswapByHash: async (hash: string) => ({ offerBech32: `blob-${hash}` }),
  reconstructOffer: (blob: string) => ({ blob }),
}));

/** Batcher stub. `imbalance` drives the fund-loss guard; `results` queues the
 *  batcher's replies so retry behaviour can be driven. */
const batcher = {
  imbalance: [] as unknown[],
  results: [] as Array<{ ok: boolean; status: number; body: unknown }>,
  settleCalls: 0,
  merged: [] as unknown[],
  imbalanceThrows: null as Error | null,
};

mock.module("@zswap-da/solver-core/batcher", () => ({
  mergeFinalized: (txs: unknown[]) => {
    batcher.merged = txs;
    return { merged: txs };
  },
  nonDustImbalances: () => {
    if (batcher.imbalanceThrows) throw batcher.imbalanceThrows;
    return batcher.imbalance;
  },
  // Mirrors the real helper, which stringifies amounts before serialising —
  // JSON.stringify throws outright on a BigInt.
  describeImbalances: () =>
    JSON.stringify(batcher.imbalance.map((i) => ({ ...(i as object), amount: String((i as any).amount) }))),
  settleViaBatcher: async () => {
    batcher.settleCalls++;
    return batcher.results.length > 1
      ? batcher.results.shift()!
      : (batcher.results[0] ?? { ok: true, status: 200, body: { success: true } });
  },
}));

const resetBatcher = () => {
  batcher.imbalance = [];
  batcher.results = [];
  batcher.settleCalls = 0;
  batcher.merged = [];
  batcher.imbalanceThrows = null;
};

const offer = (hash: string, nullifiers = [`n-${hash}`]): BookOffer => ({
  offerHash: hash,
  gives: [{ token: A, amount: 1000n, kind: "SHIELDED" }],
  wants: [{ token: B, amount: 900n, kind: "SHIELDED" }],
  expiresAt: null,
  firstSeenAt: null,
  inputNullifiers: nullifiers,
  blob: `blob-${hash}`,
});

const payout = (amount = 900n) => new Map([[B, amount]]);

function walletStub(overrides: Partial<WalletLike> = {}) {
  const calls = { balanced: 0, submitted: 0, reverted: 0 };
  const wallet: WalletLike = {
    balanceFinalizedTransaction: async () => {
      calls.balanced++;
      return { recipe: true };
    },
    finalizeRecipe: async (r) => r,
    submitTransaction: async () => {
      calls.submitted++;
    },
    revert: async () => {
      calls.reverted++;
    },
    ...overrides,
  };
  return { wallet, calls };
}

/** A funded stock: reserve() refuses payouts the solver cannot cover, so a test
 *  that means to exercise execution has to hold the inventory it promises. */
const fundedStock = (): Stock => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n });
  return stock;
};

const makeExecutor = (wallet: WalletLike, stock = fundedStock()) =>
  new Executor({ wallet, keys: {}, stock, statusPollMs: 1, confirmTimeoutMs: 200 });

test("a fill settles once the offer leaves the book", async () => {
  statusByHash.set("h1", ["live", "consumed"]);
  const { wallet, calls } = walletStub();
  const stock = new Stock();
  stock.setBalances({ [B]: 10_000n });

  const outcome = await makeExecutor(wallet, stock).fill(offer("h1"), payout());
  expect(outcome).toEqual({ kind: "settled", offerHash: "h1" });
  expect(calls.submitted).toBe(1);
  expect(calls.reverted).toBe(0);
  // The claim is released, so the budget is whole again.
  expect(stock.available(B)).toBe(10_000n);
});

test("an offer taken by someone else between admission and dequeue is skipped, not filled", async () => {
  statusByHash.set("h2", ["consumed"]);
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet).fill(offer("h2"), payout());
  expect(outcome.kind).toBe("skipped");
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
});

test("a failed submit reverts before retrying, so the retry can fund itself", async () => {
  statusByHash.set("h3", ["live"]);
  let attempts = 0;
  const { wallet, calls } = walletStub({
    submitTransaction: async () => {
      attempts++;
      if (attempts === 1) throw new Error("submission rejected");
    },
  });

  const outcome = await makeExecutor(wallet).fill(offer("h3"), payout());
  expect(outcome.kind).toBe("failed");
  // Never confirmed (status stays live), but the important part is that the
  // abandoned first balance was reverted before the second attempt.
  expect(calls.reverted).toBeGreaterThanOrEqual(1);
  expect(calls.balanced).toBe(2);
});

test("retries stop once the offer is no longer live", async () => {
  statusByHash.set("h4", ["live", "cancelled"]);
  const { wallet, calls } = walletStub({
    submitTransaction: async () => {
      throw new Error("submission rejected");
    },
  });

  const outcome = await makeExecutor(wallet).fill(offer("h4"), payout());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("cancelled");
  expect(calls.balanced).toBe(1);
  expect(calls.reverted).toBe(1);
});

test("a revert that itself throws does not mask the original failure", async () => {
  statusByHash.set("h5", ["live"]);
  const logged: string[] = [];
  const { wallet } = walletStub({
    submitTransaction: async () => {
      throw new Error("submission rejected");
    },
    revert: async () => {
      throw new Error("revert exploded");
    },
  });
  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    statusPollMs: 1,
    confirmTimeoutMs: 100,
    log: (m) => logged.push(m),
  });

  const outcome = await executor.fill(offer("h5"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("submission rejected");
  expect(logged.some((m) => m.includes("stranded"))).toBe(true);
});

test("two fills sharing a nullifier cannot both be admitted", async () => {
  statusByHash.set("h6", ["live", "consumed"]);
  statusByHash.set("h7", ["live", "consumed"]);
  const { wallet } = walletStub();
  const executor = makeExecutor(wallet);

  const first = executor.fill(offer("h6", ["shared"]), payout());
  const second = await executor.fill(offer("h7", ["shared"]), payout());
  expect(second.kind).toBe("skipped");
  expect(second.reason).toContain("already claimed");
  expect((await first).kind).toBe("settled");
});

test("fills run one at a time", async () => {
  statusByHash.set("h8", ["live", "consumed"]);
  statusByHash.set("h9", ["live", "consumed"]);
  let inFlight = 0;
  let maxInFlight = 0;
  const { wallet } = walletStub({
    balanceFinalizedTransaction: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { recipe: true };
    },
  });
  const executor = makeExecutor(wallet);

  await Promise.all([executor.fill(offer("h8"), payout()), executor.fill(offer("h9"), payout())]);
  expect(maxInFlight).toBe(1);
});

test("balances are refreshed after a fill reaches a terminal outcome", async () => {
  statusByHash.set("h10", ["live", "consumed"]);
  const { wallet } = walletStub();
  let refreshed = 0;
  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    refreshBalances: async () => {
      refreshed++;
    },
  });

  await executor.fill(offer("h10"), payout());
  expect(refreshed).toBe(1);
});

// ── Path B: merged settlement through the batcher ────────────────────────────

test("an exact crossing settles both members through the batcher", async () => {
  resetBatcher();
  statusByHash.set("m1", ["live", "consumed"]);
  statusByHash.set("m2", ["live", "consumed"]);
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch(
    [offer("m1"), offer("m2")],
    new Map(),
  );
  expect(outcome).toEqual({ kind: "settled", offerHashes: ["m1", "m2"] });
  expect(batcher.settleCalls).toBe(1);
  expect(batcher.merged.length).toBe(2);
  // A crossing costs the solver nothing: no balance, no submit of its own.
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
});

test("a merge with a non-dust imbalance is never handed to the batcher", async () => {
  resetBatcher();
  // The batcher balances dust only. Settling this would spend the makers'
  // inputs without delivering what they asked for.
  batcher.imbalance = [{ seg: 0, tag: "shielded", raw: "aa", amount: 500n }];
  statusByHash.set("m3", ["live"]);
  statusByHash.set("m4", ["live"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch([offer("m3"), offer("m4")], new Map());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("not a complete swap");
  expect(batcher.settleCalls).toBe(0);
});

test("a member taken between admission and dequeue aborts the whole merge", async () => {
  resetBatcher();
  statusByHash.set("m5", ["live"]);
  statusByHash.set("m6", ["consumed"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch([offer("m5"), offer("m6")], new Map());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("m6");
  expect(batcher.settleCalls).toBe(0);
});

test("a batcher rejection is retried, then reported as failed", async () => {
  resetBatcher();
  batcher.results = [{ ok: false, status: 429, body: { error: "Rate limit exceeded" } }];
  statusByHash.set("m7", ["live"]);
  statusByHash.set("m8", ["live"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch([offer("m7"), offer("m8")], new Map());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("429");
  expect(batcher.settleCalls).toBe(3);
});

test("a batcher rejection that succeeds on retry still settles", async () => {
  resetBatcher();
  batcher.results = [
    { ok: false, status: 500, body: { error: "transient" } },
    { ok: true, status: 200, body: { success: true } },
  ];
  statusByHash.set("m9", ["live", "consumed"]);
  statusByHash.set("m10", ["live", "consumed"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch([offer("m9"), offer("m10")], new Map());
  expect(outcome.kind).toBe("settled");
  expect(batcher.settleCalls).toBe(2);
});

test("a claimed member blocks the match without touching the batcher", async () => {
  resetBatcher();
  const stock = new Stock();
  stock.reserve({ offerHashes: ["m11"], nullifiers: [], payouts: new Map() });
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet, stock).settleMatch(
    [offer("m11"), offer("m12")],
    new Map(),
  );
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("already claimed");
  expect(batcher.settleCalls).toBe(0);
});

test("Path A cannot claim an offer a match already holds", async () => {
  resetBatcher();
  statusByHash.set("m13", ["live", "consumed"]);
  statusByHash.set("m14", ["live", "consumed"]);
  const { wallet } = walletStub();
  const executor = makeExecutor(wallet);

  const match = executor.settleMatch([offer("m13"), offer("m14")], new Map());
  const solo = await executor.fill(offer("m13"), payout());
  expect(solo.kind).toBe("skipped");
  expect((await match).kind).toBe("settled");
});

test("a residual set is closed with the solver's own half before merging", async () => {
  resetBatcher();
  statusByHash.set("t1", ["live", "consumed"]);
  statusByHash.set("t2", ["live", "consumed"]);
  const { wallet } = walletStub();
  let asked: { gives: Map<string, bigint>; wants: Map<string, bigint> } | null = null;

  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    buildTopUp: async (gives, wants) => {
      asked = { gives, wants };
      return { topUp: true };
    },
  });

  // Solver is short 100 of B and keeps a surplus of 200 of A.
  const outcome = await executor.settleMatch(
    [offer("t1"), offer("t2")],
    new Map([[A, 200n], [B, -100n]]),
  );
  expect(outcome.kind).toBe("settled");
  // It supplies the shortfall and takes the surplus.
  expect(asked!.gives).toEqual(new Map([[B, 100n]]));
  expect(asked!.wants).toEqual(new Map([[A, 200n]]));
  // Three halves reach the merge: both offers plus the solver's.
  expect(batcher.merged.length).toBe(3);
});

test("an exact crossing never builds a top-up half", async () => {
  resetBatcher();
  statusByHash.set("t3", ["live", "consumed"]);
  statusByHash.set("t4", ["live", "consumed"]);
  const { wallet } = walletStub();
  let built = 0;

  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    buildTopUp: async () => {
      built++;
      return { topUp: true };
    },
  });

  const outcome = await executor.settleMatch([offer("t3"), offer("t4")], new Map());
  expect(outcome.kind).toBe("settled");
  expect(built).toBe(0);
  expect(batcher.merged.length).toBe(2);
});

test("a residual set is refused outright when no top-up builder is configured", async () => {
  resetBatcher();
  statusByHash.set("t5", ["live"]);
  statusByHash.set("t6", ["live"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch(
    [offer("t5"), offer("t6")],
    new Map([[B, -100n]]),
  );
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("no top-up builder");
  expect(batcher.settleCalls).toBe(0);
});

test("the shortfall is reserved against stock for the life of the match", async () => {
  resetBatcher();
  statusByHash.set("t7", ["live", "consumed"]);
  statusByHash.set("t8", ["live", "consumed"]);
  const stock = new Stock();
  stock.setBalances({ [B]: 1000n });
  const { wallet } = walletStub();
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    buildTopUp: async () => ({ topUp: true }),
  });

  const task = executor.settleMatch([offer("t7"), offer("t8")], new Map([[B, -400n]]));
  expect(stock.available(B)).toBe(600n);
  await task;
  expect(stock.available(B)).toBe(1000n);
});

test("an unreadable imbalance guard blocks settlement rather than passing", async () => {
  resetBatcher();
  // The guard could not run — that is not evidence it would have passed.
  batcher.imbalanceThrows = new Error("transaction exposes no imbalances()");
  statusByHash.set("m15", ["live"]);
  statusByHash.set("m16", ["live"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch([offer("m15"), offer("m16")], new Map());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("imbalance guard could not run");
  expect(batcher.settleCalls).toBe(0);
  batcher.imbalanceThrows = null;
});
