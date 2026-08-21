import { expect, test } from "bun:test";

import type { ExactFilesResponse } from "@zswap-da/solver-core/exact-files-contract";
import type { OfferValidationVerdict } from "@zswap-da/solver-core/validation-contract";
import type { Imbalance } from "@zswap-da/solver-core/batcher";
import type { SwapMessage } from "@zswap-da/solver-core/relay-ws-contract";

import { Book, type BookOffer } from "./src/book.ts";
import { Stock } from "./src/stock.ts";
import {
  JOB_AT_CAPACITY,
  JOB_CACHE_NOT_CURRENT,
  JOB_DUPLICATE,
  JOB_EXACT_FILE_MISMATCH,
  JOB_EXACT_FILE_REFUSED,
  JOB_ROUTE_NOT_CURRENT,
  JOB_WALLET_FAILED,
  JOB_WALLET_TIMEOUT,
  startSwapJobExecutor,
  type ExactOfferSemantics,
  type SwapJobWallet,
} from "./src/swap-job-executor.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const H1 = "11".repeat(32);
const H2 = "22".repeat(32);
const N1 = "31".repeat(32);
const N2 = "32".repeat(32);

interface FakeTx {
  label: string;
  rows: Imbalance[];
  serialize: () => Uint8Array;
}

const fakeTx = (label: string, rows: Imbalance[] = []): FakeTx => ({
  label,
  rows,
  serialize: () => new TextEncoder().encode(label),
});

const makerRows = (amountIn: bigint, amountOut: bigint): Imbalance[] => [
  { seg: 0, tag: "shielded", raw: B, amount: amountOut },
  { seg: 0, tag: "shielded", raw: A, amount: -amountIn },
];

const offer = (
  offerHash: string,
  nullifier: string,
  amountIn: bigint,
  amountOut: bigint,
): BookOffer => ({
  offerHash,
  gives: [{ token: B, amount: amountOut, kind: "SHIELDED" }],
  wants: [{ token: A, amount: amountIn, kind: "SHIELDED" }],
  expiresAt: Date.now() + 3_600_000,
  firstSeenAt: Date.now(),
  inputNullifiers: [nullifier],
});

const job = (jobId = "job-1", amountIn = "10", amountOut = "20"): SwapMessage => ({
  type: "swap",
  jobId,
  tokenIn: A,
  tokenOut: B,
  amountIn,
  amountOut,
});

const semantics = (source: BookOffer): ExactOfferSemantics => ({
  gives: source.gives.map((leg) => ({ ...leg, amount: leg.amount.toString() })),
  wants: source.wants.map((leg) => ({ ...leg, amount: leg.amount.toString() })),
  nullifiers: [...source.inputNullifiers],
});

const validVerdict = (source: BookOffer): OfferValidationVerdict => ({
  schemaVersion: 1,
  profile: "native-shielded-v1",
  valid: true,
  live: true,
  claimedOfferId: source.offerHash,
  computedOfferId: source.offerHash,
  stateVersion: "8",
  validatedAt: "2026-08-20T12:00:00.000Z",
  status: "live",
  code: "VALID",
  computed: {
    gives: source.gives.map((leg) => ({ token: leg.token, amount: leg.amount.toString(), kind: leg.kind })),
    wants: source.wants.map((leg) => ({ token: leg.token, amount: leg.amount.toString(), kind: leg.kind })),
    inputNullifiers: [...source.inputNullifiers],
    expiresAt: new Date(source.expiresAt!).toISOString(),
  },
});

const merge = (transactions: any[]): FakeTx => {
  if (transactions.length === 0) throw new Error("empty merge");
  return fakeTx(
    transactions.map((transaction) => transaction.label).join("+"),
    transactions.flatMap((transaction) => transaction.rows ?? []),
  );
};

