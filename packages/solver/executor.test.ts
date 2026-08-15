import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { BookOffer } from "./src/book.ts";
import {
  deriveReconstructedOfferSemantics,
  Executor,
  type DerivedOfferSemantics,
  type ExecutorApiClient,
  type WalletLike,
} from "./src/executor.ts";
import { Stock } from "./src/stock.ts";
import { reconstructOffer } from "@zswap-da/solver-core/api-client";

const A = "a".repeat(64);
const B = "b".repeat(64);

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// The executor reads status and blobs through the api-client module; the offers
// below always carry a blob so only status has to be stubbed.
type KnownStatus = "live" | "consumed" | "cancelled" | "expired" | "unknown" | "not_found";
const HANG = Symbol("hang");
type StatusStep = KnownStatus | Error | typeof HANG;
const statusByHash = new Map<string, StatusStep[]>();
const semanticsByBlob = new Map<string, DerivedOfferSemantics>();
const apiClient = {
  getOfferStatus: async (hash: string) => {
    const queue = statusByHash.get(hash) ?? (["live"] as StatusStep[]);
    const step = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (step === HANG) return await new Promise<never>(() => {});
    if (step instanceof Error) throw step;
    return { offerId: hash, status: step };
  },
  getZswapByHash: async (hash: string) => ({ offerBech32: `blob-${hash}` }),
  reconstructOffer: (blob: string) => ({ blob }),
  assertOfferBlobIdentity: (blob: string, expectedHash: string) => {
    if (blob !== `blob-${expectedHash}`) throw new Error("synthetic blob hash mismatch");
  },
  deriveOfferSemantics: (tx: unknown) => {
    const blob = (tx as { blob?: unknown }).blob;
    if (typeof blob !== "string") throw new Error("synthetic transaction has no blob identity");
    const semantics = semanticsByBlob.get(blob);
    if (!semantics) throw new Error(`no synthetic semantics registered for ${blob}`);
    return semantics;
  },
  mergeFinalized: (txs: unknown[]) => {
    batcher.merged = txs;
    return { merged: txs } as any;
  },
  nonDustImbalances: () => {
    if (batcher.imbalanceThrows) throw batcher.imbalanceThrows;
    return batcher.imbalance as any;
  },
  describeImbalances: () =>
    JSON.stringify(
      batcher.imbalance.map((i) => ({
        ...(i as object),
        amount: String((i as any).amount),
      })),
    ),
  settleViaBatcher: async () => {
    batcher.settleCalls++;
    const step = batcher.results.length > 1
      ? batcher.results.shift()!
      : (batcher.results[0] ?? { ok: true, status: 200, body: { success: true } });
    if (step === HANG) return await new Promise<never>(() => {});
    if (step instanceof Error) throw step;
    return step;
  },
} as unknown as ExecutorApiClient;

/** Batcher stub. `imbalance` drives the fund-loss guard; `results` queues the
 *  batcher's replies so retry behaviour can be driven. */
const batcher = {
  imbalance: [] as unknown[],
  results: [] as Array<
    { ok: boolean; status: number; body: unknown } | Error | typeof HANG
  >,
  settleCalls: 0,
  merged: [] as unknown[],
  imbalanceThrows: null as Error | null,
};

const resetBatcher = () => {
  batcher.imbalance = [];
  batcher.results = [];
  batcher.settleCalls = 0;
  batcher.merged = [];
  batcher.imbalanceThrows = null;
};

const offer = (hash: string, nullifiers = [`n-${hash}`]): BookOffer => {
  const value: BookOffer = {
    offerHash: hash,
    gives: [{ token: A, amount: 1000n, kind: "SHIELDED" }],
    wants: [{ token: B, amount: 900n, kind: "SHIELDED" }],
    expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    firstSeenAt: null,
    inputNullifiers: nullifiers,
    blob: `blob-${hash}`,
  };
  semanticsByBlob.set(value.blob!, {
    gives: value.gives.map((leg) => ({
      token: leg.token,
      amount: leg.amount.toString(),
      kind: leg.kind,
    })),
    wants: value.wants.map((leg) => ({
      token: leg.token,
      amount: leg.amount.toString(),
      kind: leg.kind,
    })),
    nullifiers: [...value.inputNullifiers],
    unshieldedSpends: [],
  });
  return value;
};

const payout = (amount = 900n) => new Map([[B, amount]]);

