import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExactFilesResponse } from "@zswap-da/solver-core/exact-files-contract";
import type { OfferValidationVerdict } from "@zswap-da/solver-core/validation-contract";
import type { Imbalance } from "@zswap-da/solver-core/batcher";
import type { SwapMessage } from "@zswap-da/solver-core/relay-ws-contract";

import { Book, type BookOffer } from "./src/book.ts";
import { SolverOperationJournal } from "./src/operation-journal.ts";
import { Stock } from "./src/stock.ts";
import { deriveLadderPush } from "./src/ladder-source.ts";
import {
  JOB_AT_CAPACITY,
  JOB_CACHE_NOT_CURRENT,
  JOB_DUPLICATE,
  JOB_EXACT_FILE_MISMATCH,
  JOB_EXACT_FILE_REFUSED,
  JOB_ROUTE_NOT_CURRENT,
  JOB_WALLET_FAILED,
  JOB_WALLET_TIMEOUT,
  JOB_PAIR_UNSUPPORTED,
  JOB_MIN_OUTPUT,
  JOB_DUST_PER_JOB,
  JOB_DUST_WINDOW,
  JOB_DUST_ESTIMATE,
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
const RELAY_TX = `0x${"cd".repeat(32)}`;
const LEDGER_TX = "ef".repeat(32);

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
  relayStatus?: "pending" | "solving" | "done" | "error";
  positiveEvidence?: boolean;
  ledgerTxByOffer?: Record<string, string>;
  evidenceThrows?: boolean;
  semanticMismatch?: boolean;
  failImbalance?: boolean;
  walletOperationTimeoutMs?: number;
  blockWallet?: boolean;
  blockStatus?: boolean;
  mirrorRevertFailures?: number;
  revertFailures?: number;
  supportedPairs?: ReadonlySet<string> | null;
  minJobOutput?: ReadonlyMap<string, bigint> | null;
  dustAdmission?: { maxPerJob: bigint; maxPerWindow: bigint; windowMs: number } | null;
  dustAmount?: bigint | null;
  journalPath?: string;
} = {}) {
  const book = new Book();
  const sources = options.offers ?? [offer(H1, N1, 10n, 20n)];
  for (const source of sources) book.upsert(source);
  let current = options.current ?? true;
  let now = Date.now();
  let backendStatus = options.status ?? "live";
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
  let dustWindowBlocks = 0;

  const wallet: SwapJobWallet = {
    shielded: { getAddress: async () => "solver-address" },
    dust: {
      balanceTransactions: async () => {
        calls.push("dust-balance");
        return fakeTx("dust-unproven", options.dustAmount === null ? [] : [
          { seg: 0, tag: "dust", raw: "dust", amount: options.dustAmount ?? 1n },
        ]);
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
    revertTransaction: async (transaction: any) => {
      const mirror = transaction?.label === "mirror";
      calls.push(mirror ? "mirror-revert" : `revert-unproven:${transaction?.label ?? "unknown"}`);
      if (mirror && mirrorRevertFailures > 0) {
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

  const journal = SolverOperationJournal.open({
    path: options.journalPath ?? ":memory:",
    allowMemory: options.journalPath === undefined,
    nowMs: () => now,
  });
  const activeExecutor = startSwapJobExecutor({
    cache: { book, isCurrent: () => current },
    stock,
    wallet,
    journal,
    keys: { dustSecretKey: "dust-key" },
    relayHttpUrl: "http://relay.test/api/v1",
    maxParallelSwaps: options.maxParallelSwaps ?? 2,
    expiryMarginSeconds: 120,
    settleTtlMinutes: 1,
    ...(options.supportedPairs === undefined ? {} : { supportedPairs: options.supportedPairs }),
    ...(options.minJobOutput === undefined ? {} : { minJobOutput: options.minJobOutput }),
    ...(options.dustAdmission === undefined ? {} : { dustAdmission: options.dustAdmission }),
    onDustWindowBlocked: () => { dustWindowBlocks += 1; },
    sweepIntervalMs: 60_000,
    nowMs: () => now,
    dependencies: {
      readExactOfferFiles: async (offerIds) => {
        calls.push("exact-files");
        if (exactBarrier) await exactBarrier;
        return await exact(offerIds.map((offerId) => sources.find((source) => source.offerHash === offerId)!));
      },
      getOfferConsumptionEvidence: async (offerId) => {
        if (statusBarrier) await statusBarrier;
        if (options.evidenceThrows) throw new Error("malformed backend response");
        const status = backendStatus;
        return status === "consumed" && options.positiveEvidence !== false
          ? { version: 1 as const, offerId, status, evidence: {
            ledgerTxHash: options.ledgerTxByOffer?.[offerId] ?? LEDGER_TX,
            height: 88,
          } }
          : { version: 1 as const, offerId, status: status === "unknown" ? "not_found" as const : status };
      },
      getRelayJobStatus: async () => {
        const status = options.relayStatus ?? "pending";
        if (status === "done") return { status, txId: RELAY_TX };
        if (status === "error") return { status, reason: "relay rejected" };
        return { status };
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
      serializeUnproven: (transaction: any) => transaction.serialize(),
      deserializeUnproven: (bytes) => fakeTx(new TextDecoder().decode(bytes)),
      serializeFinalized: (transaction: any) => transaction.serialize(),
      deserializeFinalized: (bytes) => fakeTx(new TextDecoder().decode(bytes)) as any,
    },
    onOfferConsumed: (offerHash) => book.remove(offerHash),
    ...(options.walletOperationTimeoutMs === undefined
      ? {}
      : { walletOperationTimeoutMs: options.walletOperationTimeoutMs }),
  });
  let closed = false;
  const executor = {
    ...activeExecutor,
    stop: async () => {
      await activeExecutor.stop();
      if (!closed) {
        closed = true;
        journal.close();
      }
    },
  };

  return {
    executor,
    book,
    stock,
    calls,
    reverts,
    journal,
    setCurrent: (value: boolean) => { current = value; },
    advance: (ms: number) => { now += ms; },
    setStatus: (status: "live" | "consumed" | "cancelled" | "expired" | "unknown") => {
      backendStatus = status;
    },
    blockExact: () => {
      exactBarrier = new Promise<void>((resolve) => { blockExact = resolve; });
    },
    releaseExact: () => blockExact?.(),
    releaseWallet: () => releaseWallet?.(),
    releaseStatus: () => releaseStatus?.(),
    dustWindowBlocks: () => dustWindowBlocks,
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
  expect(h.journal.list().map((row) => [row.operationKind, row.lifecycleState])).toEqual([
    ["JOB_SETTLEMENT", "AWAITING_RELAY"],
    ["MIRROR_RESERVATION", "REVERTED"],
    ["MIRROR_REVERT", "REVERTED"],
    ["DUST_BALANCE", "AWAITING_RELAY"],
    ["FINALIZED_CONTRIBUTION", "AWAITING_RELAY"],
  ]);
  await h.executor.stop();
});

test("between-rung job uses whole exact offers plus bounded solver residual", async () => {
  const h = harness({ offers: [offer(H1, N1, 10n, 20n), offer(H2, N2, 10n, 10n)] });
  const result = await h.executor.onSwap(job("residual", "15", "25"));
  expect(result.type).toBe("swap-tx");
  expect(h.calls).toContain("residual");
  expect(h.stock.reserved(B)).toBe(5n);
  expect(h.journal.list().filter((row) => row.operationKey.endsWith(":residual"))
    .map((row) => row.operationKind)).toEqual(["RESIDUAL_BUILD", "FINALIZED_CONTRIBUTION"]);
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

test("RF3 pair and minimum policy is rechecked at job time before exact or wallet work", async () => {
  const unsupported = harness({ supportedPairs: new Set([`${B}->${A}`]) });
  expect(await unsupported.executor.onSwap(job("unsupported"))).toEqual({
    type: "job-error", jobId: "unsupported", reason: JOB_PAIR_UNSUPPORTED,
  });
  expect(unsupported.calls).toEqual([]);
  await unsupported.executor.stop();

  const minimum = harness({ minJobOutput: new Map([[B, 21n]]) });
  expect(await minimum.executor.onSwap(job("too-small"))).toEqual({
    type: "job-error", jobId: "too-small", reason: JOB_MIN_OUTPUT,
  });
  expect(minimum.calls).toEqual([]);
  await minimum.executor.stop();

  const open = harness({ supportedPairs: null, minJobOutput: null });
  expect((await open.executor.onSwap(job("open"))).type).toBe("swap-tx");
  await open.executor.stop();
});

test("RF3 DUST estimate is atomically reserved; per-job/window refusal leaves zero retained mutation", async () => {
  const perJob = harness({
    dustAmount: 3n,
    dustAdmission: { maxPerJob: 2n, maxPerWindow: 10n, windowMs: 60_000 },
  });
  expect(await perJob.executor.onSwap(job("per-job"))).toEqual({
    type: "job-error", jobId: "per-job", reason: JOB_DUST_PER_JOB,
  });
  expect(perJob.calls).toContain("revert-unproven:dust-unproven");
  expect(perJob.stock.reserved(B)).toBe(0n);
  expect(perJob.journal.listDustReservations()).toEqual([]);
  await perJob.executor.stop();

  const window = harness({
    offers: [offer(H1, N1, 10n, 20n), offer(H2, N2, 10n, 20n)],
    dustAmount: 6n,
    dustAdmission: { maxPerJob: 10n, maxPerWindow: 10n, windowMs: 60_000 },
  });
  expect((await window.executor.onSwap(job("window-first"))).type).toBe("swap-tx");
  expect(await window.executor.onSwap(job("window-second"))).toEqual({
    type: "job-error", jobId: "window-second", reason: JOB_DUST_WINDOW,
  });
  expect(window.dustWindowBlocks()).toBe(1);
  expect(window.executor.dustAvailable()).toBe(false);
  expect(deriveLadderPush({
    book: window.book,
    isCurrent: window.executor.dustAvailable,
  }, { nowMs: Date.now(), expiryMarginSeconds: 120 }).priceLevels.levels).toEqual([]);
  expect(window.journal.listDustReservations()).toHaveLength(1);
  await window.executor.onSubmitFailed({
    type: "submit-failed", jobId: "window-first", reason: "relay refused",
  });
  expect(window.journal.listDustReservations()[0]!.state).toBe("RELEASED");
  expect(window.executor.dustAvailable()).toBe(true);
  expect(deriveLadderPush({
    book: window.book,
    isCurrent: window.executor.dustAvailable,
  }, { nowMs: Date.now(), expiryMarginSeconds: 120 }).priceLevels.levels).not.toEqual([]);
  expect((await window.executor.onSwap(job("window-recovered"))).type).toBe("swap-tx");
  await window.executor.stop();
});

test("RF3 unavailable DUST estimate fails closed and reverts the estimator mutation", async () => {
  const h = harness({
    dustAmount: null,
    dustAdmission: { maxPerJob: 10n, maxPerWindow: 10n, windowMs: 60_000 },
  });
  expect(await h.executor.onSwap(job("estimate-missing"))).toEqual({
    type: "job-error", jobId: "estimate-missing", reason: JOB_DUST_ESTIMATE,
  });
  expect(h.calls).toContain("revert-unproven:dust-unproven");
  expect(h.stock.reserved(B)).toBe(0n);
  await h.executor.stop();
});

test("RF3 DUST reservation becomes rolling-window spend only after proven settlement", async () => {
  const h = harness({
    status: "consumed",
    dustAmount: 4n,
    dustAdmission: { maxPerJob: 5n, maxPerWindow: 5n, windowMs: 100 },
  });
  expect((await h.executor.onSwap(job("dust-settled"))).type).toBe("swap-tx");
  expect(h.journal.listDustReservations()[0]).toMatchObject({ state: "RESERVED", amount: 4n });
  await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "dust-settled", txId: RELAY_TX });
  expect(h.journal.listDustReservations()[0]).toMatchObject({ state: "SPENT", amount: 4n });
  expect(h.journal.dustUsage(100)).toBe(4n);
  h.advance(101);
  expect(h.journal.dustUsage(100)).toBe(0n);
  await h.executor.stop();
});

test("concurrent RF3 jobs cannot oversubscribe one durable DUST window", async () => {
  const h = harness({
    offers: [offer(H1, N1, 10n, 20n), offer(H2, N2, 10n, 20n)],
    maxParallelSwaps: 2,
    dustAmount: 6n,
    dustAdmission: { maxPerJob: 10n, maxPerWindow: 10n, windowMs: 60_000 },
  });
  const results = await Promise.all([
    h.executor.onSwap(job("concurrent-a")),
    h.executor.onSwap(job("concurrent-b")),
  ]);
  expect(results.filter((result) => result.type === "swap-tx")).toHaveLength(1);
  expect(results.filter((result) => result.type === "job-error" && result.reason === JOB_DUST_WINDOW))
    .toHaveLength(1);
  expect(h.journal.listDustReservations().filter((row) => row.state === "RESERVED"))
    .toHaveLength(1);
  expect(h.journal.dustUsage(60_000)).toBe(6n);
  await h.executor.stop();
});

test("restart preserves an unresolved DUST reservation and releases it only after proved revert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cow-rf3-dust-restart-"));
  const path = join(directory, "operations.sqlite");
  try {
    const first = harness({
      journalPath: path,
      dustAmount: 4n,
      dustAdmission: { maxPerJob: 5n, maxPerWindow: 5n, windowMs: 60_000 },
      relayStatus: "pending",
    });
    expect((await first.executor.onSwap(job("dust-restart"))).type).toBe("swap-tx");
    expect(first.journal.dustUsage(60_000)).toBe(4n);
    await first.executor.stop();

    const reopened = harness({
      journalPath: path,
      dustAmount: 4n,
      dustAdmission: { maxPerJob: 5n, maxPerWindow: 5n, windowMs: 60_000 },
      relayStatus: "error",
      status: "live",
    });
    await reopened.executor.ready;
    expect(reopened.journal.dustUsage(60_000)).toBe(0n);
    expect(reopened.journal.listDustReservations()).toEqual([]);
    expect(reopened.reverts).toHaveLength(1);
    await reopened.executor.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("stop joins an accepted job and quarantines an unresolved relay outcome", async () => {
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
  expect(h.reverts).toHaveLength(0);
  expect(h.executor.stats()).toMatchObject({ awaitingRelay: 0, quarantined: 1, stopped: true });
});

test("submit-failed reverts the cached solver-owned transaction; tx-submitted clears it without revert", async () => {
  const failed = harness();
  expect((await failed.executor.onSwap(job("failed"))).type).toBe("swap-tx");
  await failed.executor.onSubmitFailed({ type: "submit-failed", jobId: "failed", reason: "chain refused" });
  expect(failed.reverts).toHaveLength(1);
  expect(failed.executor.stats().awaitingRelay).toBe(0);
  await failed.executor.stop();

  const submitted = harness({ status: "consumed" });
  expect((await submitted.executor.onSwap(job("submitted"))).type).toBe("swap-tx");
  await submitted.executor.onTxSubmitted({ type: "tx-submitted", jobId: "submitted", txId: RELAY_TX });
  expect(submitted.reverts).toHaveLength(0);
  expect(submitted.book.get(H1)).toBeUndefined();
  expect(submitted.executor.stats()).toMatchObject({ awaitingConsumption: 0, completed: 1 });
  await submitted.executor.stop();
});

test("duplicate terminal delivery is idempotent and conflicting frames remain quarantined", async () => {
  const duplicate = harness({ status: "consumed" });
  expect((await duplicate.executor.onSwap(job("duplicate-terminal"))).type).toBe("swap-tx");
  await duplicate.executor.onTxSubmitted({
    type: "tx-submitted", jobId: "duplicate-terminal", txId: RELAY_TX,
  });
  await duplicate.executor.onTxSubmitted({
    type: "tx-submitted", jobId: "duplicate-terminal", txId: RELAY_TX,
  });
  expect(duplicate.executor.stats()).toMatchObject({ completed: 1, quarantined: 0 });
  expect(duplicate.reverts).toHaveLength(0);
  await duplicate.executor.stop();

  const doneThenError = harness({ status: "live" });
  expect((await doneThenError.executor.onSwap(job("done-then-error"))).type).toBe("swap-tx");
  await doneThenError.executor.onTxSubmitted({
    type: "tx-submitted", jobId: "done-then-error", txId: RELAY_TX,
  });
  await doneThenError.executor.onSubmitFailed({
    type: "submit-failed", jobId: "done-then-error", reason: "contradictory failure",
  });
  expect(doneThenError.executor.stats()).toMatchObject({ completed: 0, reverted: 0, quarantined: 1 });
  expect(doneThenError.journal.list().find((row) => row.operationKind === "JOB_SETTLEMENT")!.receipt)
    .toMatchObject({ relayState: "done", relayExtrinsicHash: RELAY_TX });
  await doneThenError.executor.stop();

  const errorThenDone = harness({ status: "consumed" });
  expect((await errorThenDone.executor.onSwap(job("error-then-done"))).type).toBe("swap-tx");
  await errorThenDone.executor.onSubmitFailed({
    type: "submit-failed", jobId: "error-then-done", reason: "relay failure",
  });
  await errorThenDone.executor.onTxSubmitted({
    type: "tx-submitted", jobId: "error-then-done", txId: RELAY_TX,
  });
  expect(errorThenDone.executor.stats()).toMatchObject({ completed: 0, reverted: 0, quarantined: 1 });
  expect(errorThenDone.journal.list().find((row) => row.operationKind === "JOB_SETTLEMENT")!.receipt)
    .toMatchObject({ relayState: "error" });
  await errorThenDone.executor.stop();
});

test("backend lag, split ledger hashes, markerless consumption, and malformed reads fail closed", async () => {
  const lag = harness({ status: "live" });
  expect((await lag.executor.onSwap(job("backend-lag"))).type).toBe("swap-tx");
  await lag.executor.onTxSubmitted({ type: "tx-submitted", jobId: "backend-lag", txId: RELAY_TX });
  expect(lag.executor.stats().quarantined).toBe(1);
  lag.setStatus("consumed");
  await lag.executor.sweep();
  expect(lag.executor.stats()).toMatchObject({ quarantined: 0, completed: 1 });
  await lag.executor.stop();

  const two = [offer(H1, N1, 10n, 20n), offer(H2, N2, 10n, 10n)];
  const split = harness({
    offers: two,
    status: "consumed",
    ledgerTxByOffer: { [H1]: LEDGER_TX, [H2]: "ab".repeat(32) },
  });
  expect((await split.executor.onSwap(job("split-ledger", "20", "30"))).type).toBe("swap-tx");
  await split.executor.onTxSubmitted({ type: "tx-submitted", jobId: "split-ledger", txId: RELAY_TX });
  expect(split.executor.stats()).toMatchObject({ quarantined: 1, completed: 0 });
  await split.executor.stop();

  for (const [name, options] of [
    ["markerless", { status: "consumed" as const, positiveEvidence: false }],
    ["malformed", { status: "consumed" as const, evidenceThrows: true }],
  ] as const) {
    const uncertain = harness(options);
    expect((await uncertain.executor.onSwap(job(name))).type).toBe("swap-tx");
    await uncertain.executor.onTxSubmitted({ type: "tx-submitted", jobId: name, txId: RELAY_TX });
    expect(uncertain.executor.stats()).toMatchObject({ quarantined: 1, completed: 0, reverted: 0 });
    await uncertain.executor.stop();
  }
});

test("offer_consumed is wake-only and still requires both HTTP authorities", async () => {
  const h = harness({ status: "live", relayStatus: "done" });
  expect((await h.executor.onSwap(job("wake-only"))).type).toBe("swap-tx");
  h.executor.notifyConsumed(H1);
  await h.executor.idle();
  expect(h.executor.stats()).toMatchObject({ completed: 0, quarantined: 1 });
  expect(h.executor.unavailableOfferHashes()).toEqual([H1]);

  h.setStatus("consumed");
  h.executor.notifyConsumed(H1);
  await h.executor.idle();
  expect(h.executor.stats()).toMatchObject({ completed: 1, quarantined: 0 });
  await h.executor.stop();
});

test("missed relay terminal signal is recovered from relay HTTP without hash-domain comparison", async () => {
  for (const status of ["live", "consumed"] as const) {
    const h = harness({ status, relayStatus: status === "live" ? "error" : "done" });
    expect((await h.executor.onSwap(job(`missed-${status}`))).type).toBe("swap-tx");
    h.advance(60_001);
    await h.executor.sweep();
    expect(h.reverts).toHaveLength(status === "live" ? 1 : 0);
    expect(h.executor.stats()).toMatchObject(status === "live"
      ? { awaitingRelay: 0, reverted: 1, completed: 0 }
      : { awaitingRelay: 0, reverted: 0, completed: 1 });
    if (status === "consumed") {
      const receipt = h.journal.list().find((row) => row.operationKind === "JOB_SETTLEMENT")!.receipt;
      expect(receipt).toEqual({
        relayJobId: "missed-consumed",
        relayState: "done",
        relayExtrinsicHash: RELAY_TX,
        ledgerTxHash: LEDGER_TX,
        ledgerHeight: 88,
      });
      expect(receipt.relayExtrinsicHash).not.toBe(receipt.ledgerTxHash);
    }
    await h.executor.stop();
  }
});

test("tx-submitted racing a TTL status read can never revert the submitted wallet half", async () => {
  const h = harness({ status: "consumed", blockStatus: true });
  expect((await h.executor.onSwap(job("submitted-during-sweep"))).type).toBe("swap-tx");
  h.advance(60_001);
  const sweep = h.executor.sweep();
  await Promise.resolve();
  const submitted = h.executor.onTxSubmitted({
    type: "tx-submitted",
    jobId: "submitted-during-sweep",
    txId: RELAY_TX,
  });
  h.releaseStatus();
  await Promise.all([sweep, submitted]);
  expect(h.reverts).toHaveLength(0);
  expect(h.executor.stats()).toMatchObject({
    awaitingRelay: 0,
    awaitingConsumption: 0,
    completed: 1,
    reverted: 0,
  });
  await h.executor.stop();
});

test("wallet timeout retains the slot until the late generation is durably terminal", async () => {
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
  expect(h.executor.stats()).toMatchObject({ building: 0, awaitingRelay: 0, quarantined: 0 });
  expect(h.executor.unavailableOfferHashes()).toEqual([]);
  expect(h.journal.list().every((row) => ["REVERTED", "FAILED"].includes(row.lifecycleState))).toBe(true);
  await h.executor.stop();
});

test("a timed-out wallet call cannot advance beyond its quarantined generation", async () => {
  const h = harness({
    blockWallet: true,
    walletOperationTimeoutMs: 5,
    failImbalance: true,
    revertFailures: 1,
  });
  expect((await h.executor.onSwap(job("late-cleanup"))).type).toBe("job-error");
  h.releaseWallet();
  await h.executor.idle();
  expect(h.executor.stats()).toMatchObject({ building: 0, awaitingRelay: 0, quarantined: 0 });
  const generations = new Set(h.journal.list().map((row) => row.generation));
  expect([...generations]).toEqual([1]);
  expect(h.journal.list().every((row) => ["REVERTED", "FAILED"].includes(row.lifecycleState))).toBe(true);
  await h.executor.stop();
});

test("failed immediate rollback is outcome-ambiguous and is never retried", async () => {
  const h = harness({ failImbalance: true, revertFailures: 1 });
  expect(await h.executor.onSwap(job("cleanup"))).toEqual({
    type: "job-error",
    jobId: "cleanup",
    reason: JOB_WALLET_FAILED,
  });
  expect(h.executor.stats()).toMatchObject({ quarantined: 1, revertFailures: 0 });
  await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "cleanup", txId: RELAY_TX });
  await h.executor.onSubmitFailed({ type: "submit-failed", jobId: "cleanup", reason: "should-be-ignored" });
  expect(h.executor.stats().quarantined).toBe(1);
  h.advance(60_001);
  await h.executor.sweep();
  expect(h.executor.stats()).toMatchObject({ quarantined: 1, reverted: 0, revertFailures: 1 });
  expect(h.stock.isClaimed({ offerHashes: [H1], nullifiers: [N1] })).toBe(true);
  expect(h.executor.unavailableOfferHashes()).not.toEqual([]);
  await h.executor.stop();
});

test("unfinalized mirror revert ambiguity remains fail-closed across sweeps", async () => {
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
  expect(h.executor.stats()).toMatchObject({ quarantined: 1, reverted: 0, revertFailures: 1 });
  expect(h.stock.isClaimed({ offerHashes: [H1], nullifiers: [N1] })).toBe(true);
  await h.executor.stop();
});
