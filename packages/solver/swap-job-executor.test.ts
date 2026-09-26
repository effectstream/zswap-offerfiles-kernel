import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admissionPairKey } from "@zswap-da/solver-core/admission-policy";
import { MAX_SETTLEMENT_AMOUNT } from "@zswap-da/solver-core/ladder-derivation";
import {
  DEFAULT_MODELLED_TAKER_INPUTS,
  FEE_SIZING_PLACEHOLDER_AMOUNT,
  MAX_MODELLED_TAKER_INPUTS,
  type FeeSizingStandInSpec,
} from "@zswap-da/solver-core/fee-sizing";
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
  JOB_ROUTE_UNAVAILABLE,
  JOB_WALLET_FAILED,
  JOB_WALLET_TIMEOUT,
  JOB_PAIR_UNSUPPORTED,
  JOB_MIN_OUTPUT,
  JOB_DUST_PER_JOB,
  JOB_DUST_WINDOW,
  JOB_DUST_ESTIMATE,
  resolveSwapJobRoute,
  startSwapJobExecutor,
  type ExactOfferSemantics,
  type SwapJobWallet,
} from "./src/swap-job-executor.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const D = "dd".repeat(32);
const E = "ee".repeat(32);
const H1 = "11".repeat(32);
const H2 = "22".repeat(32);
const H3 = "44".repeat(32);
const N1 = "31".repeat(32);
const N2 = "32".repeat(32);
const N3 = "33".repeat(32);
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