const reverseOffer = (hash: string, nullifiers = [`n-${hash}`]): BookOffer => {
  const value = offer(hash, nullifiers);
  value.gives = [{ token: B, amount: 900n, kind: "SHIELDED" }];
  value.wants = [{ token: A, amount: 1000n, kind: "SHIELDED" }];
  semanticsByBlob.set(value.blob!, {
    gives: [{ token: B, amount: "900", kind: "SHIELDED" }],
    wants: [{ token: A, amount: "1000", kind: "SHIELDED" }],
    nullifiers: [...value.inputNullifiers],
    unshieldedSpends: [],
  });
  return value;
};

const exactPair = (first: string, second: string): [BookOffer, BookOffer] => [
  offer(first),
  reverseOffer(second),
];

/** Forward 1000 A -> 900 B plus reverse 800 B -> 800 A leaves the solver
 * +200 A / -100 B, matching the residual-path assertions below. */
const residualPair = (first: string, second: string): [BookOffer, BookOffer] => {
  const pair: [BookOffer, BookOffer] = [offer(first), reverseOffer(second)];
  pair[1].gives[0].amount = 800n;
  pair[1].wants[0].amount = 800n;
  semanticsByBlob.set(pair[1].blob!, {
    gives: [{ token: B, amount: "800", kind: "SHIELDED" }],
    wants: [{ token: A, amount: "800", kind: "SHIELDED" }],
    nullifiers: [...pair[1].inputNullifiers],
    unshieldedSpends: [],
  });
  return pair;
};

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
  new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    requestTimeoutMs: 20,
    batcherTimeoutMs: 50,
  });

test("a fill settles once the offer leaves the book", async () => {
  statusByHash.set("h1", ["live", "consumed"]);
  const { wallet, calls } = walletStub();
  const stock = new Stock();
  stock.setBalances({ [B]: 10_000n });

  const outcome = await makeExecutor(wallet, stock).fill(offer("h1"), payout());
  expect(outcome).toEqual({
    kind: "settled",
    offerHash: "h1",
    claimDisposition: "release",
  });
  expect(calls.submitted).toBe(1);
  expect(calls.reverted).toBe(0);
  // The claim is released, so the budget is whole again.
  expect(stock.available(B)).toBe(10_000n);
  expect(stock.isOfferClaimed(offer("h1"))).toBe(false);
});

test("an offer taken by someone else between admission and dequeue is skipped, not filled", async () => {
  statusByHash.set("h2", ["consumed"]);
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet).fill(offer("h2"), payout());
  expect(outcome.kind).toBe("skipped");
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
});

test("a reversible pre-submit failure reverts before a live-state retry", async () => {
  statusByHash.set("h3", ["live", "live", "live", "consumed"]);
  let attempts = 0;
  const { wallet, calls } = walletStub({
    finalizeRecipe: async (recipe) => {
      attempts++;
      if (attempts === 1) throw new Error("proof finalization rejected");
      return recipe;
    },
  });

  const outcome = await makeExecutor(wallet).fill(offer("h3"), payout());
  expect(outcome.kind).toBe("settled");
  // The abandoned first balance is reverted before the second attempt.
  expect(calls.reverted).toBe(1);
  expect(calls.balanced).toBe(2);
  expect(calls.submitted).toBe(1);
});

for (const terminalStatus of ["cancelled", "expired", "unknown", "not_found"] as const) {
  test(`a lost submit response followed by ${terminalStatus} quarantines without revert`, async () => {
    const hash = `post-submit-${terminalStatus}`;
    statusByHash.set(hash, ["live", terminalStatus]);
    const stock = fundedStock();
    const { wallet, calls } = walletStub({
      submitTransaction: async () => {
        calls.submitted++;
        throw new Error("response lost after acceptance boundary");
      },
    });
    const executor = makeExecutor(wallet, stock);

    const outcome = await executor.fill(offer(hash), payout());
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toContain(terminalStatus);
    expect(outcome.claimDisposition).toBe("quarantine");
    expect(calls.balanced).toBe(1);
    expect(calls.submitted).toBe(1);
    expect(calls.reverted).toBe(0);
    expect(stock.isOfferClaimed(offer(hash))).toBe(true);
    expect((await executor.fill(offer(hash), payout())).kind).toBe("skipped");
    expect(calls.submitted).toBe(1);
  });
}