function harness(options: {
  current?: boolean;
  maxParallelSwaps?: number;
  offers?: BookOffer[];
  exactResponse?: (offers: BookOffer[]) => ExactFilesResponse | Promise<ExactFilesResponse>;
  status?: "live" | "consumed" | "cancelled" | "expired" | "unknown";
  semanticMismatch?: boolean;
  failImbalance?: boolean;
  walletOperationTimeoutMs?: number;
  blockWallet?: boolean;
  blockStatus?: boolean;
  mirrorRevertFailures?: number;
  revertFailures?: number;
} = {}) {
  const book = new Book();
  const sources = options.offers ?? [offer(H1, N1, 10n, 20n)];
  for (const source of sources) book.upsert(source);
  let current = options.current ?? true;
  let now = Date.now();
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000n, [B]: 1_000n });
  const calls: string[] = [];
  const reverts: unknown[] = [];
  let blockExact: (() => void) | null = null;
  let exactBarrier: Promise<void> | null = null;
  let releaseWallet: (() => void) | null = null;
  const walletBarrier = options.blockWallet
    ? new Promise<void>((resolve) => { releaseWallet = resolve; })
    : null;
  let releaseStatus: (() => void) | null = null;
  const statusBarrier = options.blockStatus
    ? new Promise<void>((resolve) => { releaseStatus = resolve; })
    : null;
  let mirrorRevertFailures = options.mirrorRevertFailures ?? 0;
  let revertFailures = options.revertFailures ?? 0;

  const wallet: SwapJobWallet = {
    shielded: { getAddress: async () => "solver-address" },
    dust: {
      balanceTransactions: async () => {
        calls.push("dust-balance");
        return fakeTx("dust-unproven", [{ seg: 0, tag: "dust", raw: "dust", amount: 1n }]);
      },
    },
    initSwap: async (inputs) => {
      if (walletBarrier) await walletBarrier;
      const token = Object.keys((inputs as any).shielded)[0]!;
      calls.push(token === A ? "mirror" : "residual");
      return {
        transaction: token === A
          ? fakeTx("mirror", [{ seg: 0, tag: "shielded", raw: A, amount: 1n }])
          : fakeTx("residual", makerRows(5n, 5n)),
      };
    },
    finalizeTransaction: async (transaction: any) => {
      calls.push(`finalize:${transaction.label}`);
      return transaction.label === "residual"
        ? fakeTx("residual-final", makerRows(5n, 5n)) as any
        : fakeTx("dust-final", [{ seg: 0, tag: "dust", raw: "dust", amount: 1n }]) as any;
    },
    revertTransaction: async () => {
      calls.push("mirror-revert");
      if (mirrorRevertFailures > 0) {
        mirrorRevertFailures -= 1;
        throw new Error("mirror revert failed");
      }
    },
    revert: async (transaction) => {
      calls.push("revert");
      if (revertFailures > 0) {
        revertFailures -= 1;
        throw new Error("finalized revert failed");
      }
      reverts.push(transaction);
    },
  };

  const exact = options.exactResponse ?? ((requested: BookOffer[]): ExactFilesResponse => ({
    schemaVersion: 1,
    profile: "native-shielded-v1",
    files: requested.map((source) => ({
      offerId: source.offerHash,
      verdict: validVerdict(source),
      offer: `blob:${source.offerHash}`,
    })),
  }));

  const executor = startSwapJobExecutor({
    cache: { book, isCurrent: () => current },
    stock,
    wallet,
    keys: { dustSecretKey: "dust-key" },
    maxParallelSwaps: options.maxParallelSwaps ?? 2,
    expiryMarginSeconds: 120,
    settleTtlMinutes: 1,
    sweepIntervalMs: 60_000,
    nowMs: () => now,
    dependencies: {
      readExactOfferFiles: async (offerIds) => {
        calls.push("exact-files");
        if (exactBarrier) await exactBarrier;
        return await exact(offerIds.map((offerId) => sources.find((source) => source.offerHash === offerId)!));
      },
      getOfferStatus: async (offerId) => {
        if (statusBarrier) await statusBarrier;
        return { offerId, status: options.status ?? "live" };
      },
      reconstructOffer: (blob) => {
        const hash = blob.slice("blob:".length);
        const source = sources.find((candidate) => candidate.offerHash === hash)!;
        return fakeTx(`maker:${hash}`, makerRows(source.wants[0]!.amount, source.gives[0]!.amount)) as any;
      },
      deriveOfferSemantics: (transaction: any) => {
        const hash = transaction.label.slice("maker:".length);
        const derived = semantics(sources.find((source) => source.offerHash === hash)!);
        if (options.semanticMismatch) derived.gives[0]!.amount = "999";
        return derived;
      },
      mergeFinalized: merge as any,
      tokenImbalances: ((transaction: FakeTx) => {
        if (options.failImbalance) throw new Error("imbalance inspection failed");
        return transaction.rows;
      }) as any,
    },
    onOfferConsumed: (offerHash) => book.remove(offerHash),
    ...(options.walletOperationTimeoutMs === undefined
      ? {}
      : { walletOperationTimeoutMs: options.walletOperationTimeoutMs }),
  });

  return {
    executor,
    book,
    stock,
    calls,
    reverts,
    setCurrent: (value: boolean) => { current = value; },
    advance: (ms: number) => { now += ms; },
    blockExact: () => {
      exactBarrier = new Promise<void>((resolve) => { blockExact = resolve; });
    },
    releaseExact: () => blockExact?.(),
    releaseWallet: () => releaseWallet?.(),
    releaseStatus: () => releaseStatus?.(),
  };
}