const makerOffer = (
  offerHash: string,
  nullifier: string,
  givesToken: string,
  givesAmount: bigint,
  wantsToken: string,
  wantsAmount: bigint,
): BookOffer => ({
  offerHash,
  gives: [{ token: givesToken, amount: givesAmount, kind: "SHIELDED" }],
  wants: [{ token: wantsToken, amount: wantsAmount, kind: "SHIELDED" }],
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

const swapJob = (
  jobId: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  amountOut: string,
): SwapMessage => ({ type: "swap", jobId, tokenIn, tokenOut, amountIn, amountOut });

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
  /** Fail the first N `revertTransaction` calls on an UNPROVEN artifact. Before
   *  00006 the only such artifact on the mandatory path was the fee-sizing
   *  mirror; the DUST balancing transaction is now the one that can be applied
   *  and then need rolling back. */
  unprovenRevertFailures?: number;
  revertFailures?: number;
  supportedPairs?: ReadonlySet<string> | null;
  minJobOutput?: ReadonlyMap<string, bigint> | null;
  dustAdmission?: { maxPerJob: bigint; maxPerWindow: bigint; windowMs: number } | null;
  dustAmount?: bigint | null;
  /** New-job economics are identical for any swap-token balance. */
  balances?: Record<string, bigint>;
  journalPath?: string;
  /** 00006 FR-001 / SC-001. `false` lets `initSwap` accept a tokenIn spend so a
   *  test can prove the refusal is what makes the difference. The default is
   *  `true`: EVERY executor test in this file runs against a wallet that cannot
   *  select tokenIn coins at all, which is the standing control that fee sizing
   *  is capital-free. */
  refuseTokenInSelection?: boolean;
  /** Fail the stand-in builder, to prove a fee-sizing failure needs no cleanup. */
  standInFailure?: string;
  /** Return a malformed receive-only residual so the new SDK-delta check fails. */
  invalidResidualDelta?: boolean;
  /** Preserve the raw residual but corrupt its finalized replacement. */
  invalidFinalizedResidualDelta?: boolean;
  /** Advance beyond maker expiry inside one wallet await to exercise ownership transfer. */
  expireDuring?: "init-swap" | "finalize-residual" | "dust-balance" | "finalize-dust";
  /** 00006 FR-001 / Q-R0-1. How many taker zswap inputs fee sizing models. */
  modelledTakerInputs?: number;
  /** Overridable so the startup assertion can be driven directly. */
  networkId?: string;
} = {}) {
  const book = new Book();
  const sources = options.offers ?? [offer(H1, N1, 10n, 20n)];
  for (const source of sources) book.upsert(source);
  let current = options.current ?? true;
  let now = Date.now();
  let backendStatus = options.status ?? "live";
  const stock = new Stock();
  stock.setBalances(options.balances ?? { [B]: 1_000n });
  const calls: string[] = [];
  const exactRequests: string[][] = [];
  const reverts: unknown[] = [];
  /** Every `initSwap` call, so a test can assert the exact leg the solver built. */
  const legs: Array<{ label: string; inputs: Record<string, bigint>; outputs: Imbalance[] }> = [];
  /** Every imbalance read, so a test can assert the relay half is the inverse job. */
  const imbalanceReads: Array<{ label: string; rows: Imbalance[] }> = [];
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
  let unprovenRevertFailures = options.unprovenRevertFailures ?? 0;
  let revertFailures = options.revertFailures ?? 0;
  let dustWindowBlocks = 0;
  const refuseTokenInSelection = options.refuseTokenInSelection ?? true;
  /** Every spec the executor asked the fee-sizing stand-in builder for, and the
   *  transactions the DUST balancer was handed alongside the merged base. */
  const standInSpecs: FeeSizingStandInSpec[] = [];
  const dustBalanceInputs: string[][] = [];

  const wallet: SwapJobWallet = {
    shielded: {
      // `blockWallet` stalls the FIRST wallet call `buildHalf` makes, which is
      // what the wallet-timeout tests need. Before 00006 that was the fee-sizing
      // mirror's `initSwap`; FR-001 removed it, and the first wallet call is now
      // the address read — still before any wallet mutation or journal artifact
      // row exists, which is the condition those tests were written against.
      getAddress: async () => {
        if (walletBarrier) await walletBarrier;
        return "solver-address";
      },
    },
    dust: {
      balanceTransactions: async (_dustSecretKey, transactions) => {
        calls.push("dust-balance");
        dustBalanceInputs.push((transactions as FakeTx[]).map((entry) => entry.label));
        if (options.expireDuring === "dust-balance") now += 4_000_000;
        return fakeTx("dust-unproven", options.dustAmount === null ? [] : [
          { seg: 0, tag: "dust", raw: "dust", amount: options.dustAmount ?? 1n },
        ]);
      },
    },
    // Faithful on the one property the settlement half is verified against:
    // a zswap half's imbalance is (value spent as inputs) − (value created as
    // outputs), so what the solver KEEPS shows up negative. Derived from the
    // call arguments rather than hardcoded, so the surplus legs FR-001 adds
    // (zero inputs, one or two outputs) are modelled instead of assumed.
    initSwap: async (inputs, outputs) => {
      const shielded = ((inputs as any).shielded ?? {}) as Record<string, bigint>;
      // Refuse any swap-token input; every new-job wallet leg must be receive-only.
      if (refuseTokenInSelection && Object.keys(shielded).length > 0) {
        calls.push("REFUSED-tokenIn-selection");
        throw new Error("wallet holds no swap tokens: coin selection refused");
      }
      const rows: Imbalance[] = [
        ...Object.entries(shielded).map(([token, amount]) => ({
          seg: 0, tag: "shielded" as const, raw: token, amount,
        })),
        ...(outputs as Array<{ outputs: Array<{ type: string; amount: bigint }> }>)
          .flatMap((group) => group.outputs.map((output, index) => ({
            seg: 0, tag: "shielded" as const, raw: output.type, amount: -output.amount,
            ...(options.invalidResidualDelta && index === 0
              ? { amount: -(output.amount + 1n) }
              : {}),
          }))),
      ];
      // `initSwap` now has exactly one caller: the solver's own balancing leg.
      const label = "residual";
      legs.push({ label, inputs: { ...shielded }, outputs: rows.filter((row) => row.amount < 0n) });
      calls.push(label);
      if (options.expireDuring === "init-swap") now += 4_000_000;
      return { transaction: fakeTx(label, rows) };
    },
    finalizeTransaction: async (transaction: any) => {
      calls.push(`finalize:${transaction.label}`);
      if (options.expireDuring === "finalize-residual" && transaction.label === "residual") {
        now += 4_000_000;
      }
      if (options.expireDuring === "finalize-dust" && transaction.label === "dust-unproven") {
        now += 4_000_000;
      }
      return transaction.label === "residual"
        ? fakeTx("residual-final", options.invalidFinalizedResidualDelta
          ? transaction.rows.map((row: Imbalance, index: number) => index === 0
            ? { ...row, amount: row.amount - 1n }
            : row)
          : transaction.rows) as any
        : fakeTx("dust-final", [{ seg: 0, tag: "dust", raw: "dust", amount: 1n }]) as any;
    },
    revertTransaction: async (transaction: any) => {
      calls.push(`revert-unproven:${transaction?.label ?? "unknown"}`);
      // FR-001: the stand-in is fabricated, so it must never be offered to the
      // wallet for reverting. Fail loudly if it ever is.
      if (transaction?.label === "fee-standin") {
        throw new Error("the fee-sizing stand-in must never be reverted");
      }
      if (unprovenRevertFailures > 0) {
        unprovenRevertFailures -= 1;
        throw new Error("unproven revert failed");
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
    networkId: "networkId" in options ? (options.networkId as string) : "undeployed",
    ...(options.modelledTakerInputs === undefined
      ? {}
      : { modelledTakerInputs: options.modelledTakerInputs }),
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
      // FR-001. The real builder is a pure ledger call (covered directly in
      // `packages/solver-core/fee-sizing.test.ts`); here it is a spy, so every
      // test in this file also asserts that fee sizing goes through it and never
      // through the wallet.
      buildFeeSizingStandIn: ((spec: FeeSizingStandInSpec) => {
        standInSpecs.push(spec);
        calls.push("fee-standin");
        if (options.standInFailure !== undefined) throw new Error(options.standInFailure);
        return fakeTx("fee-standin") as any;
      }) as any,
      readExactOfferFiles: async (offerIds) => {
        calls.push("exact-files");
        exactRequests.push([...offerIds]);
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
        return fakeTx(`maker:${hash}`, [
          { seg: 0, tag: "shielded", raw: source.gives[0]!.token, amount: source.gives[0]!.amount },
          { seg: 0, tag: "shielded", raw: source.wants[0]!.token, amount: -source.wants[0]!.amount },
        ]) as any;
      },
      deriveOfferSemantics: (transaction: any) => {
        const hash = transaction.label.slice("maker:".length);
        const derived = semantics(sources.find((source) => source.offerHash === hash)!);
        if (options.semanticMismatch) derived.gives[0]!.amount = "999";
        return derived;
      },
      mergeFinalized: merge as any,
      tokenImbalances: ((transaction: FakeTx) => {
        // Exact maker inspection is now an admission boundary of its own. The
        // legacy failure fixtures target the later wallet/merged-half check,
        // after a mutation exists and rollback/quarantine behavior matters.
        if (options.failImbalance && !/^maker:[^+]+$/.test(transaction.label)) {
          throw new Error("imbalance inspection failed");
        }
        imbalanceReads.push({ label: transaction.label, rows: transaction.rows });
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
    wallet,
    calls,
    exactRequests,
    reverts,
    legs,
    imbalanceReads,
    standInSpecs,
    dustBalanceInputs,
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
    // 00006 FR-001: where "mirror" + "mirror-revert" used to be. One pure
    // ledger call, no wallet mutation, nothing to revert.
    "fee-standin",
    "dust-balance",
    "finalize:dust-unproven",
  ]);
  expect(h.executor.stats()).toMatchObject({ building: 0, awaitingRelay: 1, refused: 0 });
  // FR-004: the two MIRROR_* rows are GONE from new jobs. The kinds remain
  // readable for journals written before the upgrade — pinned separately by
  // "FR-004 a legacy MIRROR_* journal still recovers…" below.
  expect(h.journal.list().map((row) => [row.operationKind, row.lifecycleState])).toEqual([
    ["JOB_SETTLEMENT", "AWAITING_RELAY"],
    ["DUST_BALANCE", "AWAITING_RELAY"],
    ["FINALIZED_CONTRIBUTION", "AWAITING_RELAY"],
  ]);
  // The stand-in is what the DUST balancer prices alongside the merged base,
  // and it has the taker half's shape: n tokenIn inputs, one tokenIn change
  // output, one tokenOut receive output, all at the fixed placeholder value.
  expect(h.dustBalanceInputs).toEqual([[`maker:${H1}`, "fee-standin"]]);
  expect(h.standInSpecs).toEqual([{
    networkId: "undeployed",
    inputs: [{ token: A, amount: FEE_SIZING_PLACEHOLDER_AMOUNT }],
    outputs: [
      { token: A, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
      { token: B, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
    ],
  }]);
  expect(DEFAULT_MODELLED_TAKER_INPUTS).toBe(1);
  await h.executor.stop();
});

test("between-threshold job keeps input surplus and never spends swap tokens", async () => {
  const h = harness({ offers: [offer(H1, N1, 10n, 20n), offer(H2, N2, 10n, 10n)], balances: {} });
  expect((await h.executor.onSwap(job("plateau", "15", "20"))).type).toBe("swap-tx");
  expect(h.legs[0]!.inputs).toEqual({});
  expect(h.stock.reserved(B)).toBe(0n);
  expect(h.journal.list().every((row) => Object.keys(row.claim.payouts).length === 0)).toBe(true);
  await h.executor.stop();
});


test("cache staleness and above-advertised demand fail before exact-file or wallet work", async () => {
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

/** Three makers with equal cost and different outputs. */
const LADDER = (): BookOffer[] => [
  offer(H1, N1, 10n, 30n),
  offer(H2, N2, 10n, 20n),
  offer(H3, N3, 10n, 10n),
];

const routeFor = (
  amountIn: string,
  amountOut: string,
  options: {
    offers?: BookOffer[];
    balances?: Record<string, bigint>;
    minJobOutput?: ReadonlyMap<string, bigint>;
  } = {},
) => {
  const book = new Book();
  for (const source of options.offers ?? LADDER()) book.upsert(source);
  const stock = new Stock();
  // No tokenIn by default (00006-R2 / SC-002): nothing in a route decision reads
  // it any more, so every matrix in this file is a zero-tokenIn control.
  stock.setBalances(options.balances ?? { [B]: 1_000n });
  const route = resolveSwapJobRoute(
    job("route", amountIn, amountOut),
    { book, isCurrent: () => true },
    stock,
    {
      nowMs: Date.now(),
      expiryMarginSeconds: 120,
      unavailableOfferHashes: [],
      ...(options.minJobOutput === undefined ? {} : { minJobOutput: options.minJobOutput }),
    },
  );
  return { route, stock };
};

const refusalReason = (body: () => unknown): string => {
  try {
    body();
  } catch (error) {
    return (error as { reason?: string }).reason ?? `not-a-refusal: ${String(error)}`;
  }
  return "no-refusal";
};

const receiptAmount = (
  route: ReturnType<typeof resolveSwapJobRoute>,
  token: string,
): bigint => route.receipts.find((receipt) => receipt.token === token)?.amount ?? 0n;

test("each admitted demand selects the maximum affordable witness and exact surpluses", () => {
  const matrix: Array<[string, string, string[], bigint, bigint]> = [
    ["15", "30", [H1], 5n, 0n], ["15", "25", [H1], 5n, 5n],
    ["15", "1", [H1], 5n, 29n], ["20", "50", [H1, H2], 0n, 0n],
    ["20", "45", [H1, H2], 0n, 5n], ["30", "59", [H1, H2, H3], 0n, 1n],
    ["10", "1", [H1], 0n, 29n], ["30", "1", [H1, H2, H3], 0n, 59n],
    ["300", "60", [H1, H2, H3], 270n, 0n],
  ];
  for (const [amountIn, amountOut, hashes, surplusIn, surplusOut] of matrix) {
    const { route, stock } = routeFor(amountIn, amountOut);
    expect(route.offers.map((source) => source.offerHash)).toEqual(hashes);
    expect(receiptAmount(route, A)).toBe(surplusIn);
    expect(receiptAmount(route, B)).toBe(surplusOut);
    expect(route.offers.reduce((sum, source) => sum + source.wants[0]!.amount, 0n) + surplusIn).toBe(BigInt(amountIn));
    expect(route.offers.reduce((sum, source) => sum + source.gives[0]!.amount, 0n) - surplusOut).toBe(BigInt(amountOut));
    expect([...route.claim.payouts]).toEqual([]);
    expect(stock.reserved(A)).toBe(0n);
    expect(stock.reserved(B)).toBe(0n);
    for (const unselected of LADDER().filter((source) => !hashes.includes(source.offerHash))) {
      expect(stock.isOfferClaimed(unselected)).toBe(false);
    }
  }
});


test("FR-001 above-advertised, out-of-ladder, and non-positive demands stay refused", () => {
  // Above the advertised curve — the negative control, at an interior size and
  // at every rung.
  expect(refusalReason(() => routeFor("15", "41"))).toBe(JOB_ROUTE_NOT_CURRENT);
  expect(refusalReason(() => routeFor("10", "31"))).toBe(JOB_ROUTE_NOT_CURRENT);
  expect(refusalReason(() => routeFor("20", "51"))).toBe(JOB_ROUTE_NOT_CURRENT);
  expect(refusalReason(() => routeFor("30", "61"))).toBe(JOB_ROUTE_NOT_CURRENT);
  // Outside the ladder in either direction stays a refusal, lowered demand or
  // not: the relay would not have quoted these sizes.
  expect(refusalReason(() => routeFor("5", "1"))).toBe(JOB_ROUTE_NOT_CURRENT);
  expect(refusalReason(() => routeFor("301", "1"))).toBe(JOB_ROUTE_NOT_CURRENT);
  // `0 <` half of the admission rule.
  expect(refusalReason(() => routeFor("15", "0"))).toBe(JOB_ROUTE_NOT_CURRENT);
  // FR-010: a LOWER demand is exactly what the configured minimum exists to
  // bound, so admission policy still applies to the newly accepted shapes.
  const minimum = new Map([[B, 30n]]);
  expect(refusalReason(() => routeFor("15", "25", { minJobOutput: minimum }))).toBe(JOB_MIN_OUTPUT);
  expect(receiptAmount(routeFor("15", "30", { minJobOutput: minimum }).route, B)).toBe(0n);
});

// R2/FR-004 amendment REVERTED at 00006-R2. 00005-R2 had to weaken this test to
// `{A: 1_000n, B: 0n}`, because the tokenIn depth bound refused a zero-A solver
// for a reason that had nothing to do with surplus. With that bound gone the
// original, stronger form is restored: an EMPTY wallet — zero of both tokens —
// serves every at/below-prefix demand, which is exactly what 00006 is for.
test("one-unit maker shortfall refuses both funded and empty wallets", () => {
  for (const balances of [{}, { [A]: 1_000n, [B]: 1_000n }]) {
    expect(refusalReason(() => routeFor("15", "31", { balances }))).toBe(JOB_ROUTE_NOT_CURRENT);
    const { route } = routeFor("15", "25", { balances });
    expect(receiptAmount(route, A)).toBe(5n);
    expect(receiptAmount(route, B)).toBe(5n);
    expect([...route.claim.payouts]).toEqual([]);
  }
});

const netImbalance = (rows: Imbalance[]): Array<[string, bigint]> => {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (row.tag !== "shielded") continue;
    totals.set(row.raw, (totals.get(row.raw) ?? 0n) + row.amount);
  }
  return [...totals].filter(([, amount]) => amount !== 0n).sort();
};


test("FR-001 a lowered demand settles end to end with the surplus retained by the solver", async () => {
  // Case 2 — interior, below the prefix payout: zero-input leg that keeps both
  // the surplus tokenOut and the overpaid tokenIn.
  const h = harness({ offers: LADDER(), status: "consumed" });
  const result = await h.executor.onSwap(job("surplus-interior", "15", "25"));
  expect(result.type).toBe("swap-tx");
  expect(h.calls).toEqual([
    "exact-files", "fee-standin", "residual", "finalize:residual",
    "dust-balance", "finalize:dust-unproven",
  ]);
  // The solver's own leg: spends nothing, keeps 5 A (overpaid input) + 5 B. It
  // is now the ONLY `initSwap` the job makes (FR-001).
  expect(h.legs.map((leg) => leg.label)).toEqual(["residual"]);
  expect(h.legs[0]).toEqual({
    label: "residual",
    inputs: {},
    outputs: [
      { seg: 0, tag: "shielded", raw: A, amount: -5n },
      { seg: 0, tag: "shielded", raw: B, amount: -5n },
    ],
  });
  // The relay half is still exactly the inverse job — the taker is paid the 25
  // it demanded, not the 30 the winning makers pays — and it contains only the
  // selected maker file.
  const relay = h.imbalanceReads.at(-1)!;
  expect(relay.label).toBe(`maker:${H1}+residual-final+dust-final`);
  expect(netImbalance(relay.rows)).toEqual([[A, -15n], [B, 25n]]);
  // Nothing is reserved: the surplus path pays nothing out.
  expect(h.stock.reserved(B)).toBe(0n);

  await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "surplus-interior", txId: RELAY_TX });
  expect(h.executor.stats()).toMatchObject({ completed: 1, quarantined: 0, reverted: 0 });
  expect(h.journal.list().map((row) => [row.operationKind, row.lifecycleState])).toEqual([
    ["JOB_SETTLEMENT", "SETTLED"],
    ["RESIDUAL_BUILD", "SETTLED"],
    ["FINALIZED_CONTRIBUTION", "SETTLED"],
    ["DUST_BALANCE", "SETTLED"],
    ["FINALIZED_CONTRIBUTION", "SETTLED"],
  ]);
  // Only the selected maker offer is consumed.
  expect(h.book.get(H1)).toBeUndefined();
  expect(h.book.get(H2)).toBeDefined();
  expect(h.book.get(H3)).toBeDefined();
  expect(h.stock.isOfferClaimed(offer(H1, N1, 10n, 30n))).toBe(false);
  await h.executor.stop();
});

test("FR-001 a lowered exact rung and the minimum positive demand both settle", async () => {
  // Case 3 — no residual input at all: the leg's only output is the surplus.
  const rung = harness({ offers: LADDER(), status: "consumed" });
  expect((await rung.executor.onSwap(job("surplus-rung", "20", "45"))).type).toBe("swap-tx");
  expect(rung.legs[0]).toEqual({
    label: "residual",
    inputs: {},
    outputs: [{ seg: 0, tag: "shielded", raw: B, amount: -5n }],
  });
  const rungRelay = rung.imbalanceReads.at(-1)!;
  expect(rungRelay.label).toBe(`maker:${H1}+maker:${H2}+residual-final+dust-final`);
  expect(netImbalance(rungRelay.rows)).toEqual([[A, -20n], [B, 45n]]);
  expect(rung.stock.reserved(B)).toBe(0n);
  await rung.executor.onTxSubmitted({ type: "tx-submitted", jobId: "surplus-rung", txId: RELAY_TX });
  expect(rung.executor.stats()).toMatchObject({ completed: 1, quarantined: 0 });
  expect(rung.book.get(H3)).toBeDefined();
  await rung.executor.stop();

  // Case 4 — one unit of output against the first rung.
  const minimum = harness({ offers: LADDER(), status: "consumed" });
  expect((await minimum.executor.onSwap(job("surplus-minimum", "10", "1"))).type).toBe("swap-tx");
  expect(minimum.legs[0]).toEqual({
    label: "residual",
    inputs: {},
    outputs: [{ seg: 0, tag: "shielded", raw: B, amount: -29n }],
  });
  expect(netImbalance(minimum.imbalanceReads.at(-1)!.rows)).toEqual([[A, -10n], [B, 1n]]);
  await minimum.executor.onTxSubmitted({
    type: "tx-submitted", jobId: "surplus-minimum", txId: RELAY_TX,
  });
  expect(minimum.executor.stats()).toMatchObject({ completed: 1, quarantined: 0 });
  await minimum.executor.stop();
});

const composedOffers = (): BookOffer[] => [
  makerOffer(H1, N1, A, 10n, B, 3n),
  makerOffer(H2, N2, B, 6n, D, 5n),
];

test("composed witness settles an intermediate-only receipt from an empty swap wallet", async () => {
  const h = harness({ offers: composedOffers(), balances: {}, status: "consumed" });
  try {
    const result = await h.executor.onSwap(swapJob("composed-exact", D, A, "5", "10"));
    expect(result.type).toBe("swap-tx");
    expect(h.exactRequests).toEqual([[H1, H2]]);
    expect(h.legs).toEqual([{
      label: "residual",
      inputs: {},
      outputs: [{ seg: 0, tag: "shielded", raw: B, amount: -3n }],
    }]);
    expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, 10n], [D, -5n]]);
    expect(h.journal.list().every((row) => Object.keys(row.claim.payouts).length === 0)).toBe(true);
    await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "composed-exact", txId: RELAY_TX });
    expect(h.executor.stats()).toMatchObject({ completed: 1, quarantined: 0 });
  } finally {
    await h.executor.stop();
  }
});