test("a resolved submit followed by archived status quarantines without revert", async () => {
  statusByHash.set("submitted-then-expired", ["live", "expired"]);
  const stock = fundedStock();
  const { wallet, calls } = walletStub();
  const executor = makeExecutor(wallet, stock);

  const outcome = await executor.fill(offer("submitted-then-expired"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("submitted but expired");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(calls.submitted).toBe(1);
  expect(calls.reverted).toBe(0);
  expect(stock.isOfferClaimed(offer("submitted-then-expired"))).toBe(true);
  expect((await executor.fill(offer("submitted-then-expired"), payout())).kind).toBe("skipped");
  expect(calls.submitted).toBe(1);
});

test("an ambiguous submit failure is reconciled but never submitted twice", async () => {
  statusByHash.set("h4-ambiguous", ["live", "live"]);
  const { wallet, calls } = walletStub({
    submitTransaction: async () => {
      calls.submitted++;
      throw new Error("response lost after send");
    },
  });
  const stock = fundedStock();
  let refreshed = 0;
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 20,
    requestTimeoutMs: 10,
    refreshBalances: async () => {
      refreshed++;
    },
  });

  const outcome = await executor.fill(offer("h4-ambiguous"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("refusing duplicate submission");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(calls.submitted).toBe(1);
  // Live/timeout is ambiguous after submit; reverting could race an accepted
  // transaction, so the later retained-operation remediation owns recovery.
  expect(calls.reverted).toBe(0);
  expect(refreshed).toBe(1);
  expect(stock.isOfferClaimed(offer("h4-ambiguous"))).toBe(true);

  const repeated = await executor.fill(offer("h4-ambiguous"), payout());
  expect(repeated.kind).toBe("skipped");
  expect(repeated.reason).toContain("already claimed");
  expect(calls.submitted).toBe(1);
});

test("a resolved submit with no terminal confirmation is quarantined", async () => {
  statusByHash.set("h4-unconfirmed", ["live"]);
  const stock = fundedStock();
  const { wallet, calls } = walletStub();
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 20,
    requestTimeoutMs: 10,
    refreshBalances: async () => {},
  });

  const outcome = await executor.fill(offer("h4-unconfirmed"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("submitted but confirmation timed out");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(stock.isOfferClaimed(offer("h4-unconfirmed"))).toBe(true);
  expect((await executor.fill(offer("h4-unconfirmed"), payout())).kind).toBe("skipped");
  expect(calls.submitted).toBe(1);
});

test("a lost submit response that later observes consumed is success without retry", async () => {
  statusByHash.set("h4-consumed", ["live", "consumed"]);
  const { wallet, calls } = walletStub({
    submitTransaction: async () => {
      calls.submitted++;
      throw new Error("response lost after send");
    },
  });

  const outcome = await makeExecutor(wallet).fill(offer("h4-consumed"), payout());
  expect(outcome.kind).toBe("settled");
  expect(calls.submitted).toBe(1);
  expect(calls.reverted).toBe(0);
});

test("a revert that itself throws does not mask the original failure", async () => {
  statusByHash.set("h5", ["live"]);
  const logged: string[] = [];
  const { wallet } = walletStub({
    finalizeRecipe: async () => {
      throw new Error("finalization rejected");
    },
    revert: async () => {
      throw new Error("revert exploded");
    },
  });
  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 100,
    log: (m) => logged.push(m),
  });

  const outcome = await executor.fill(offer("h5"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("finalization rejected");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(logged.some((m) => m.includes("stranded"))).toBe(true);
});

test("a failed pre-submit revert quarantines and forbids a second balance attempt", async () => {
  statusByHash.set("revert-quarantine", ["live"]);
  const stock = fundedStock();
  const { wallet, calls } = walletStub({
    finalizeRecipe: async () => {
      throw new Error("finalize failed");
    },
    revert: async () => {
      throw new Error("wallet rollback failed");
    },
  });
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 20,
  });

  const outcome = await executor.fill(offer("revert-quarantine"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("wallet revert failed");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect((await executor.fill(offer("revert-quarantine"), payout())).kind).toBe("skipped");
  expect(calls.balanced).toBe(1);
  expect(calls.submitted).toBe(0);
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

test("a queued Path A offer crossing the expiry margin never mutates the wallet", async () => {
  let now = 1_000;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const { wallet, calls } = walletStub({
    balanceFinalizedTransaction: async () => {
      calls.balanced++;
      if (calls.balanced === 1) {
        firstStarted();
        await blocker;
      }
      return { recipe: true };
    },
  });
  const first = offer("expiry-blocker");
  const expiring = offer("expiry-queued");
  first.expiresAt = 10_000;
  expiring.expiresAt = 1_500;
  statusByHash.set(first.offerHash, ["live", "consumed"]);
  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    apiClient,
    nowMs: () => now,
    expiryMarginSeconds: 0,
    statusPollMs: 1,
    confirmTimeoutMs: 100,
  });

  const blocking = executor.fill(first, payout());
  await started;
  const queued = executor.fill(expiring, payout());
  now = 2_000;
  releaseFirst();

  expect((await blocking).kind).toBe("settled");
  const outcome = await queued;
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("expiry margin");
  expect(calls.balanced).toBe(1);
  expect(calls.submitted).toBe(1);
});

test("balances are refreshed after a fill reaches a terminal outcome", async () => {
  statusByHash.set("h10", ["live", "consumed"]);
  const { wallet } = walletStub();
  let refreshed = 0;
  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    refreshBalances: async () => {
      refreshed++;
    },
  });

  await executor.fill(offer("h10"), payout());
  expect(refreshed).toBe(1);
});

