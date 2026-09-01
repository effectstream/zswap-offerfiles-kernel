import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admissionPairKey } from "@zswap-da/solver-core/admission-policy";
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
  /** Both sides matter after FR-003/FR-004: tokenOut funds a residual payout,
   *  tokenIn funds the mandatory fee-sizing mirror. */
  balances?: Record<string, bigint>;
  journalPath?: string;
} = {}) {
  const book = new Book();
  const sources = options.offers ?? [offer(H1, N1, 10n, 20n)];
  for (const source of sources) book.upsert(source);
  let current = options.current ?? true;
  let now = Date.now();
  let backendStatus = options.status ?? "live";
  const stock = new Stock();
  stock.setBalances(options.balances ?? { [A]: 1_000n, [B]: 1_000n });
  const calls: string[] = [];
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
    // Faithful on the one property the settlement half is verified against:
    // a zswap half's imbalance is (value spent as inputs) − (value created as
    // outputs), so what the solver KEEPS shows up negative. Derived from the
    // call arguments rather than hardcoded, so the surplus legs FR-001 adds
    // (zero inputs, one or two outputs) are modelled instead of assumed.
    initSwap: async (inputs, outputs) => {
      if (walletBarrier) await walletBarrier;
      const shielded = ((inputs as any).shielded ?? {}) as Record<string, bigint>;
      const rows: Imbalance[] = [
        ...Object.entries(shielded).map(([token, amount]) => ({
          seg: 0, tag: "shielded" as const, raw: token, amount,
        })),
        ...(outputs as Array<{ outputs: Array<{ type: string; amount: bigint }> }>)
          .flatMap((group) => group.outputs.map((output) => ({
            seg: 0, tag: "shielded" as const, raw: output.type, amount: -output.amount,
          }))),
      ];
      // Only the fee-sizing mirror ever spends tokenIn; the solver's own
      // balancing leg spends tokenOut or nothing at all.
      const label = shielded[A] === undefined ? "residual" : "mirror";
      legs.push({ label, inputs: { ...shielded }, outputs: rows.filter((row) => row.amount < 0n) });
      calls.push(label);
      return { transaction: fakeTx(label, rows) };
    },
    finalizeTransaction: async (transaction: any) => {
      calls.push(`finalize:${transaction.label}`);
      return transaction.label === "residual"
        ? fakeTx("residual-final", transaction.rows) as any
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
    calls,
    reverts,
    legs,
    imbalanceReads,
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

// FR-001 / P4-F01 BEHAVIOUR CHANGE, recorded here rather than deleted.
//
// Before this test asserted BOTH directions of a strict equality: a job whose
// `amountOut` differed from `interpolateQuote(levels, amountIn)` in either
// direction was refused `route_not_current`. The pinned reference relay only
// ever promises the taker AT MOST the interpolated output and dispatches the
// taker's own demand (`relay-ws.ts` solverAcceptsPrice `output >= requiredOutput`,
// `router/jobId.ts` sendSwap `quote.requiredOutput`), so refusing a LOWER demand
// refused legitimate jobs. What survives — and is pinned below — is the
// above-advertised half of the old assertion; the accepted half is now the
// matrix in the next tests.
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

/** Three distinct marginal rates ⇒ rungs {10,30} {20,50} {30,60}; the interior
 *  quote at 15 is 40; `residualBound` is one whole offer's payout, 30. */
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
  stock.setBalances(options.balances ?? { [A]: 1_000n, [B]: 1_000n });
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

test("FR-001 every reference-valid demand resolves with explicit maker prefix and surplus disposition", () => {
  // amountIn, amountOut, consumed maker prefix, residualIn, residualOut (paid
  // from Stock), surplusOut (retained by the solver).
  const matrix: Array<[string, string, string[], bigint, bigint, bigint]> = [
    // Exact-advertised controls: the only shapes accepted before FR-001.
    ["15", "40", [H1], 5n, 10n, 0n],
    ["20", "50", [H1, H2], 0n, 0n, 0n],
    ["30", "60", [H1, H2, H3], 0n, 0n, 0n],
    // Case 1 — interior above the prefix: the residual path still pays out.
    ["15", "35", [H1], 5n, 5n, 0n],
    ["15", "31", [H1], 5n, 1n, 0n],
    // Case 2 — interior at/below the prefix payout: nothing is paid out and the
    // difference is retained (the taker also overpays input by `residualIn`).
    ["15", "30", [H1], 5n, 0n, 0n],
    ["15", "25", [H1], 5n, 0n, 5n],
    ["15", "1", [H1], 5n, 0n, 29n],
    // Case 3 — lowered exact rung: no residual input, pure retained surplus.
    ["20", "45", [H1, H2], 0n, 0n, 5n],
    ["30", "59", [H1, H2, H3], 0n, 0n, 1n],
    // Case 4 — minimum positive demand at the first and last rung.
    ["10", "1", [H1], 0n, 0n, 29n],
    ["30", "1", [H1, H2, H3], 0n, 0n, 59n],
  ];

  for (const [amountIn, amountOut, prefix, residualIn, residualOut, surplusOut] of matrix) {
    const label = `${amountIn}→${amountOut}`;
    const { route, stock } = routeFor(amountIn, amountOut);
    expect(route.offers.map((source) => source.offerHash), label).toEqual(prefix);
    expect(route.residualIn, label).toBe(residualIn);
    expect(route.residualOut, label).toBe(residualOut);
    expect(route.surplusOut, label).toBe(surplusOut);
    // Exactly one direction is ever live, and the numbers reconcile the job to
    // the maker prefix: prefix.output + residualOut − surplusOut === amountOut.
    expect(route.residualOut === 0n || route.surplusOut === 0n, label).toBe(true);
    const prefixOut = route.offers.reduce((sum, source) => sum + source.gives[0]!.amount, 0n);
    const prefixIn = route.offers.reduce((sum, source) => sum + source.wants[0]!.amount, 0n);
    expect(prefixOut + residualOut - surplusOut, label).toBe(BigInt(amountOut));
    expect(prefixIn + residualIn, label).toBe(BigInt(amountIn));
    // Only a payout consumes budget; retained value is never reserved.
    expect([...route.claim.payouts], label).toEqual(residualOut === 0n ? [] : [[B, residualOut]]);
    expect(stock.reserved(B), label).toBe(residualOut);
    expect(stock.reserved(A), label).toBe(0n);
    // No unselected offer is claimed.
    for (const unselected of LADDER().filter((source) => !prefix.includes(source.offerHash))) {
      expect(stock.isOfferClaimed(unselected), `${label} ${unselected.offerHash}`).toBe(false);
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
  expect(refusalReason(() => routeFor("31", "1"))).toBe(JOB_ROUTE_NOT_CURRENT);
  // `0 <` half of the admission rule.
  expect(refusalReason(() => routeFor("15", "0"))).toBe(JOB_ROUTE_NOT_CURRENT);
  // FR-010: a LOWER demand is exactly what the configured minimum exists to
  // bound, so admission policy still applies to the newly accepted shapes.
  const minimum = new Map([[B, 30n]]);
  expect(refusalReason(() => routeFor("15", "25", { minJobOutput: minimum }))).toBe(JOB_MIN_OUTPUT);
  expect(routeFor("15", "30", { minJobOutput: minimum }).route.surplusOut).toBe(0n);
});

// R2/FR-004 amendment: this test used to run with `{A: 0n, B: 0n}`. A is the
// job's tokenIn, and the mandatory fee-sizing mirror spends the taker's full
// input out of the solver wallet, so a zero-A solver is now refused for a reason
// that has nothing to do with surplus (asserted separately below). The property
// this test exists for — retained surplus needs no tokenOUT inventory — is
// unchanged and still asserted with `B: 0n`.
test("FR-001 retained surplus needs no tokenOut inventory while a residual payout still gates on Stock", () => {
  // Surplus is inflow-only: a solver with zero tokenOut inventory can still
  // serve every at/below-prefix demand.
  for (const [amountIn, amountOut, surplusOut] of [
    ["15", "30", 0n], ["15", "25", 5n], ["20", "45", 5n], ["10", "1", 29n],
  ] as const) {
    const { route, stock } = routeFor(amountIn, amountOut, { balances: { [A]: 1_000n, [B]: 0n } });
    expect(route.surplusOut).toBe(surplusOut);
    expect(route.residualOut).toBe(0n);
    expect(stock.reserved(B)).toBe(0n);
  }
  // The payout direction is unchanged: fail closed when the residual is not
  // affordable, and no claim survives the refusal.
  expect(refusalReason(() => routeFor("15", "35", { balances: { [A]: 1_000n, [B]: 4n } })))
    .toBe(JOB_ROUTE_UNAVAILABLE);
  const affordable = routeFor("15", "35", { balances: { [A]: 1_000n, [B]: 5n } });
  expect(affordable.route.residualOut).toBe(5n);
  expect(affordable.stock.available(B)).toBe(0n);
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
    "exact-files", "mirror", "mirror-revert", "residual", "finalize:residual",
    "dust-balance", "finalize:dust-unproven",
  ]);
  // The solver's own leg: spends nothing, keeps 5 A (overpaid input) + 5 B.
  expect(h.legs.map((leg) => leg.label)).toEqual(["mirror", "residual"]);
  expect(h.legs[1]).toEqual({
    label: "residual",
    inputs: {},
    outputs: [
      { seg: 0, tag: "shielded", raw: A, amount: -5n },
      { seg: 0, tag: "shielded", raw: B, amount: -5n },
    ],
  });
  // The relay half is still exactly the inverse job — the taker is paid the 25
  // it demanded, not the 30 the maker prefix pays — and it contains only the
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
    ["MIRROR_RESERVATION", "REVERTED"],
    ["MIRROR_REVERT", "REVERTED"],
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
  expect(rung.legs[1]).toEqual({
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
  expect(minimum.legs[1]).toEqual({
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

test("FR-001 the residual payout path is unchanged end to end for a lowered interior demand", async () => {
  // Case 1 — still above the prefix payout after lowering: the solver pays the
  // difference out of Stock exactly as before.
  const h = harness({ offers: LADDER(), status: "consumed" });
  expect((await h.executor.onSwap(job("residual-lowered", "15", "35"))).type).toBe("swap-tx");
  expect(h.legs[1]).toEqual({
    label: "residual",
    inputs: { [B]: 5n },
    outputs: [{ seg: 0, tag: "shielded", raw: A, amount: -5n }],
  });
  expect(netImbalance(h.imbalanceReads.at(-1)!.rows)).toEqual([[A, -15n], [B, 35n]]);
  expect(h.stock.reserved(B)).toBe(5n);
  expect(h.journal.list().filter((row) => row.operationKey.endsWith(":residual"))
    .map((row) => row.operationKind)).toEqual(["RESIDUAL_BUILD", "FINALIZED_CONTRIBUTION"]);
  await h.executor.onTxSubmitted({ type: "tx-submitted", jobId: "residual-lowered", txId: RELAY_TX });
  expect(h.executor.stats()).toMatchObject({ completed: 1, quarantined: 0 });
  expect(h.stock.reserved(B)).toBe(0n);
  await h.executor.stop();
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

// ── FR-003 / FR-004: solvency is decided before any wallet mutation ─────────
//
// P4-F04: `buildHalf` opens with a MANDATORY fee-sizing mirror that calls
// `initSwap({shielded: {[tokenIn]: amountIn}}, …)` — it selects real coins for
// the taker's FULL input out of the solver's own wallet and reverts them
// immediately. Nothing at publication or admission proved the wallet could
// spend that much, so an unfundable job failed HALF-WAY THROUGH a wallet
// mutation; if the revert of that mutation was itself uncertain the job went to
// `WalletMutationUncertain` quarantine, stranding the claim and a capacity slot.
// R1 made this strictly more load-bearing: every lowered-demand job builds the
// mirror too.

test("FR-004 an unfundable fee-sizing mirror is refused before any wallet call", async () => {
  // Route level first: the check is inside `resolveSwapJobRoute`, so it is
  // reached before a journal row or a reservation exists.
  expect(refusalReason(() => routeFor("15", "25", { balances: { [A]: 14n, [B]: 1_000n } })))
    .toBe(JOB_ROUTE_UNAVAILABLE);
  // The boundary: exactly the taker's input is enough, one short is not. The
  // requirement is the FULL amountIn, not the residual or the demand.
  const funded = routeFor("15", "25", { balances: { [A]: 15n, [B]: 1_000n } });
  expect(funded.route.surplusOut).toBe(5n);
  expect(funded.stock.reserved(A)).toBe(0n);

  // End to end: zero wallet work, no journal row, nothing claimed.
  const h = harness({ offers: LADDER(), balances: { [A]: 14n, [B]: 1_000n } });
  expect(await h.executor.onSwap(job("mirror-unfundable", "15", "25"))).toEqual({
    type: "job-error",
    jobId: "mirror-unfundable",
    reason: JOB_ROUTE_UNAVAILABLE,
  });
  expect(h.calls).toEqual([]);
  expect(h.legs).toEqual([]);
  expect(h.journal.list()).toEqual([]);
  expect(h.stock.reserved(B)).toBe(0n);
  expect(h.executor.unavailableOfferHashes()).toEqual([]);
  expect(h.executor.stats()).toMatchObject({ building: 0, quarantined: 0, awaitingRelay: 0 });
  await h.executor.stop();

  // One more unit of tokenIn and the same job settles, so the refusal is the
  // budget and nothing else.
  const fundedRun = harness({ offers: LADDER(), balances: { [A]: 15n, [B]: 1_000n } });
  expect((await fundedRun.executor.onSwap(job("mirror-fundable", "15", "25"))).type)
    .toBe("swap-tx");
  expect(fundedRun.legs.map((leg) => leg.label)).toEqual(["mirror", "residual"]);
  await fundedRun.executor.stop();
});

test("FR-004 the mirror budget is AVAILABLE tokenIn, so another job's payout reduces it", () => {
  // A reservation is a promise to pay that has not settled yet, so the coins
  // behind it cannot also fund a mirror. Balance alone would double-count them.
  const book = new Book();
  for (const source of LADDER()) book.upsert(source);
  const stock = new Stock();
  stock.setBalances({ [A]: 20n, [B]: 1_000n });
  // A live claim on an unrelated offer, paying out tokenA.
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
  expect(refusalReason(() => resolve("15"))).toBe(JOB_ROUTE_UNAVAILABLE);
  expect(resolve("10").residualIn).toBe(0n);
});

test("FR-003/FR-004 publication withholds what it cannot execute, and admission refuses it again", () => {
  // The two layers, and the honest statement of how they relate: publication is
  // bounded by each interval's WORST case, admission by the actual job. So a
  // withheld rung's worst job is refused twice, while a cheap job inside the
  // same withheld interval would still resolve — publication is deliberately
  // conservative, and admission is the fail-closed authority.
  const book = new Book();
  for (const source of LADDER()) book.upsert(source);
  const published = (balances: Record<string, bigint>) => {
    const stock = new Stock();
    stock.setBalances(balances);
    return deriveLadderPush({ book, isCurrent: () => true }, {
      nowMs: Date.now(),
      expiryMarginSeconds: 120,
      spendableInventory: stock.spendable(),
    }).priceLevels.levels[0]?.levels ?? [];
  };

  // FR-004. tokenIn 19 cannot fund a job at the second rung's cumulative input
  // (20), so that rung is withheld — and `interpolateQuote` then refuses every
  // size above 10 outright, because the published tail IS the size ceiling.
  const mirrorBalances = { [A]: 19n, [B]: 1_000n };
  expect(published(mirrorBalances)).toEqual([{ input: "10", output: "30" }]);
  // The worst size in the withheld interval is its top, and admission refuses
  // exactly that one on the same number.
  expect(refusalReason(() => routeFor("20", "1", { balances: mirrorBalances })))
    .toBe(JOB_ROUTE_UNAVAILABLE);
  // …while a cheaper size inside the same withheld interval is still fundable.
  expect(routeFor("15", "1", { balances: mirrorBalances }).route.surplusOut).toBe(29n);

  // FR-003. The interval (10, 20) can demand up to floor(20 · 9 / 10) = 18 of
  // tokenOut, so 8 withholds the rung that opens it.
  const residualBalances = { [A]: 1_000n, [B]: 8n };
  expect(published(residualBalances)).toEqual([{ input: "10", output: "30" }]);
  // The worst job in that withheld interval: quote at 19 is 48, of which 18 is
  // a solver payout.
  expect(refusalReason(() => routeFor("19", "48", { balances: residualBalances })))
    .toBe(JOB_ROUTE_UNAVAILABLE);
  // …while a cheap job in the same interval remains affordable. This is not a
  // gap: publication bounds the interval, admission bounds the job.
  expect(routeFor("19", "35", { balances: residualBalances }).route.residualOut).toBe(5n);
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