test("invalid residual delta is durably captured and raw-reverted before refusal", async () => {
  const h = harness({ offers: composedOffers(), balances: {}, invalidResidualDelta: true });
  try {
    expect(await h.executor.onSwap(swapJob("bad-residual", D, A, "5", "10"))).toEqual({
      type: "job-error",
      jobId: "bad-residual",
      reason: JOB_WALLET_FAILED,
    });
    expect(h.calls).toContain("revert-unproven:residual");
    expect(h.journal.list().find((row) => row.operationKind === "RESIDUAL_BUILD"))
      .toMatchObject({ lifecycleState: "REVERTED", walletArtifactKind: "UNPROVEN_TRANSACTION" });
    expect(h.journal.list().some((row) => row.lifecycleState === "QUARANTINED")).toBe(false);
    expect(h.stock.isClaimed({ offerHashes: [H1, H2], nullifiers: [N1, N2] })).toBe(false);
  } finally {
    await h.executor.stop();
  }
});

test("expiry during residual init captures and raw-reverts the returned artifact", async () => {
  const h = harness({ offers: composedOffers(), balances: {}, expireDuring: "init-swap" });
  try {
    expect(await h.executor.onSwap(swapJob("expire-init", D, A, "5", "10"))).toEqual({
      type: "job-error",
      jobId: "expire-init",
      reason: JOB_ROUTE_NOT_CURRENT,
    });
    expect(h.calls).toContain("revert-unproven:residual");
    expect(h.journal.list().find((row) => row.operationKind === "RESIDUAL_BUILD"))
      .toMatchObject({ lifecycleState: "REVERTED", walletArtifactKind: "UNPROVEN_TRANSACTION" });
    expect(h.reverts).toEqual([]);
  } finally {
    await h.executor.stop();
  }
});