for (const [label, error] of [
  ["429", new Error("GET status HTTP 429")],
  ["500", new Error("GET status HTTP 500")],
  ["network", new Error("network offline")],
] as const) {
  test(`a ${label} status failure is fail-closed before wallet mutation`, async () => {
    const hash = `status-${label}`;
    statusByHash.set(hash, [error]);
    const { wallet, calls } = walletStub();

    const outcome = await makeExecutor(wallet).fill(offer(hash), payout());
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toContain("status unknown before wallet mutation");
    expect(calls.balanced).toBe(0);
    expect(calls.submitted).toBe(0);
  });
}

test("a never-resolving status call is bounded and performs no wallet mutation", async () => {
  statusByHash.set("status-hang", [HANG]);
  const { wallet, calls } = walletStub();
  const started = Date.now();

  const outcome = await makeExecutor(wallet).fill(offer("status-hang"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(250);
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
});

test("Path A derives its reservation from the offer and rejects an understated payout", async () => {
  const listed = offer("understated-path-a");
  const stock = new Stock();
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet, stock).fill(listed, new Map());

  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("caller payout does not match");
  expect(outcome.claimDisposition).toBe("release");
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
  expect(stock.isOfferClaimed(listed)).toBe(false);
});

test("Path A snapshots mutable offer fields before queued execution", async () => {
  const listed = offer("mutable-path-a");
  statusByHash.set(listed.offerHash, ["live", "consumed"]);
  const { wallet, calls } = walletStub();
  const executor = makeExecutor(wallet);

  const pending = executor.fill(listed, payout());
  listed.offerHash = "mutated-hash";
  listed.wants[0].amount = 1n;
  listed.inputNullifiers[0] = "mutated-nullifier";
  listed.blob = "blob-mutated-content";

  const outcome = await pending;
  expect(outcome.kind).toBe("settled");
  expect(outcome.offerHash).toBe("mutable-path-a");
  expect(calls.balanced).toBe(1);
  expect(calls.submitted).toBe(1);
});

test("a consumed archive event is wake-only and cancellation cannot be reported as settlement", async () => {
  const hash = "cancel-event-race";
  statusByHash.set(hash, ["live", "live", "cancelled"]);
  const stock = fundedStock();
  let submitted!: () => void;
  const didSubmit = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const { wallet, calls } = walletStub({
    submitTransaction: async () => {
      calls.submitted++;
      submitted();
    },
  });
  const executor = makeExecutor(wallet, stock);

  const pending = executor.fill(offer(hash), payout());
  await didSubmit;
  executor.notifyConsumed(hash);
  const outcome = await pending;

  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("submitted but cancelled");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(calls.submitted).toBe(1);
  expect(calls.reverted).toBe(0);
  expect(stock.isOfferClaimed(offer(hash))).toBe(true);
});

test("production derivation reads a real serialized ledger offer", () => {
  const blob = readFileSync(
    new URL("../validator/fixtures/valid-offer.bech32", import.meta.url),
    "utf8",
  ).trim();
  const derived = deriveReconstructedOfferSemantics(reconstructOffer(blob));

  expect(derived).toEqual({
    gives: [{
      token: "0".repeat(64),
      amount: "1000000",
      kind: "SHIELDED",
    }],
    wants: [{
      token: "f".repeat(64),
      amount: "5000000",
      kind: "SHIELDED",
    }],
    nullifiers: ["050d27d9b42dd59baa0515c0890de8b3766b152ffc2eeaab7596739515bce070"],
    unshieldedSpends: [],
  });
});

for (const [label, mutate] of [
  ["give amount", (value: DerivedOfferSemantics) => {
    value.gives[0] = { ...value.gives[0], amount: "1001" };
  }],
  ["want token", (value: DerivedOfferSemantics) => {
    value.wants[0] = { ...value.wants[0], token: "c".repeat(64) };
  }],
  ["leg kind", (value: DerivedOfferSemantics) => {
    value.gives[0] = { ...value.gives[0], kind: "UNSHIELDED" };
  }],
  ["nullifier", (value: DerivedOfferSemantics) => {
    value.nullifiers = ["different-nullifier"];
  }],
] as const) {
  test(`Path A rejects a cached blob whose derived ${label} differs from the listed row`, async () => {
    const hash = `semantics-${label.replaceAll(" ", "-")}`;
    const listed = offer(hash);
    const derived = structuredClone(semanticsByBlob.get(listed.blob!)!);
    mutate(derived);
    semanticsByBlob.set(listed.blob!, derived);
    statusByHash.set(hash, ["live"]);
    const stock = fundedStock();
    const { wallet, calls } = walletStub();

    const outcome = await makeExecutor(wallet, stock).fill(listed, payout());

    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toContain("does not match listed economics");
    expect(outcome.claimDisposition).toBe("release");
    expect(calls.balanced).toBe(0);
    expect(calls.submitted).toBe(0);
    expect(stock.isOfferClaimed(listed)).toBe(false);
  });
}

test("Path A rejects unshielded spend identities that Stock cannot claim", async () => {
  const listed = offer("semantics-unshielded-spend");
  const derived = structuredClone(semanticsByBlob.get(listed.blob!)!);
  derived.unshieldedSpends = [{ owner: "aa", intentHash: "bb", outputNo: 0 }];
  semanticsByBlob.set(listed.blob!, derived);
  statusByHash.set(listed.offerHash, ["live"]);
  const stock = fundedStock();
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet, stock).fill(listed, payout());

  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("unshielded offer semantics are unsupported");
  expect(outcome.claimDisposition).toBe("release");
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
  expect(stock.isOfferClaimed(listed)).toBe(false);
});