test("exact-boundary job fetches exact files after arrival, funds DUST, and returns only the inverse half", async () => {
  const h = harness();
  const result = await h.executor.onSwap(job());
  expect(result.type).toBe("swap-tx");
  expect(h.calls).toEqual([
    "exact-files",
    "mirror",
    "mirror-revert",
    "dust-balance",
    "finalize:dust-unproven",
  ]);
  expect(h.executor.stats()).toMatchObject({ building: 0, awaitingRelay: 1, refused: 0 });
  await h.executor.stop();
});

test("between-rung job uses whole exact offers plus bounded solver residual", async () => {
  const h = harness({ offers: [offer(H1, N1, 10n, 20n), offer(H2, N2, 10n, 10n)] });
  const result = await h.executor.onSwap(job("residual", "15", "25"));
  expect(result.type).toBe("swap-tx");
  expect(h.calls).toContain("residual");
  expect(h.stock.reserved(B)).toBe(5n);
  await h.executor.stop();
});

test("cache staleness and quote-time/job-time ladder drift fail before exact-file or wallet work", async () => {
  const stale = harness({ current: false });
  expect(await stale.executor.onSwap(job())).toEqual({ type: "job-error", jobId: "job-1", reason: JOB_CACHE_NOT_CURRENT });
  expect(stale.calls).toEqual([]);
  await stale.executor.stop();

  const drift = harness();
  expect(await drift.executor.onSwap(job("drift", "10", "21"))).toEqual({
    type: "job-error",
    jobId: "drift",
    reason: JOB_ROUTE_NOT_CURRENT,
  });
  expect(drift.calls).toEqual([]);
  await drift.executor.stop();
});

test("consumed, expired, unknown, and mismatched exact files are stable job errors with zero wallet mutation", async () => {
  for (const code of ["NOT_LIVE", "EXPIRED", "NOT_INDEXED", "HASH_MISMATCH"] as const) {
    const h = harness({
      exactResponse: (offers) => ({
        schemaVersion: 1,
        profile: "native-shielded-v1",
        files: offers.map((source) => ({
          offerId: source.offerHash,
          verdict: {
            ...validVerdict(source),
            valid: false,
            live: false,
            code,
            status: code === "NOT_LIVE" ? "consumed" : code === "EXPIRED" ? "expired" : "not_indexed",
            reason: code.toLowerCase(),
            computed: undefined,
          } as OfferValidationVerdict,
        })),
      }),
    });
    expect(await h.executor.onSwap(job(`negative-${code}`))).toEqual({
      type: "job-error",
      jobId: `negative-${code}`,
      reason: JOB_EXACT_FILE_REFUSED,
    });
    expect(h.calls).toEqual(["exact-files"]);
    expect(h.stock.reserved(B)).toBe(0n);
    await h.executor.stop();
  }

  const mismatch = harness({ semanticMismatch: true });
  expect(await mismatch.executor.onSwap(job("mismatch", "10", "20"))).toEqual({
    type: "job-error",
    jobId: "mismatch",
    reason: JOB_EXACT_FILE_MISMATCH,
  });
  expect(mismatch.calls).toEqual(["exact-files"]);
  expect(mismatch.stock.reserved(B)).toBe(0n);
  await mismatch.executor.stop();

  const projectionDrift = harness({
    exactResponse: (offers) => ({
      schemaVersion: 1,
      profile: "native-shielded-v1",
      files: offers.map((source) => {
        const verdict = validVerdict(source);
        return {
          offerId: source.offerHash,
          verdict: {
            ...verdict,
            computed: {
              ...verdict.computed!,
              expiresAt: new Date(source.expiresAt! + 1_000).toISOString(),
            },
          },
          offer: `blob:${source.offerHash}`,
        };
      }),
    }),
  });
  expect(await projectionDrift.executor.onSwap(job("projection-drift"))).toEqual({
    type: "job-error",
    jobId: "projection-drift",
    reason: JOB_EXACT_FILE_MISMATCH,
  });
  expect(projectionDrift.calls).toEqual(["exact-files"]);
  expect(projectionDrift.stock.reserved(B)).toBe(0n);
  await projectionDrift.executor.stop();
});