test("expiry during residual finalize transfers cleanup to the durable finalized artifact", async () => {
  const h = harness({ offers: composedOffers(), balances: {}, expireDuring: "finalize-residual" });
  try {
    expect(await h.executor.onSwap(swapJob("expire-finalize", D, A, "5", "10"))).toEqual({
      type: "job-error",
      jobId: "expire-finalize",
      reason: JOB_ROUTE_NOT_CURRENT,
    });
    expect(h.calls).not.toContain("revert-unproven:residual");
    expect(h.reverts.map((transaction: any) => transaction.label)).toEqual(["residual-final"]);
    expect(h.journal.list().filter((row) =>
      row.operationKind === "RESIDUAL_BUILD" ||
      (row.operationKind === "FINALIZED_CONTRIBUTION" && row.operationKey.endsWith(":residual"))
    ).map((row) => [row.operationKind, row.lifecycleState])).toEqual([
      ["RESIDUAL_BUILD", "REVERTED"],
      ["FINALIZED_CONTRIBUTION", "REVERTED"],
    ]);
  } finally {
    await h.executor.stop();
  }
});

test("invalid finalized residual delta rolls back only the durably tracked finalized artifact", async () => {
  const h = harness({
    offers: composedOffers(),
    balances: {},
    invalidFinalizedResidualDelta: true,
  });
  try {
    expect(await h.executor.onSwap(swapJob("bad-finalized-residual", D, A, "5", "10"))).toEqual({
      type: "job-error",
      jobId: "bad-finalized-residual",
      reason: JOB_WALLET_FAILED,
    });
    expect(h.calls).not.toContain("revert-unproven:residual");
    expect(h.reverts.map((transaction: any) => transaction.label)).toEqual(["residual-final"]);
    expect(h.journal.list().filter((row) =>
      row.operationKind === "RESIDUAL_BUILD" ||
      (row.operationKind === "FINALIZED_CONTRIBUTION" && row.operationKey.endsWith(":residual"))
    ).map((row) => [row.operationKind, row.lifecycleState])).toEqual([
      ["RESIDUAL_BUILD", "REVERTED"],
      ["FINALIZED_CONTRIBUTION", "REVERTED"],
    ]);
    expect(h.journal.list().some((row) => row.lifecycleState === "QUARANTINED")).toBe(false);
  } finally {
    await h.executor.stop();
  }
});

test("expiry during DUST init/finalize always reverts the captured artifact form", async () => {
  for (const expireDuring of ["dust-balance", "finalize-dust"] as const) {
    const h = harness({ expireDuring });
    try {
      expect(await h.executor.onSwap(job(`expire-${expireDuring}`))).toEqual({
        type: "job-error",
        jobId: `expire-${expireDuring}`,
        reason: JOB_ROUTE_NOT_CURRENT,
      });
      if (expireDuring === "dust-balance") {
        expect(h.calls).toContain("revert-unproven:dust-unproven");
        expect(h.reverts).toEqual([]);
      } else {
        expect(h.calls).not.toContain("revert-unproven:dust-unproven");
        expect(h.reverts.map((transaction: any) => transaction.label)).toEqual(["dust-final"]);
      }
      expect(h.journal.list().some((row) => row.lifecycleState === "QUARANTINED")).toBe(false);
    } finally {
      await h.executor.stop();
    }
  }
});

test("composed lowered demand aggregates sorted endpoint and intermediate receipts", async () => {
  const h = harness({ offers: composedOffers(), balances: {}, status: "consumed" });
  try {
    const result = await h.executor.onSwap(swapJob("composed-surplus", D, A, "16", "9"));
    expect(result.type).toBe("swap-tx");
    expect(h.legs[0]).toEqual({
      label: "residual",
      inputs: {},
      outputs: [
        { seg: 0, tag: "shielded", raw: A, amount: -1n },
        { seg: 0, tag: "shielded", raw: B, amount: -3n },
        { seg: 0, tag: "shielded", raw: D, amount: -11n },
      ],
    });
    expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, 9n], [D, -16n]]);
  } finally {
    await h.executor.stop();
  }
});

test("three makers retain four positive token receipts through one residual artifact", async () => {
  const sources = [
    ...composedOffers(),
    makerOffer(H3, N3, D, 6n, E, 7n),
  ];
  const h = harness({ offers: sources, balances: {}, status: "consumed" });
  try {
    const result = await h.executor.onSwap(swapJob("four-receipts", E, A, "8", "9"));
    expect(result.type).toBe("swap-tx");
    expect(h.exactRequests).toEqual([[H1, H2, H3]]);
    expect(h.legs[0]).toEqual({
      label: "residual",
      inputs: {},
      outputs: [
        { seg: 0, tag: "shielded", raw: A, amount: -1n },
        { seg: 0, tag: "shielded", raw: B, amount: -3n },
        { seg: 0, tag: "shielded", raw: D, amount: -1n },
        { seg: 0, tag: "shielded", raw: E, amount: -1n },
      ],
    });
    expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, 9n], [E, -8n]]);
    expect(h.journal.list().filter((row) => row.operationKind === "RESIDUAL_BUILD")).toHaveLength(1);
  } finally {
    await h.executor.stop();
  }
});

test("balanced intermediate creates no zero receipt output", async () => {
  const sources = [
    makerOffer(H1, N1, A, 10n, B, 6n),
    makerOffer(H2, N2, B, 6n, D, 5n),
  ];
  const h = harness({ offers: sources, balances: {}, status: "consumed" });
  try {
    expect((await h.executor.onSwap(swapJob("balanced-intermediate", D, A, "5", "10"))).type)
      .toBe("swap-tx");
    expect(h.legs).toEqual([]);
    expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, 10n], [D, -5n]]);
  } finally {
    await h.executor.stop();
  }
});