test("Path A validates cached blob identity even when derived economics match", async () => {
  const listed = offer("cached-identity-row");
  const originalBlob = listed.blob!;
  listed.blob = "blob-different-content";
  semanticsByBlob.set(listed.blob, structuredClone(semanticsByBlob.get(originalBlob)!));
  statusByHash.set(listed.offerHash, ["live"]);
  const stock = fundedStock();
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet, stock).fill(listed, payout());

  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("synthetic blob hash mismatch");
  expect(outcome.claimDisposition).toBe("release");
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
  expect(stock.isOfferClaimed(listed)).toBe(false);
});

test("Path A reverts and refuses a finalized transaction with a non-dust imbalance", async () => {
  resetBatcher();
  batcher.imbalance = [{ seg: 7, tag: "shielded", raw: "aa", amount: 1n }];
  statusByHash.set("path-a-unbalanced", ["live"]);
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet).fill(offer("path-a-unbalanced"), payout());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("not a complete swap");
  expect(outcome.claimDisposition).toBe("release");
  expect(calls.reverted).toBe(1);
  expect(calls.submitted).toBe(0);
  resetBatcher();
});

test("Path A reverts and fails closed when finalized imbalances are unreadable", async () => {
  resetBatcher();
  batcher.imbalanceThrows = new Error("transaction exposes no imbalances()");
  statusByHash.set("path-a-unreadable", ["live"]);
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet).fill(offer("path-a-unreadable"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("imbalance guard could not run");
  expect(outcome.claimDisposition).toBe("release");
  expect(calls.reverted).toBe(1);
  expect(calls.submitted).toBe(0);
  resetBatcher();
});

test("throwing callback and logger cannot strand a result or poison the following job", async () => {
  statusByHash.set("callback-1", ["live", "consumed"]);
  statusByHash.set("callback-2", ["live", "consumed"]);
  const { wallet, calls } = walletStub();
  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 100,
    requestTimeoutMs: 20,
    onOutcome: () => {
      throw new Error("observer exploded");
    },
    log: () => {
      throw new Error("logger exploded");
    },
  });

  const first = await executor.fill(offer("callback-1"), payout());
  const second = await executor.fill(offer("callback-2"), payout());
  expect(first.kind).toBe("settled");
  expect(second.kind).toBe("settled");
  expect(calls.submitted).toBe(2);
});