test("duplicate jobIds and maxParallelSwaps are enforced while exact fetch is in flight", async () => {
  const h = harness({ maxParallelSwaps: 1 });
  h.blockExact();
  const first = h.executor.onSwap(job("held"));
  await Promise.resolve();
  expect(await h.executor.onSwap(job("held"))).toEqual({ type: "job-error", jobId: "held", reason: JOB_DUPLICATE });
  expect(await h.executor.onSwap(job("other"))).toEqual({ type: "job-error", jobId: "other", reason: JOB_AT_CAPACITY });
  h.releaseExact();
  expect((await first).type).toBe("swap-tx");
  await h.executor.stop();
});

test("stop joins an already accepted job and reverts its solver-owned result", async () => {
  const h = harness();
  h.blockExact();
  const swap = h.executor.onSwap(job("shutdown-race"));
  await Promise.resolve();
  let stopped = false;
  const stop = h.executor.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  h.releaseExact();
  expect((await swap).type).toBe("swap-tx");
  await stop;
  expect(stopped).toBe(true);
  expect(h.reverts).toHaveLength(1);
  expect(h.executor.stats()).toMatchObject({ awaitingRelay: 0, stopped: true });
});

test("submit-failed reverts the cached solver-owned transaction; tx-submitted clears it without revert", async () => {
  const failed = harness();
  expect((await failed.executor.onSwap(job("failed"))).type).toBe("swap-tx");
  failed.executor.onSubmitFailed({ type: "submit-failed", jobId: "failed", reason: "chain refused" });
  await failed.executor.idle();
  expect(failed.reverts).toHaveLength(1);
  expect(failed.executor.stats().awaitingRelay).toBe(0);
  await failed.executor.stop();

  const submitted = harness({ status: "consumed" });
  expect((await submitted.executor.onSwap(job("submitted"))).type).toBe("swap-tx");
  submitted.executor.onTxSubmitted({ type: "tx-submitted", jobId: "submitted", txId: "tx-1" });
  await submitted.executor.sweep();
  expect(submitted.reverts).toHaveLength(0);
  expect(submitted.book.get(H1)).toBeUndefined();
  expect(submitted.executor.stats()).toMatchObject({ awaitingConsumption: 0, completed: 1 });
  await submitted.executor.stop();
});

test("missed relay terminal signal is recovered by the chain-TTL sweeper", async () => {
  for (const status of ["live", "consumed"] as const) {
    const h = harness({ status });
    expect((await h.executor.onSwap(job(`missed-${status}`))).type).toBe("swap-tx");
    h.advance(60_001);
    await h.executor.sweep();
    expect(h.reverts).toHaveLength(1);
    expect(h.executor.stats()).toMatchObject({ awaitingRelay: 0, reverted: 1, completed: 0 });
    await h.executor.stop();
  }
});