test("16 B to 40 A retains 6 B and leaves the next whole maker untouched", async () => {
  const sources = [
    makerOffer(H1, N1, A, 40n, B, 10n),
    makerOffer(H2, N2, A, 100n, B, 20n),
  ];
  const h = harness({ offers: sources, balances: {}, status: "consumed" });
  try {
    expect((await h.executor.onSwap(swapJob("sixteen-b", B, A, "16", "40"))).type)
      .toBe("swap-tx");
    expect(h.exactRequests).toEqual([[H1]]);
    expect(h.legs[0]!.outputs).toEqual([
      { seg: 0, tag: "shielded", raw: B, amount: -6n },
    ]);
    await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "sixteen-b", txId: RELAY_TX });
    expect(h.book.get(H1)).toBeUndefined();
    expect(h.book.get(H2)).toBeDefined();
  } finally {
    await h.executor.stop();
  }
});

test("one-base-unit intermediate deficit refuses with empty or funded solver inventory", () => {
  const sources = [
    makerOffer(H1, N1, A, 10n, B, 6n),
    makerOffer(H2, N2, B, 5n, D, 5n),
  ];
  for (const balances of [{}, { [B]: 1_000n }]) {
    const book = new Book();
    sources.forEach((source) => book.upsert(source));
    const stock = new Stock();
    stock.setBalances(balances);
    expect(refusalReason(() => resolveSwapJobRoute(
      swapJob("deficit", D, A, "5", "10"),
      { book, isCurrent: () => true },
      stock,
      { nowMs: Date.now(), expiryMarginSeconds: 120, unavailableOfferHashes: [] },
    ))).toBe(JOB_ROUTE_NOT_CURRENT);
    expect(stock.reserved(B)).toBe(0n);
  }
});

test("direct and composed admissions sharing a physical maker cannot both reserve it", () => {
  const sources = composedOffers();
  const book = new Book();
  sources.forEach((source) => book.upsert(source));
  const stock = new Stock();
  stock.setBalances({});
  const composed = resolveSwapJobRoute(
    swapJob("composed-race", D, A, "5", "10"),
    { book, isCurrent: () => true },
    stock,
    { nowMs: Date.now(), expiryMarginSeconds: 120, unavailableOfferHashes: [] },
  );
  expect(composed.claim.offerHashes).toEqual([H1, H2]);
  expect(refusalReason(() => resolveSwapJobRoute(
    swapJob("direct-race", D, B, "5", "6"),
    { book, isCurrent: () => true },
    stock,
    { nowMs: Date.now(), expiryMarginSeconds: 120, unavailableOfferHashes: [] },
  ))).toBe(JOB_ROUTE_UNAVAILABLE);
  stock.release(composed.claim);
  expect(resolveSwapJobRoute(
    swapJob("direct-after-release", D, B, "5", "6"),
    { book, isCurrent: () => true },
    stock,
    { nowMs: Date.now(), expiryMarginSeconds: 120, unavailableOfferHashes: [] },
  ).offers.map((source) => source.offerHash)).toEqual([H2]);
});

test("sorted physical identity uses the helper's distinct safe order for actual maker merges", async () => {
  const sources = [
    makerOffer(H1, N1, A, MAX_SETTLEMENT_AMOUNT, B, MAX_SETTLEMENT_AMOUNT),
    makerOffer(H2, N2, A, 1n, D, 1n),
    makerOffer(H3, N3, B, MAX_SETTLEMENT_AMOUNT, A, MAX_SETTLEMENT_AMOUNT - 1n),
  ];
  const h = harness({ offers: sources, balances: {}, status: "consumed" });
  try {
    const result = await h.executor.onSwap(swapJob("safe-order", D, A, "1", "2"));
    expect(result.type).toBe("swap-tx");
    // Exact-file identity stays sorted, while H3 cancels H1 before H2 adds the
    // final A unit. H1+H2 would overflow ledger-v9's signed A delta.
    expect(h.exactRequests).toEqual([[H1, H2, H3]]);
    expect(h.dustBalanceInputs[0]![0]).toBe(`maker:${H1}+maker:${H3}+maker:${H2}`);
    expect(h.imbalanceReads.some((read) =>
      read.label === `maker:${H1}+maker:${H3}` &&
      JSON.stringify(netImbalance(read.rows), (_, value) =>
        typeof value === "bigint" ? value.toString() : value) === JSON.stringify([[A, "1"]])
    )).toBe(true);
  } finally {
    await h.executor.stop();
  }
});