test("refresh holds the claim until authoritative balances are installed", async () => {
  statusByHash.set("refresh-order", ["live", "consumed"]);
  const stock = new Stock();
  stock.setBalances({ [B]: 10_000n });
  const { wallet } = walletStub();
  let availableDuringRefresh = 0n;
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 100,
    requestTimeoutMs: 20,
    refreshBalances: async () => {
      availableDuringRefresh = stock.available(B);
      stock.setBalances({ [B]: 11_000n });
    },
  });

  const outcome = await executor.fill(offer("refresh-order"), payout());
  expect(outcome.kind).toBe("settled");
  expect(availableDuringRefresh).toBe(9_100n);
  expect(stock.available(B)).toBe(11_000n);
});

test("refresh failure retains the claim and reports unready capacity", async () => {
  statusByHash.set("refresh-fail", ["live", "consumed"]);
  const stock = new Stock();
  stock.setBalances({ [B]: 10_000n });
  const { wallet } = walletStub();
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 100,
    requestTimeoutMs: 20,
    refreshBalances: async () => {
      throw new Error("wallet unavailable");
    },
  });

  const outcome = await executor.fill(offer("refresh-fail"), payout());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("capacity remains reserved");
  expect(stock.available(B)).toBe(9_100n);
  expect(stock.isOfferClaimed(offer("refresh-fail"))).toBe(true);
});

test("stop is bounded when a wallet operation never resolves and retains its claim", async () => {
  statusByHash.set("stop-hanging-wallet", ["live"]);
  const stock = new Stock();
  stock.setBalances({ [B]: 10_000n });
  const enteredWallet = deferred<void>();
  const { wallet, calls } = walletStub({
    balanceFinalizedTransaction: async () => {
      calls.balanced++;
      enteredWallet.resolve();
      return new Promise<never>(() => {});
    },
  });
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 100,
    requestTimeoutMs: 20,
    walletOperationTimeoutMs: 60_000,
  });

  const fill = executor.fill(offer("stop-hanging-wallet"), payout());
  await enteredWallet.promise;
  const startedAt = Date.now();
  const stopped = await executor.stop(20);
  const outcome = await fill;

  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(stopped.drained).toBe(true);
  expect(stopped.retainedClaims).toBe(1);
  expect(stopped.retainedOperations).toBe(1);
  expect(outcome.kind).toBe("failed");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(outcome.reason).toContain("shutdown");
  expect(stock.isOfferClaimed(offer("stop-hanging-wallet"))).toBe(true);
  expect(stock.available(B)).toBe(9_100n);
  expect(calls.submitted).toBe(0);
  expect(calls.reverted).toBe(0);
});

test("global inventory unready refuses even a zero-payout exact Path B match", async () => {
  resetBatcher();
  const pair = exactPair("unready-match-1", "unready-match-2");
  const { wallet, calls } = walletStub();
  const executor = new Executor({
    wallet,
    keys: {},
    stock: new Stock(),
    apiClient,
    isReady: () => false,
  });

  const outcome = await executor.settleMatch(pair, new Map());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("inventory is unready");
  expect(batcher.settleCalls).toBe(0);
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
});

// ── Path B: merged settlement through the batcher ────────────────────────────

test("Path B rejects an understated caller net before reserving or mutating", async () => {
  resetBatcher();
  const pair = residualPair("understated-net-1", "understated-net-2");
  const stock = new Stock();
  const { wallet, calls } = walletStub();
  let topUps = 0;
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    buildTopUp: async () => {
      topUps++;
      return { topUp: true };
    },
  });

  const outcome = await executor.settleMatch(pair, new Map());

  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("caller net does not match");
  expect(outcome.claimDisposition).toBe("release");
  expect(topUps).toBe(0);
  expect(batcher.settleCalls).toBe(0);
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
  expect(stock.isOfferClaimed(pair[0])).toBe(false);
});

test("Path B rechecks every member's expiry before batcher work", async () => {
  resetBatcher();
  const pair = exactPair("expired-match-1", "expired-match-2");
  pair[1].expiresAt = 999;
  const { wallet, calls } = walletStub();
  const executor = new Executor({
    wallet,
    keys: {},
    stock: fundedStock(),
    apiClient,
    nowMs: () => 1_000,
    expiryMarginSeconds: 0,
  });

  const outcome = await executor.settleMatch(pair, new Map());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("expiry margin");
  expect(batcher.settleCalls).toBe(0);
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
});