test("tx-submitted racing a TTL status read can never revert the submitted wallet half", async () => {
  const h = harness({ status: "consumed", blockStatus: true });
  expect((await h.executor.onSwap(job("submitted-during-sweep"))).type).toBe("swap-tx");
  h.advance(60_001);
  const sweep = h.executor.sweep();
  await Promise.resolve();
  h.executor.onTxSubmitted({
    type: "tx-submitted",
    jobId: "submitted-during-sweep",
    txId: "tx-raced-sweeper",
  });
  h.releaseStatus();
  await sweep;
  expect(h.reverts).toHaveLength(0);
  expect(h.executor.stats()).toMatchObject({
    awaitingRelay: 0,
    awaitingConsumption: 0,
    completed: 1,
    reverted: 0,
  });
  await h.executor.stop();
});

test("wallet timeout retains the slot until late proof work is reverted", async () => {
  const h = harness({ blockWallet: true, walletOperationTimeoutMs: 5, maxParallelSwaps: 1 });
  expect(await h.executor.onSwap(job("timeout"))).toEqual({
    type: "job-error",
    jobId: "timeout",
    reason: JOB_WALLET_TIMEOUT,
  });
  expect(h.executor.stats()).toMatchObject({ building: 1, timedOutBuilds: 1 });
  expect(await h.executor.onSwap(job("blocked"))).toEqual({
    type: "job-error",
    jobId: "blocked",
    reason: JOB_AT_CAPACITY,
  });
  h.releaseWallet();
  await h.executor.idle();
  expect(h.executor.stats()).toMatchObject({ building: 0, awaitingRelay: 0, reverted: 1 });
  expect(h.reverts).toHaveLength(1);
  await h.executor.stop();
});

test("a timed-out build whose late cleanup fails stays quarantined for the TTL sweeper", async () => {
  const h = harness({
    blockWallet: true,
    walletOperationTimeoutMs: 5,
    failImbalance: true,
    revertFailures: 1,
  });
  expect((await h.executor.onSwap(job("late-cleanup"))).type).toBe("job-error");
  h.releaseWallet();
  await h.executor.idle();
  expect(h.executor.stats()).toMatchObject({ building: 0, awaitingRelay: 1 });
  h.advance(60_001);
  await h.executor.sweep();
  expect(h.executor.stats()).toMatchObject({ awaitingRelay: 0, reverted: 1 });
  await h.executor.stop();
});

test("failed immediate rollback is cached and retried; relay signals cannot clear the quarantine", async () => {
  const h = harness({ failImbalance: true, revertFailures: 1 });
  expect(await h.executor.onSwap(job("cleanup"))).toEqual({
    type: "job-error",
    jobId: "cleanup",
    reason: JOB_WALLET_FAILED,
  });
  expect(h.executor.stats()).toMatchObject({ awaitingRelay: 1, revertFailures: 0 });
  h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "cleanup", txId: "should-be-ignored" });
  h.executor.onSubmitFailed({ type: "submit-failed", jobId: "cleanup", reason: "should-be-ignored" });
  expect(h.executor.stats().awaitingRelay).toBe(1);
  h.advance(60_001);
  await h.executor.sweep();
  expect(h.executor.stats()).toMatchObject({ awaitingRelay: 0, reverted: 1 });
  expect(h.stock.reserved(B)).toBe(0n);
  await h.executor.stop();
});

test("unfinalized mirror uncertainty occupies capacity until the sweeper gets a wallet acknowledgement", async () => {
  const h = harness({ mirrorRevertFailures: 2, maxParallelSwaps: 1 });
  expect(await h.executor.onSwap(job("mirror-uncertain"))).toEqual({
    type: "job-error",
    jobId: "mirror-uncertain",
    reason: JOB_WALLET_FAILED,
  });
  expect(h.executor.stats().quarantined).toBe(1);
  expect(await h.executor.onSwap(job("blocked-by-quarantine"))).toEqual({
    type: "job-error",
    jobId: "blocked-by-quarantine",
    reason: JOB_AT_CAPACITY,
  });
  await h.executor.sweep();
  expect(h.executor.stats()).toMatchObject({ quarantined: 0, reverted: 1 });
  await h.executor.stop();
});