test("lowered demand above the maker maximum refuses before wallet mutation", async () => {
  for (const balances of [{}, { [B]: 1_000n }]) {
    const h = harness({ offers: LADDER(), balances });
    expect(await h.executor.onSwap(job("shortfall", "15", "35"))).toEqual({
      type: "job-error", jobId: "shortfall", reason: JOB_ROUTE_NOT_CURRENT,
    });
    expect(h.calls).toEqual([]);
    expect(h.journal.list()).toEqual([]);
    await h.executor.stop();
  }
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

// 00006 FR-001 BEHAVIOUR CHANGE, recorded here rather than deleted.
//
// Before this test ended with the generation durably TERMINAL and `quarantined:
// 0`, and it got there for a reason that no longer exists: the blocked call was
// the fee-sizing mirror's `initSwap`, so after release the late work failed on
// its own quarantined `MIRROR_RESERVATION` row, reverted the mirror it was
// holding, left nothing non-terminal behind, and the claim could be released.
//
// With the mirror gone the late work RUNS TO COMPLETION (it has no fee-sizing
// mutation left to trip over), so what is exercised now is the harder case: a
// late build that produced a real finalized contribution whose rollback then
// FAILS. The invariant this test exists for is unchanged and still asserted —
// the late completion cannot advance beyond its quarantined generation: exactly
// one generation ever exists, no relay half is ever handed out, and the outcome
// is fail-closed (claim and offer retained) rather than silently released.
test("a timed-out wallet call cannot advance beyond its quarantined generation", async () => {
  const h = harness({
    blockWallet: true,
    walletOperationTimeoutMs: 5,
    failImbalance: true,
    revertFailures: 1,
  });
  expect(await h.executor.onSwap(job("late-cleanup"))).toEqual({
    type: "job-error", jobId: "late-cleanup", reason: JOB_WALLET_TIMEOUT,
  });
  h.releaseWallet();
  await h.executor.idle();
  // One generation, never a second: the late work stayed inside generation 1.
  expect([...new Set(h.journal.list().map((row) => row.generation))]).toEqual([1]);
  expect(h.executor.stats()).toMatchObject({
    building: 0, awaitingRelay: 0, completed: 0, quarantined: 1, timedOutBuilds: 1,
  });
  // Fail-closed: the uncertain finalized contribution keeps the claim and the
  // offer, and no sweep retries the wallet call.
  expect(h.stock.isClaimed({ offerHashes: [H1], nullifiers: [N1] })).toBe(true);
  expect(h.executor.unavailableOfferHashes()).toEqual([H1]);
  h.advance(60_001);
  await h.executor.sweep();
  expect(h.executor.stats()).toMatchObject({ quarantined: 1, completed: 0 });
  expect([...new Set(h.journal.list().map((row) => row.generation))]).toEqual([1]);
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

// 00006 FR-001 RE-ENCODED, not deleted.
//
// This test used to drive the fee-sizing MIRROR's revert (`mirrorRevertFailures`)
// because that mirror was the first unproven wallet artifact on every job's
// mandatory path. The mirror is gone, but the property it pinned is about the
// UNPROVEN-artifact class, not about fee sizing: when the wallet cannot
// acknowledge release of an unproven mutation it already applied, the job stays
// quarantined, the claim and the slot stay held, and no sweep ever retries the
// wallet call. The DUST balancing transaction is now the artifact in that class
// (it is applied, then rolled back if admission refuses the estimate), so the
// same property is pinned through it.
test("unfinalized unproven revert ambiguity remains fail-closed across sweeps", async () => {
  const h = harness({
    // A DUST estimate above the per-job limit refuses AFTER the balancer's
    // unproven transaction has been applied and journalled — exactly the window
    // the mirror used to occupy.
    dustAmount: 3n,
    dustAdmission: { maxPerJob: 2n, maxPerWindow: 10n, windowMs: 60_000 },
    unprovenRevertFailures: 2,
    maxParallelSwaps: 1,
  });
  expect(await h.executor.onSwap(job("unproven-uncertain"))).toEqual({
    type: "job-error",
    jobId: "unproven-uncertain",
    reason: JOB_WALLET_FAILED,
  });
  expect(h.calls).toContain("revert-unproven:dust-unproven");
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

// 00006 FR-001. The old mirror made fee sizing a WALLET MUTATION: an `initSwap`
// that had to be reverted, with its own journal rows and its own cleanup arm in
// `buildHalf`'s catch. A fabricated stand-in cannot fail that way, and this
// pins the difference: when the stand-in builder itself throws, the job is a
// clean refusal with zero wallet calls, zero journal rows and nothing
// quarantined.
test("FR-001 a failing fee-sizing stand-in refuses cleanly with no wallet mutation to undo", async () => {
  const h = harness({ standInFailure: "ledger refused the stand-in shape" });
  expect(await h.executor.onSwap(job("standin-broken"))).toEqual({
    type: "job-error",
    jobId: "standin-broken",
    reason: JOB_WALLET_FAILED,
  });
  expect(h.calls).toEqual(["exact-files", "fee-standin"]);
  expect(h.legs).toEqual([]);
  expect(h.reverts).toEqual([]);
  expect(h.executor.stats()).toMatchObject({
    quarantined: 0, revertFailures: 0, awaitingRelay: 0, refused: 1,
  });
  // Nothing durable survives: no wallet-artifact row at all, and the claim and
  // the offer are both released.
  expect(h.journal.list().filter((row) => row.operationKind !== "JOB_SETTLEMENT")).toEqual([]);
  expect(h.stock.isClaimed({ offerHashes: [H1], nullifiers: [N1] })).toBe(false);
  expect(h.executor.unavailableOfferHashes()).toEqual([]);
  await h.executor.stop();
});

// 00006 SC-001. The headline requirement, stated as one test: a wallet that
// cannot select tokenIn coins AT ALL still settles a whole job end to end.
// `refuseTokenInSelection` is on by default for every harness in this file, so
// this test's job is to make the claim explicit and to prove the refusal is
// real — the same wallet, asked to spend tokenIn, throws.
test("SC-001 a wallet that refuses all tokenIn coin selection still settles a whole job", async () => {
  const h = harness({ status: "consumed" });
  expect((await h.executor.onSwap(job("capital-free", "10", "20"))).type).toBe("swap-tx");
  // Fee sizing went through the pure ledger builder and never through the wallet.
  expect(h.standInSpecs).toHaveLength(1);
  expect(h.legs).toEqual([]);
  expect(h.calls).not.toContain("REFUSED-tokenIn-selection");
  expect(h.calls).toEqual([
    "exact-files", "fee-standin", "dust-balance", "finalize:dust-unproven",
  ]);
  // …and it settles: the relay half is the exact inverse job, the maker offer is
  // consumed, and no tokenIn was ever reserved.
  expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, -10n], [B, 20n]]);
  await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "capital-free", txId: RELAY_TX });
  expect(h.executor.stats()).toMatchObject({ completed: 1, quarantined: 0, reverted: 0 });
  expect(h.stock.reserved(A)).toBe(0n);
  await h.executor.stop();

  // The control: the refusal is not inert. No reachable job asks this wallet to
  // spend tokenIn any more, so the double is driven directly — if it silently
  // accepted a tokenIn spend, the assertion above would prove nothing.
  const control = harness();
  await expect(control.wallet.initSwap(
    { shielded: { [A]: 10n } },
    [{ type: "shielded", outputs: [] }],
    { dustSecretKey: "dust-key" },
    { ttl: new Date(Date.now() + 60_000), payFees: false },
  )).rejects.toThrow(/wallet holds no swap tokens/);
  await control.executor.stop();
});

// 00006 FR-004. New jobs no longer write `MIRROR_RESERVATION`/`MIRROR_REVERT`
// rows, but a journal written BEFORE this change can still hold non-terminal
// ones — and those rows describe REAL reserved coins, so recovery must still
// revert them. This drives startup reconciliation over a journal that only has
// a legacy mirror row, and asserts the wallet is asked to revert exactly it.
test("FR-004 a legacy MIRROR_* journal row still recovers after the mirror is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cow-00006-legacy-mirror-"));
  const path = join(directory, "operations.sqlite");
  try {
    // Write the legacy shape by hand: a settlement whose only wallet artifact is
    // an APPLIED MIRROR_RESERVATION, exactly as a pre-00006 crash between
    // `initSwap` and `revertTransaction` would have left it. The operation-key
    // grammar is the executor's own (`job:<id>:g<n>:<KIND>:<label>`).
    const seed = SolverOperationJournal.open({ path });
    const legacyRow = (kind: "JOB_SETTLEMENT" | "MIRROR_RESERVATION", label: string) => {
      const key = kind === "JOB_SETTLEMENT"
        ? "job:legacy-mirror:g1:settlement"
        : `job:legacy-mirror:g1:${kind}:${label}`;
      seed.createPrepared({
        operationKey: key,
        jobId: "legacy-mirror",
        generation: 1,
        offerHashes: [H1],
        claim: { inputs: [N1], payouts: {} },
        operationKind: kind,
        ttlExpiresAtMs: Date.now() + 3_600_000,
        deadlineAtMs: Date.now() + 1_800_000,
        ...(kind === "MIRROR_RESERVATION"
          ? {
            walletArtifactKind: "UNPROVEN_TRANSACTION" as const,
            walletArtifactBytes: new TextEncoder().encode("legacy-mirror-bytes"),
          }
          : {}),
      });
      seed.transition(key, "PREPARED", "APPLIED");
      return key;
    };
    legacyRow("JOB_SETTLEMENT", "settlement");
    const mirrorKey = legacyRow("MIRROR_RESERVATION", "fee-sizing");
    seed.close();

    const reopened = harness({ journalPath: path, relayStatus: "error", status: "live" });
    await reopened.executor.ready;
    // The legacy mirror bytes — and only those — were handed back to the wallet.
    expect(reopened.calls.filter((entry) => entry.startsWith("revert-unproven:")))
      .toEqual(["revert-unproven:legacy-mirror-bytes"]);
    expect(reopened.journal.require(mirrorKey).lifecycleState).toBe("REVERTED");
    expect(reopened.stock.isClaimed({ offerHashes: [H1], nullifiers: [N1] })).toBe(false);
    expect(reopened.executor.stats()).toMatchObject({ quarantined: 0, revertFailures: 0 });
    await reopened.executor.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 00006 FR-001 / Q-R0-1 (option A). The modelled taker-input count is the one
// genuinely unknowable number in the fee model, so it is an explicit, bounded,
// operator-visible parameter rather than a buried constant.
test("FR-001 modelledTakerInputs shapes the stand-in and is bounded at startup", async () => {
  const h = harness({ modelledTakerInputs: 3 });
  expect((await h.executor.onSwap(job("modelled-3"))).type).toBe("swap-tx");
  expect(h.standInSpecs[0]!.inputs).toEqual([
    { token: A, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
    { token: A, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
    { token: A, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
  ]);
  // The shape's outputs never scale with `n`: one change, one receive.
  expect(h.standInSpecs[0]!.outputs).toHaveLength(2);
  await h.executor.stop();

  for (const invalid of [0, -1, 1.5, Number.NaN, MAX_MODELLED_TAKER_INPUTS + 1]) {
    expect(() => harness({ modelledTakerInputs: invalid })).toThrow(/modelledTakerInputs/);
  }
});

// 00006 FR-001. The stand-in is a real ledger transaction and therefore carries
// a network id, which the ledger only validates when the DUST balancer merges it
// with the solver's own half. A mis-threaded id must be a boot error, not a
// per-job `wallet_build_failed`.
test("FR-001 a missing or malformed networkId is refused at startup", () => {
  for (const invalid of ["", " undeployed", "undeployed ", "under\0deployed", undefined]) {
    expect(() => harness({ networkId: invalid as any })).toThrow(/networkId/);
  }
  expect(() => harness({ networkId: "undeployed" }).executor.stop()).not.toThrow();
});

// ── 00006-R2 / FR-003 / SC-002: the tokenIn depth bound is GONE ─────────────
//
// P4-F04's ORIGINAL reason: `buildHalf` opened with a MANDATORY fee-sizing
// mirror that called `initSwap({shielded: {[tokenIn]: amountIn}}, …)`, selecting
// real coins for the taker's FULL input out of the solver's own wallet and
// reverting them immediately. Nothing at publication or admission proved the
// wallet could spend that much, so an unfundable job failed HALF-WAY THROUGH a
// wallet mutation, and an uncertain revert sent it to `WalletMutationUncertain`
// quarantine, stranding the claim and a capacity slot. 00005-R2 therefore
// refused such a job with `JOB_ROUTE_UNAVAILABLE` before any wallet call, and
// capped publication by the same number.
//
// 00006-R1 REMOVED THE MIRROR (FR-001): fee sizing spends no tokenIn at all.
// 00006-R2 removed the bound it protected, at both layers (FR-003). The three
// tests below are the 00005-R2 tests RE-ENCODED as the new behaviour's controls,
// one for one:
//
//   "an unfundable tokenIn bound is refused before any wallet call"
//     → "a job whose tokenIn the solver does not hold SETTLES"
//   "the tokenIn budget is AVAILABLE tokenIn, so another job's payout reduces it"
//     → "no reservation and no balance on the tokenIn side can refuse a job"
//   "publication withholds what it cannot execute, and admission refuses it again"
//     → the same two-layer statement, with only the tokenOut half left.

test("FR-003 a job whose tokenIn the solver does not hold SETTLES (SC-002)", async () => {
  // Route level first, on the exact balances that used to refuse: 14 of tokenIn
  // against an `amountIn` of 15. There is no tokenIn check left to fail.
  const zeroTokenIn = { [A]: 0n, [B]: 1_000n };
  for (const balances of [{ [A]: 14n, [B]: 1_000n }, zeroTokenIn]) {
    const resolved = routeFor("15", "25", { balances });
    expect(receiptAmount(resolved.route, B)).toBe(5n);
    expect([...resolved.route.claim.payouts]).toEqual([]);
    expect(resolved.stock.reserved(A)).toBe(0n);
  }
  // …and the resolved route is IDENTICAL to the one a fully funded wallet gets,
  // which is the "byte-for-byte" half of FR-003: nothing else moved.
  const funded = routeFor("15", "25", { balances: { [A]: 1_000n, [B]: 1_000n } });
  const unfunded = routeFor("15", "25", { balances: zeroTokenIn });
  expect(unfunded.route.receipts).toEqual(funded.route.receipts);
  expect(unfunded.route.offers.map((source) => source.offerHash))
    .toEqual(funded.route.offers.map((source) => source.offerHash));

  // End to end, where the old test asserted `job-error` + zero wallet calls:
  // the job now settles from a wallet with NO tokenIn, and the wallet double is
  // the standing SC-001 control that refuses every tokenIn coin selection.
  const h = harness({ offers: LADDER(), balances: zeroTokenIn });
  const settled = await h.executor.onSwap(job("no-tokenIn", "15", "25"));
  expect(settled.type).toBe("swap-tx");
  expect(h.calls).not.toContain("REFUSED-tokenIn-selection");
  // Exactly one `initSwap`, and it is the solver's own leg — never a tokenIn one.
  expect(h.legs.map((leg) => leg.label)).toEqual(["residual"]);
  expect(h.legs[0]!.inputs[A]).toBeUndefined();
  // Fee sizing happened, from a fabricated stand-in rather than a coin spend.
  expect(h.standInSpecs).toHaveLength(1);
  expect(h.stock.reserved(A)).toBe(0n);
  expect(h.stock.reserved(B)).toBe(0n);
  await h.executor.stop();
});

test("FR-003 no reservation or balance on the tokenIn side can refuse a job", () => {
  // Unrelated historical payout claims cannot change a new maker-backed route.
  const book = new Book();
  for (const source of LADDER()) book.upsert(source);
  const stock = new Stock();
  stock.setBalances({ [A]: 20n, [B]: 1_000n });
  // A live claim on an unrelated offer, paying out tokenA — exactly the state
  // that used to make `available(A)` 14 and refuse the size-15 job.
  expect(stock.reserve({
    offerHashes: ["99".repeat(32)],
    nullifiers: ["98".repeat(32)],
    payouts: new Map([[A, 6n]]),
  })).toBe(true);
  expect(stock.available(A)).toBe(14n);

  const resolve = (amountIn: string) => resolveSwapJobRoute(
    job("budget", amountIn, "1"),
    { book, isCurrent: () => true },
    stock,
    { nowMs: Date.now(), expiryMarginSeconds: 120, unavailableOfferHashes: [] },
  );
  // One resolve per size: a second one would refuse "already claimed", which is
  // the offer-reservation property and not this test's subject.
  const fifteen = resolve("15");
  expect(receiptAmount(fifteen, A)).toBe(5n);
  expect([...fifteen.claim.payouts]).toEqual([]);
  // The tokenIn reservation is untouched by the route: only a payout reserves.
  expect(stock.reserved(A)).toBe(6n);
  expect(stock.reserved(B)).toBe(0n);
});

test("publication and admission share the complete staircase and range", () => {
  const book = new Book();
  for (const source of LADDER()) book.upsert(source);
  const published = deriveLadderPush({ book, isCurrent: () => true }, {
    nowMs: Date.now(), expiryMarginSeconds: 120,
  });
  expect(published.priceLevels.levels[0]!.levels).toEqual([
    { input: "10", output: "30" }, { input: "19", output: "30" },
    { input: "20", output: "50" }, { input: "29", output: "50" },
    { input: "30", output: "60" }, { input: "300", output: "60" },
  ]);
  for (const balances of [{}, { [A]: 1_000n, [B]: 1_000n }]) {
    expect(receiptAmount(routeFor("19", "30", { balances }).route, A)).toBe(9n);
    expect(refusalReason(() => routeFor("19", "31", { balances }))).toBe(JOB_ROUTE_NOT_CURRENT);
    expect(receiptAmount(routeFor("300", "60", { balances }).route, A)).toBe(270n);
    expect(refusalReason(() => routeFor("301", "1", { balances }))).toBe(JOB_ROUTE_NOT_CURRENT);
  }
});


test("FR-002 the policy the executor admits with is the policy publication used", () => {
  // Both layers now read the same `JobAdmissionPolicy` object through the same
  // forwarder, so a pair or minimum that hides a rung also refuses the job —
  // which is what P4-F02 broke in one direction only (published, then refused).
  const book = new Book();
  for (const source of LADDER()) book.upsert(source);
  const policy = {
    supportedPairs: new Set([admissionPairKey(B, A)]),
    minJobOutput: new Map([[A, 1n]]),
  };
  expect(deriveLadderPush({ book, isCurrent: () => true }, {
    nowMs: Date.now(), expiryMarginSeconds: 120, ...policy,
  }).priceLevels.levels).toEqual([]);
  expect(refusalReason(() => resolveSwapJobRoute(
    job("policy", "15", "25"),
    { book, isCurrent: () => true },
    (() => { const stock = new Stock(); stock.setBalances({ [A]: 1_000n, [B]: 1_000n }); return stock; })(),
    { nowMs: Date.now(), expiryMarginSeconds: 120, unavailableOfferHashes: [], ...policy },
  ))).toBe(JOB_PAIR_UNSUPPORTED);
});

test("C5 hard case publishes 14 points and switches exact makers with both surpluses", async () => {
  const unit = 1_000_000n;
  const sources = [
    offer(H1, N1, unit, unit),
    offer(H2, N2, 10n * unit, 20n * unit),
    offer(H3, N3, 150n * unit, 100n * unit),
  ];
  const book = new Book();
  sources.forEach((source) => book.upsert(source));
  const publication = deriveLadderPush({ book, isCurrent: () => true }, {
    nowMs: Date.now(), expiryMarginSeconds: 120,
  });
  expect(publication.priceLevels.levels[0]!.levels).toHaveLength(14);
  expect(publication.derived.provenance[0]!.combinations).toHaveLength(7);
  expect(publication.derived.provenance[0]!.terminalInput).toBe("1610000000");
  for (const [input, output, hashes, surplusIn, surplusOut] of [
    ["150000000", "100000000", [H3], 0n, 0n],
    ["159990000", "100000000", [H1, H3], 8_990_000n, unit],
    ["160000000", "120000000", [H2, H3], 0n, 0n],
    ["1610000000", "121000000", [H1, H2, H3], 1_449_000_000n, 0n],
  ] as const) {
    const h = harness({ offers: sources, balances: {}, status: "consumed" });
    try {
      expect((await h.executor.onSwap(job("hard-case", input, output))).type).toBe("swap-tx");
      expect(h.exactRequests).toEqual([[...hashes]]);
      expect(h.legs.every((leg) => Object.keys(leg.inputs).length === 0)).toBe(true);
      const outputs = h.legs.flatMap((leg) => leg.outputs);
      expect(outputs.filter((entry) => entry.raw === A).reduce((sum, entry) => sum - entry.amount, 0n)).toBe(surplusIn);
      expect(outputs.filter((entry) => entry.raw === B).reduce((sum, entry) => sum - entry.amount, 0n)).toBe(surplusOut);
      expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, -BigInt(input)], [B, BigInt(output)]]);
      await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "hard-case", txId: RELAY_TX });
      for (const source of sources) expect(h.book.get(source.offerHash) === undefined).toBe(new Set<string>(hashes).has(source.offerHash));
    } finally { await h.executor.stop(); }
  }
  for (const input of ["999999", "1610000001"]) {
    expect(refusalReason(() => routeFor(input, "1", { offers: sources }))).toBe(JOB_ROUTE_NOT_CURRENT);
  }
});