test("Path B snapshots its member set before queued execution", async () => {
  resetBatcher();
  const pair = exactPair("mutable-match-1", "mutable-match-2");
  statusByHash.set(pair[0].offerHash, ["live", "consumed"]);
  statusByHash.set(pair[1].offerHash, ["live", "consumed"]);
  const { wallet } = walletStub();
  const executor = makeExecutor(wallet);

  const pending = executor.settleMatch(pair, new Map());
  pair[0].offerHash = "mutated-member";
  pair[0].gives[0].amount = 1n;
  pair[1].blob = "blob-mutated-member";
  pair.splice(0);

  const outcome = await pending;
  expect(outcome.kind).toBe("settled");
  expect(outcome.offerHashes).toEqual(["mutable-match-1", "mutable-match-2"]);
  expect(batcher.settleCalls).toBe(1);
});

test("Path B validates every cached offer before top-up construction or batcher submission", async () => {
  resetBatcher();
  const [bad, good] = residualPair("match-semantics-bad", "match-semantics-good");
  const derived = structuredClone(semanticsByBlob.get(bad.blob!)!);
  derived.wants[0] = { ...derived.wants[0], amount: "901" };
  semanticsByBlob.set(bad.blob!, derived);
  statusByHash.set(bad.offerHash, ["live"]);
  statusByHash.set(good.offerHash, ["live"]);
  const stock = fundedStock();
  const { wallet, calls } = walletStub();
  let topUps = 0;
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 20,
    buildTopUp: async () => {
      topUps++;
      return { topUp: true };
    },
  });

  const outcome = await executor.settleMatch(
    [bad, good],
    new Map([[A, 200n], [B, -100n]]),
  );

  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("does not match listed economics");
  expect(outcome.claimDisposition).toBe("release");
  expect(topUps).toBe(0);
  expect(batcher.settleCalls).toBe(0);
  expect(calls.balanced).toBe(0);
  expect(calls.submitted).toBe(0);
  expect(stock.isOfferClaimed(bad)).toBe(false);
});

test("an exact crossing settles both members through the batcher", async () => {
  resetBatcher();
  statusByHash.set("m1", ["live", "consumed"]);
  statusByHash.set("m2", ["live", "consumed"]);
  const { wallet, calls } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch(
    exactPair("m1", "m2"),
    new Map(),
  );
  expect(outcome).toEqual({
    kind: "settled",
    offerHashes: ["m1", "m2"],
    claimDisposition: "release",
  });
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

  const outcome = await makeExecutor(wallet).settleMatch(exactPair("m3", "m4"), new Map());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("not a complete swap");
  expect(batcher.settleCalls).toBe(0);
});

test("a member taken between admission and dequeue aborts the whole merge", async () => {
  resetBatcher();
  statusByHash.set("m5", ["live"]);
  statusByHash.set("m6", ["consumed"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch(exactPair("m5", "m6"), new Map());
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

  const outcome = await makeExecutor(wallet).settleMatch(exactPair("m7", "m8"), new Map());
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("429");
  expect(outcome.claimDisposition).toBe("release");
  expect(batcher.settleCalls).toBe(3);
});

test("a batcher rejection that succeeds on retry still settles", async () => {
  resetBatcher();
  batcher.results = [
    { ok: false, status: 429, body: { error: "rate limited before admission" } },
    { ok: true, status: 200, body: { success: true } },
  ];
  statusByHash.set("m9", ["live", "live", "consumed"]);
  statusByHash.set("m10", ["live", "live", "consumed"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch(exactPair("m9", "m10"), new Map());
  expect(outcome.kind).toBe("settled");
  expect(batcher.settleCalls).toBe(2);
});

for (const [label, step] of [
  ["500", { ok: false, status: 500, body: { error: "ambiguous server error" } }],
  ["network", new Error("socket reset after send")],
  ["hang", HANG],
] as const) {
  test(`a batcher ${label} failure is bounded and not retried without idempotency`, async () => {
    resetBatcher();
    batcher.results = [step];
    const first = `batcher-${label}-1`;
    const second = `batcher-${label}-2`;
    statusByHash.set(first, ["live"]);
    statusByHash.set(second, ["live"]);
    const { wallet } = walletStub();
    const stock = fundedStock();
    const executor = makeExecutor(wallet, stock);
    const started = Date.now();

    const outcome = await executor.settleMatch(
      exactPair(first, second),
      new Map(),
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toContain("not safely retryable");
    expect(outcome.claimDisposition).toBe("quarantine");
    expect(batcher.settleCalls).toBe(1);
    expect(stock.isOfferClaimed(offer(first))).toBe(true);
    expect((await executor.settleMatch(exactPair(first, second), new Map())).kind).toBe(
      "skipped",
    );
    expect(batcher.settleCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(250);
  });
}

test("an unbound 2xx batcher acknowledgement quarantines the whole match", async () => {
  resetBatcher();
  batcher.results = [{
    ok: false,
    status: 200,
    body: { success: true, message: "accepted", transactionHash: "wrong" },
  }];
  statusByHash.set("unbound-1", ["live"]);
  statusByHash.set("unbound-2", ["live"]);
  const stock = fundedStock();
  const { wallet } = walletStub();
  const executor = makeExecutor(wallet, stock);

  const outcome = await executor.settleMatch(
    exactPair("unbound-1", "unbound-2"),
    new Map(),
  );
  expect(outcome.kind).toBe("failed");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(stock.isOfferClaimed(offer("unbound-1"))).toBe(true);
  expect((await executor.settleMatch(
    exactPair("unbound-1", "unbound-2"),
    new Map(),
  )).kind).toBe("skipped");
  expect(batcher.settleCalls).toBe(1);
});

test("a batcher receipt without durable consumption keeps the match quarantined", async () => {
  resetBatcher();
  batcher.results = [{ ok: true, status: 200, body: { success: true } }];
  statusByHash.set("unconfirmed-match-1", ["live"]);
  statusByHash.set("unconfirmed-match-2", ["live"]);
  const stock = fundedStock();
  const { wallet } = walletStub();
  const executor = new Executor({
    wallet,
    keys: {},
    stock,
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 20,
    batcherTimeoutMs: 50,
    refreshBalances: async () => {},
  });

  const outcome = await executor.settleMatch(
    exactPair("unconfirmed-match-1", "unconfirmed-match-2"),
    new Map(),
  );
  expect(outcome.kind).toBe("failed");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(stock.isOfferClaimed(offer("unconfirmed-match-1"))).toBe(true);
  expect((await executor.settleMatch(
    exactPair("unconfirmed-match-1", "unconfirmed-match-2"),
    new Map(),
  )).kind).toBe("skipped");
  expect(batcher.settleCalls).toBe(1);
});

test("a consumed member after a failed batcher response is never retried", async () => {
  resetBatcher();
  batcher.results = [{
    ok: false,
    status: 200,
    body: { success: true, message: "unbound acknowledgement" },
  }];
  statusByHash.set("consumed-no-retry-1", ["live", "consumed"]);
  statusByHash.set("consumed-no-retry-2", ["live"]);
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet).settleMatch(
    exactPair("consumed-no-retry-1", "consumed-no-retry-2"),
    new Map(),
  );
  expect(outcome.kind).toBe("failed");
  expect(outcome.reason).toContain("refusing an unbound duplicate submission");
  expect(outcome.claimDisposition).toBe("quarantine");
  expect(batcher.settleCalls).toBe(1);
});

test("a claimed member blocks the match without touching the batcher", async () => {
  resetBatcher();
  const stock = new Stock();
  stock.reserve({ offerHashes: ["m11"], nullifiers: [], payouts: new Map() });
  const { wallet } = walletStub();

  const outcome = await makeExecutor(wallet, stock).settleMatch(
    exactPair("m11", "m12"),
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

  const match = executor.settleMatch(exactPair("m13", "m14"), new Map());
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
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    buildTopUp: async (gives, wants) => {
      asked = { gives, wants };
      return { topUp: true };
    },
  });

  // Solver is short 100 of B and keeps a surplus of 200 of A.
  const outcome = await executor.settleMatch(
    residualPair("t1", "t2"),
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
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    buildTopUp: async () => {
      built++;
      return { topUp: true };
    },
  });

  const outcome = await executor.settleMatch(exactPair("t3", "t4"), new Map());
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
    residualPair("t5", "t6"),
    new Map([[A, 200n], [B, -100n]]),
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
    apiClient,
    statusPollMs: 1,
    confirmTimeoutMs: 200,
    buildTopUp: async () => ({ topUp: true }),
  });

  const task = executor.settleMatch(
    residualPair("t7", "t8"),
    new Map([[A, 200n], [B, -100n]]),
  );
  expect(stock.available(B)).toBe(900n);
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

  const outcome = await makeExecutor(wallet).settleMatch(exactPair("m15", "m16"), new Map());
  expect(outcome.kind).toBe("skipped");
  expect(outcome.reason).toContain("imbalance guard could not run");
  expect(batcher.settleCalls).toBe(0);
  batcher.imbalanceThrows = null;
});