test("C5 reverse-direction tail pays150A from three exact files and retains100B", async () => {
  const unit = 1_000_000n;
  const sources = ([[H1, N1, 20n, 100n], [H2, N2, 10n, 40n], [H3, N3, 30n, 10n]] as const)
    .map(([hash, nullifier, cost, output]) => {
      const source = offer(hash, nullifier, cost * unit, output * unit);
      source.gives[0]!.token = A;
      source.wants[0]!.token = B;
      return source;
    });
  const h = harness({ offers: sources, balances: {}, status: "consumed" });
  try {
    const published = deriveLadderPush({ book: h.book, isCurrent: () => true }, {
      nowMs: Date.now(), expiryMarginSeconds: 120,
    });
    expect(published.priceLevels.levels[0]!.levels).toHaveLength(8);
    const reverse = { ...job("reverse-tail", "160000000", "150000000"), tokenIn: B, tokenOut: A };
    expect((await h.executor.onSwap(reverse)).type).toBe("swap-tx");
    expect(h.exactRequests).toEqual([[H1, H2, H3]]);
    expect(h.legs[0]).toMatchObject({ inputs: {}, outputs: [
      { seg: 0, tag: "shielded", raw: B, amount: -100_000_000n },
    ] });
    expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, 150_000_000n], [B, -160_000_000n]]);
    await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "reverse-tail", txId: RELAY_TX });
    expect(h.book.size).toBe(0);
  } finally { await h.executor.stop(); }
  for (const [input, admitted] of [["600000000", true], ["600000001", false]] as const) {
    const fresh = harness({ offers: sources, balances: {} });
    try {
      const result = await fresh.executor.onSwap({ ...job("reverse-bound", input, "150000000"), tokenIn: B, tokenOut: A });
      expect(result.type).toBe(admitted ? "swap-tx" : "job-error");
    } finally { await fresh.executor.stop(); }
  }
});

test("C5 24A=>20B, refused24A=>28B, then25A=>28B use only funded whole offers", async () => {
  for (const balances of [{}, { [A]: 1_000n, [B]: 1_000n }]) {
    const sources = [offer(H1, N1, 10n, 20n), offer(H2, N2, 15n, 10n)];
    const refused = harness({ offers: sources, balances });
    try {
      expect((await refused.executor.onSwap(job("short", "24", "28"))).type).toBe("job-error");
      expect(refused.calls).toEqual([]);
      expect(refused.stock.isClaimed({ offerHashes: [H1, H2], nullifiers: [N1, N2] })).toBe(false);
      expect((await refused.executor.onSwap(job("valid-after-short", "25", "28"))).type).toBe("swap-tx");
      expect(refused.exactRequests).toEqual([[H1, H2]]);
      expect(refused.legs[0]).toMatchObject({ inputs: {}, outputs: [
        { seg: 0, tag: "shielded", raw: B, amount: -2n },
      ] });
    } finally { await refused.executor.stop(); }
    const plateau = harness({ offers: sources, balances });
    try {
      expect((await plateau.executor.onSwap(job("plateau24", "24", "20"))).type).toBe("swap-tx");
      expect(plateau.exactRequests).toEqual([[H1]]);
      expect(plateau.legs[0]).toMatchObject({ inputs: {}, outputs: [
        { seg: 0, tag: "shielded", raw: A, amount: -14n },
      ] });
    } finally { await plateau.executor.stop(); }
  }
});

test("fresh expiry and source cap refuse after bounded search before reservation", () => {
  const book = new Book();
  const source = offer(H1, N1, 10n, 20n);
  source.expiresAt = 200_000;
  book.upsert(source);
  const stock = new Stock();
  expect(refusalReason(() => resolveSwapJobRoute(job(), { book, isCurrent: () => true }, stock, {
    nowMs: 0, freshNowMs: () => 80_000, expiryMarginSeconds: 120, unavailableOfferHashes: [],
  }))).toBe(JOB_ROUTE_NOT_CURRENT);
  expect(stock.isOfferClaimed(source)).toBe(false);
  book.upsert(offer(H2, N2, 10n, 10n));
  book.all = () => { throw new Error("unbounded source copy"); };
  expect(refusalReason(() => resolveSwapJobRoute(job(), { book, isCurrent: () => true }, stock, {
    nowMs: 0, expiryMarginSeconds: 120, unavailableOfferHashes: [], resourceLimits: { maxSourceOffers: 1 },
  }))).toBe(JOB_ROUTE_NOT_CURRENT);
});

test("maker deletion during exact read and expiry during address read cause zero wallet mutation", async () => {
  const deleted = harness();
  deleted.blockExact();
  const pending = deleted.executor.onSwap(job("deleted"));
  await Promise.resolve();
  deleted.book.remove(H1);
  deleted.releaseExact();
  expect((await pending).type).toBe("job-error");
  expect(deleted.calls).toEqual(["exact-files"]);
  expect(deleted.stock.isClaimed({ offerHashes: [H1], nullifiers: [N1] })).toBe(false);
  await deleted.executor.stop();

  const expired = harness({ blockWallet: true });
  const blocked = expired.executor.onSwap(job("expired-address"));
  await Promise.resolve();
  await Promise.resolve();
  expired.advance(3_600_000);
  expired.releaseWallet();
  expect((await blocked).type).toBe("job-error");
  expect(expired.calls).toEqual(["exact-files"]);
  expect(expired.stock.isClaimed({ offerHashes: [H1], nullifiers: [N1] })).toBe(false);
  await expired.executor.stop();
});

test("signed-delta terminal cap keeps receipts buildable and rejects M+1 jobs", () => {
  const cost = MAX_SETTLEMENT_AMOUNT / 10n + 1n;
  const sources = [offer(H1, N1, cost, MAX_SETTLEMENT_AMOUNT)];
  const { route } = routeFor(MAX_SETTLEMENT_AMOUNT.toString(), "1", { offers: sources, balances: {} });
  expect(receiptAmount(route, A)).toBe(MAX_SETTLEMENT_AMOUNT - cost);
  expect(receiptAmount(route, B)).toBe(MAX_SETTLEMENT_AMOUNT - 1n);
  expect(refusalReason(() => routeFor((MAX_SETTLEMENT_AMOUNT + 1n).toString(), "1", { offers: sources })))
    .toBe(JOB_ROUTE_NOT_CURRENT);
  expect(refusalReason(() => routeFor("1", (MAX_SETTLEMENT_AMOUNT + 1n).toString(), { offers: sources })))
    .toBe(JOB_ROUTE_NOT_CURRENT);
});
