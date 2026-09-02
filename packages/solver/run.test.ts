import { expect, test } from "bun:test";

import type { Imbalance } from "@zswap-da/solver-core/batcher";

import {
  armBookReadyDecisionGate,
  createBookReadyDecisionGate,
  createInventoryRefreshController,
  initializeOwnedResource,
  runSolver,
} from "./src/run.ts";
import type { SyncDependencies } from "./src/book-sync.ts";
import { RELAY_WS_OPEN, type RelayWebSocketLike } from "./src/relay-client.ts";
import { Stock } from "./src/stock.ts";
import { SolverOperationJournal } from "./src/operation-journal.ts";
import { JOB_RECONCILING, JOB_ROUTE_UNAVAILABLE } from "./src/swap-job-executor.ts";

const TOKEN = "a".repeat(64);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

test("partial snapshot changes cannot execute before ready and coalesce afterward", async () => {
  let decisions = 0;
  const gate = createBookReadyDecisionGate(() => { decisions += 1; });
  gate.request();
  gate.request();
  await Promise.resolve();
  expect(decisions).toBe(0);
  gate.markReady();
  gate.request();
  await Promise.resolve();
  expect(decisions).toBe(1);
});

test("stop before rejected readiness neither executes nor leaks rejection", async () => {
  let decisions = 0;
  const gate = createBookReadyDecisionGate(() => { decisions += 1; });
  const ready = deferred<void>();
  armBookReadyDecisionGate(ready.promise, gate);
  gate.stop();
  ready.reject(new Error("sync stopped"));
  await Promise.resolve();
  await Promise.resolve();
  expect(decisions).toBe(0);
});

test("a superseded late balance read cannot overwrite a newer zero balance", async () => {
  const stock = new Stock();
  const first = deferred<Record<string, bigint>>();
  const second = deferred<Record<string, bigint>>();
  const reads = [first, second];
  const controller = createInventoryRefreshController({
    stock,
    readBalances: async () => reads.shift()!.promise,
  });
  const old = controller.refresh().catch((error) => error);
  await Promise.resolve();
  const current = controller.refresh();
  second.resolve({ [TOKEN]: 0n });
  await current;
  first.resolve({ [TOKEN]: 9_999n });
  expect(await old).toBeInstanceOf(Error);
  await Promise.resolve();
  expect(stock.balance(TOKEN)).toBe(0n);
  expect(controller.isReady()).toBe(true);
});

test("failed authoritative balance refresh withdraws Stock until recovery", async () => {
  const stock = new Stock();
  const reads: Array<Promise<Record<string, bigint>>> = [
    Promise.resolve({ [TOKEN]: 1_000n }),
    Promise.reject(new Error("wallet unavailable")),
    Promise.resolve({ [TOKEN]: 250n }),
  ];
  const controller = createInventoryRefreshController({
    stock,
    readBalances: async () => reads.shift()!,
  });
  await controller.refresh();
  await expect(controller.refresh()).rejects.toThrow("wallet unavailable");
  expect(controller.isReady()).toBe(false);
  expect(stock.tokens()).toEqual([]);
  await controller.refresh();
  expect(stock.available(TOKEN)).toBe(250n);
});

test("wallet startup timeout cleans an acquired owner", async () => {
  let cleanupCalls = 0;
  await expect(initializeOwnedResource({
    build: async () => ({ wallet: true }),
    initialize: async () => await new Promise<void>(() => {}),
    cleanup: async () => { cleanupCalls += 1; },
    startupTimeoutMs: 5,
    cleanupTimeoutMs: 20,
  })).rejects.toThrow("wallet startup timed out after 5 ms");
  expect(cleanupCalls).toBe(1);
});

test("external startup cancellation observes and cleans a wallet that builds late", async () => {
  const outer = new AbortController();
  const built = deferred<{ wallet: true }>();
  const cleaned = deferred<void>();
  const reason = new Error("startup cancelled before wallet build");
  const startup = initializeOwnedResource({
    build: () => built.promise,
    initialize: async () => {},
    cleanup: async () => cleaned.resolve(),
    startupTimeoutMs: 1_000,
    cleanupTimeoutMs: 100,
    signal: outer.signal,
  });
  outer.abort(reason);
  await expect(startup).rejects.toBe(reason);
  built.resolve({ wallet: true });
  await cleaned.promise;
});

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const OFFER_HASH = "11".repeat(32);
const NULLIFIER = "31".repeat(32);

const row = {
  version: 1 as const,
  offerId: OFFER_HASH,
  computed: {
    gives: [{ token: B, amount: "20", type: "SHIELDED" as const }],
    wants: [{ token: A, amount: "10", type: "SHIELDED" as const }],
    expiresAt: "2099-01-01T00:00:00.000Z",
    firstSeenAt: "2026-08-20T00:00:00.000Z",
    inputNullifiers: [NULLIFIER],
    status: "live" as const,
  },
};

const OFFER_HASH_2 = "12".repeat(32);
const NULLIFIER_2 = "32".repeat(32);

/** A second, WORSE-rate offer on the same pair, so the seeded book has an
 *  INTERIOR interval — the only thing the F03 residual budget is ever about.
 *  Rate 1 against `row`'s rate 2, so the unbounded ladder is (10, 20) then
 *  (20, 30) and the interval (10, 20) can demand up to floor(10 · 9 / 10) = 9
 *  of tokenOut out of the solver's own inventory. */
const row2 = {
  ...row,
  offerId: OFFER_HASH_2,
  computed: {
    ...row.computed,
    gives: [{ token: B, amount: "10", type: "SHIELDED" as const }],
    inputNullifiers: [NULLIFIER_2],
  },
};

function syncHarness(lifecycle: string[], rows: Array<typeof row> = [row]): SyncDependencies {
  return {
    getZswapsPage: async () => ({ offers: rows, nextCursor: null }),
    getZswapByHash: async (hash: string) =>
      (rows.find((entry) => entry.offerId === hash) ?? rows[0]) as any,
    getBackendSyncHealth: async () => ({
      ts: Date.now(),
      status: "ok",
      blockL2: { height: "7" },
      ntp: { current: 7, tip: 7, pct: 100, lagBlocks: 0, lagSeconds: 0 },
      midnight: { current: 7, fetched: 7, tip: 7, pct: 100, lagBlocks: 0 },
      celestia: { current: 7, fetched: 7, tip: 7, pct: 100, lagBlocks: 0 },
    }),
    openUpdatesStream: (_handler, options = {}) => {
      queueMicrotask(() => options.onOpen?.({ streamId: "00".repeat(16), blockL2Height: null }));
      return { close: async () => { lifecycle.push("mirror-stop"); } };
    },
  } as SyncDependencies;
}

class RunSocket implements RelayWebSocketLike {
  readyState = 0;
  onopen: ((event?: any) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: any) => void) | null = null;
  onclose: ((event?: any) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly lifecycle: string[];

  constructor(lifecycle: string[]) {
    this.lifecycle = lifecycle;
  }

  open(): void {
    this.readyState = RELAY_WS_OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.lifecycle.push("relay-close");
    this.readyState = 3;
    this.onclose?.();
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

interface FakeTx {
  label: string;
  rows: Imbalance[];
  serialize: () => Uint8Array;
}

const tx = (label: string, rows: Imbalance[] = []): FakeTx => ({
  label,
  rows,
  serialize: () => new TextEncoder().encode(label),
});

const merge = (transactions: any[]): FakeTx => tx(
  transactions.map((transaction) => transaction.label).join("+"),
  transactions.flatMap((transaction) => transaction.rows ?? []),
);

test("journal validation failure happens before wallet acquisition", async () => {
  let walletBuilds = 0;
  await expect(runSolver({
    dryRun: false,
    relayUrl: "ws://relay.test/solver",
    relayHttpUrl: "http://relay.test/api/v1",
    relayAuthToken: "r".repeat(64),
    journalOptions: { path: "/unused/solver.sqlite" },
    journalOpen: (() => { throw new Error("injected journal validation failure"); }) as any,
    walletDependencies: {
      buildWallet: async () => { walletBuilds += 1; throw new Error("must not build"); },
    } as any,
    log: () => {},
  })).rejects.toThrow("injected journal validation failure");
  expect(walletBuilds).toBe(0);
});

test("production-parity dry-run syncs real wallet inventory but invokes no mutating wallet or relay path", async () => {
  const lifecycle: string[] = [];
  const calls: string[] = [];
  let mutations = 0;
  let relayStarts = 0;
  const wallet = {
    initSwap: async () => { mutations += 1; throw new Error("must not mutate"); },
    finalizeTransaction: async () => { mutations += 1; throw new Error("must not mutate"); },
    revertTransaction: async () => { mutations += 1; },
    revert: async () => { mutations += 1; },
    dust: { balanceTransactions: async () => { mutations += 1; throw new Error("must not mutate"); } },
    stop: async () => { calls.push("wallet-stop"); },
  };
  const handle = await runSolver({
    dryRun: true,
    syncDependencies: syncHarness(lifecycle),
    resyncIntervalMs: 60_000,
    backendHealthCheckIntervalMs: 30_000,
    backendHealthMaxAgeMs: 60_000,
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    walletDependencies: {
      buildWallet: async () => { calls.push("wallet-build"); return { wallet } as any; },
      waitForSync: async () => { calls.push("wallet-sync"); },
      shieldedBalances: async () => { calls.push("balances"); return { [B]: 77n }; },
      shieldedKeys: () => { throw new Error("dry-run must not load mutating keys"); },
    },
    relayCreateWebSocket: () => { relayStarts += 1; throw new Error("relay must not start"); },
    log: () => {},
  });
  await handle.ready;
  expect(calls.slice(0, 3)).toEqual(["wallet-build", "wallet-sync", "balances"]);
  expect(handle.stock.balance(B)).toBe(77n);
  expect(mutations).toBe(0);
  expect(relayStarts).toBe(0);
  await handle.stop();
  expect(calls).toContain("wallet-stop");
});

test("test-only dry-run wallet opt-out is explicit and loudly reports missing parity", async () => {
  const logs: string[] = [];
  let walletBuilds = 0;
  const handle = await runSolver({
    dryRun: true,
    dryRunWalletMode: "skip-test-only",
    syncDependencies: syncHarness([]),
    resyncIntervalMs: 60_000,
    backendHealthCheckIntervalMs: 30_000,
    backendHealthMaxAgeMs: 60_000,
    walletDependencies: {
      buildWallet: async () => { walletBuilds += 1; throw new Error("must skip"); },
    } as any,
    log: (message) => logs.push(message),
  });
  await handle.ready;
  expect(walletBuilds).toBe(0);
  expect(logs.some((message) => message.includes("TEST-ONLY") && message.includes("NO Path-A parity")))
    .toBe(true);
  await handle.stop();
});

test("relay publishes empty and rejects jobs until journal reconciliation finishes", async () => {
  const lifecycle: string[] = [];
  const journal = SolverOperationJournal.open({ path: ":memory:", allowMemory: true });
  const ttl = Date.now() + 60_000;
  journal.createPrepared({
    operationKey: "job:reopen:g1:settlement",
    jobId: "reopen",
    generation: 1,
    offerHashes: [OFFER_HASH],
    claim: { inputs: [NULLIFIER], payouts: { [B]: "5" } },
    operationKind: "JOB_SETTLEMENT",
    ttlExpiresAtMs: ttl,
    deadlineAtMs: ttl - 1,
  });
  journal.transition("job:reopen:g1:settlement", "PREPARED", "APPLIED");
  journal.createPrepared({
    operationKey: "job:reopen:g1:wallet",
    jobId: "reopen",
    generation: 1,
    offerHashes: [OFFER_HASH],
    claim: { inputs: [NULLIFIER], payouts: { [B]: "5" } },
    operationKind: "FINALIZED_CONTRIBUTION",
    ttlExpiresAtMs: ttl,
    deadlineAtMs: ttl - 1,
    walletArtifactKind: "FINALIZED_TRANSACTION",
    walletArtifactBytes: new TextEncoder().encode("restart-final"),
  });
  journal.transition("job:reopen:g1:wallet", "PREPARED", "APPLIED");

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let revertStarted = false;
  let relayConstructions = 0;
  let reconciliationSocket: RunSocket | null = null;
  const wallet = {
    shielded: { getAddress: async () => "solver-address" },
    dust: { balanceTransactions: async () => tx("dust") },
    initSwap: async () => ({ transaction: tx("raw") }),
    finalizeTransaction: async () => tx("final"),
    revertTransaction: async () => {},
    revert: async () => {
      revertStarted = true;
      await barrier;
    },
    stop: async () => { lifecycle.push("wallet-stop"); },
  };
  const startup = runSolver({
    dryRun: false,
    api: "http://backend.test",
    relayUrl: "ws://relay.test/solver",
    relayHttpUrl: "http://relay.test/api/v1",
    relayAuthToken: "r".repeat(64),
    relayPushIntervalMs: 60_000,
    relayReconnectDelayMs: 60_000,
    relayConnectTimeoutMs: 1_000,
    relayWithdrawTimeoutMs: 100,
    jobSweepIntervalMs: 60_000,
    resyncIntervalMs: 60_000,
    backendHealthCheckIntervalMs: 30_000,
    backendHealthMaxAgeMs: 60_000,
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    journalOptions: { path: ":memory:", allowMemory: true },
    journalOpen: () => journal,
    syncDependencies: syncHarness(lifecycle),
    relayCreateWebSocket: () => {
      relayConstructions += 1;
      reconciliationSocket = new RunSocket(lifecycle);
      queueMicrotask(() => reconciliationSocket?.open());
      return reconciliationSocket;
    },
    walletDependencies: {
      buildWallet: async () => ({ wallet }),
      waitForSync: async () => {},
      // tokenOUT only, which is all this solver ever needs (00006-R2). `B: 1000`
      // is load-bearing here for a different reason: the durable journal claim
      // rebuilt during reconciliation pays out 5 B, and `Stock.reserve` must be
      // able to hold it. Was `{[A]: 1_000n, [B]: 1_000n}`, because the 00005-R2
      // tokenIn cap would otherwise have published nothing and the
      // "post-reconciliation ladder" wait below would have hung.
      shieldedBalances: async () => ({ [B]: 1_000n }),
      shieldedKeys: () => ({ dustSecretKey: "dust-key" }),
    } as any,
    jobDependencies: {
      mergeFinalized: merge as any,
      serializeUnproven: (transaction: any) => transaction.serialize(),
      deserializeUnproven: (bytes) => tx(new TextDecoder().decode(bytes)),
      serializeFinalized: (transaction: any) => transaction.serialize(),
      deserializeFinalized: (bytes) => tx(new TextDecoder().decode(bytes)) as any,
    },
    log: () => {},
  });
  await waitFor(() => revertStarted, "journal reconciliation revert");
  expect(relayConstructions).toBe(1);
  await waitFor(() => reconciliationSocket?.sent.some((frame) =>
    frame.type === "price-levels" && Array.isArray(frame.levels) && frame.levels.length === 0) ?? false,
  "empty reconciliation ladder");
  reconciliationSocket!.receive({
    type: "swap", jobId: "during-reconcile", tokenIn: A, tokenOut: B,
    amountIn: "10", amountOut: "20",
  });
  await waitFor(() => reconciliationSocket?.sent.some((frame) =>
    frame.type === "job-error" && frame.jobId === "during-reconcile" &&
    frame.reason === JOB_RECONCILING) ?? false,
  "reconciliation job refusal");
  release();
  const handle = await startup;
  expect(relayConstructions).toBe(1);
  await waitFor(() => reconciliationSocket?.sent.some((frame) =>
    frame.type === "price-levels" && Array.isArray(frame.levels) && frame.levels.length > 0) ?? false,
  "post-reconciliation ladder");
  await handle.stop();
});

test("runSolver starts relay beside the mirror, executes a job, and shuts down in authority order", async () => {
  const lifecycle: string[] = [];
  const socket = new RunSocket(lifecycle);
  const walletReverts: unknown[] = [];
  const wallet = {
    shielded: { getAddress: async () => "solver-address" },
    dust: { balanceTransactions: async () => tx("dust-unproved", [
      { seg: 0, tag: "dust", raw: "dust", amount: 1n },
    ]) },
    // The solver's own balancing leg — the ONLY `initSwap` caller since 00006-R1
    // (it was labelled "mirror" while fee sizing had one). Never reached by the
    // exact-rung job below, which pays no residual and keeps no surplus.
    initSwap: async () => ({ transaction: tx("solver-leg") }),
    finalizeTransaction: async () => tx("dust-final", [
      { seg: 0, tag: "dust", raw: "dust", amount: 1n },
    ]),
    revertTransaction: async () => {},
    revert: async (transaction: unknown) => { walletReverts.push(transaction); },
    stop: async () => { lifecycle.push("wallet-stop"); },
  };
  const walletOwner = { wallet, dustSecretKey: "dust-key", zswapSecretKeys: {} } as any;

  const handle = await runSolver({
    dryRun: false,
    api: "http://backend.test",
    relayUrl: "ws://relay.test/solver",
    relayHttpUrl: "http://relay.test/api/v1",
    relayAuthToken: "r".repeat(64),
    relayPushIntervalMs: 60_000,
    relayReconnectDelayMs: 60_000,
    relayConnectTimeoutMs: 1_000,
    relayWithdrawTimeoutMs: 100,
    jobSweepIntervalMs: 60_000,
    resyncIntervalMs: 60_000,
    backendHealthCheckIntervalMs: 30_000,
    backendHealthMaxAgeMs: 60_000,
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    journalOptions: { path: ":memory:", allowMemory: true },
    syncDependencies: syncHarness(lifecycle),
    relayCreateWebSocket: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
    walletDependencies: {
      buildWallet: async () => walletOwner,
      waitForSync: async () => {},
      // SC-002 at the wiring layer: NO inventory of either token. The job below
      // is an exact whole-maker rung, so it pays no residual, and 00006-R2
      // removed the tokenIn bound that used to require `A` here.
      shieldedBalances: async () => ({}),
      shieldedKeys: () => ({ dustSecretKey: "dust-key" }),
    } as any,
    jobDependencies: {
      readExactOfferFiles: async (offerIds) => ({
        schemaVersion: 1,
        profile: "native-shielded-v1",
        files: offerIds.map((offerId) => ({
          offerId,
          verdict: {
            schemaVersion: 1,
            profile: "native-shielded-v1",
            valid: true,
            live: true,
            claimedOfferId: offerId,
            computedOfferId: offerId,
            stateVersion: "8",
            validatedAt: "2026-08-20T12:00:00.000Z",
            status: "live",
            code: "VALID",
            computed: {
              gives: [{ token: B, amount: "20", kind: "SHIELDED" }],
              wants: [{ token: A, amount: "10", kind: "SHIELDED" }],
              inputNullifiers: [NULLIFIER],
              expiresAt: row.computed.expiresAt,
            },
          },
          offer: `blob:${offerId}`,
        })),
      }) as any,
      reconstructOffer: () => tx("maker", [
        { seg: 0, tag: "shielded", raw: B, amount: 20n },
        { seg: 0, tag: "shielded", raw: A, amount: -10n },
      ]) as any,
      deriveOfferSemantics: () => ({
        gives: [{ token: B, amount: "20", kind: "SHIELDED" }],
        wants: [{ token: A, amount: "10", kind: "SHIELDED" }],
        nullifiers: [NULLIFIER],
      }),
      mergeFinalized: merge as any,
      tokenImbalances: ((transaction: FakeTx) => transaction.rows) as any,
      getOfferConsumptionEvidence: async (offerId) => ({ version: 1, offerId, status: "live" }),
      getRelayJobStatus: async () => ({ status: "pending" }),
      serializeUnproven: (transaction: any) => transaction.serialize(),
      deserializeUnproven: (bytes) => tx(new TextDecoder().decode(bytes)),
      serializeFinalized: (transaction: any) => transaction.serialize(),
      deserializeFinalized: (bytes) => tx(new TextDecoder().decode(bytes)) as any,
    },
    log: () => {},
  });

  try {
    await handle.ready;
    await waitFor(
      () => socket.sent.some((frame) => frame.type === "price-levels"),
      "relay ladder publication",
    );
    expect(handle.book.get(OFFER_HASH)).toBeDefined();
    socket.receive({
      type: "swap",
      jobId: "run-job",
      tokenIn: A,
      tokenOut: B,
      amountIn: "10",
      amountOut: "20",
    });
    await waitFor(
      () => socket.sent.some((frame) => frame.type === "swap-tx" && frame.jobId === "run-job"),
      "swap-tx through runSolver wiring",
    );
    socket.receive({ type: "submit-failed", jobId: "run-job", reason: "relay refused" });
    await handle.idle();
    expect(walletReverts).toHaveLength(1);
  } finally {
    await handle.stop();
  }

  const relayClose = lifecycle.indexOf("relay-close");
  expect(relayClose).toBeGreaterThanOrEqual(0);
  expect(lifecycle.indexOf("mirror-stop")).toBeGreaterThan(relayClose);
  expect(lifecycle.indexOf("wallet-stop")).toBeGreaterThan(relayClose);
  const withdrawal = socket.sent.findLastIndex(
    (frame) => frame.type === "price-levels" && Array.isArray(frame.levels) && frame.levels.length === 0,
  );
  expect(withdrawal).toBeGreaterThanOrEqual(0);
});

// FR-002/FR-003 through the real wiring. This is the layer P4-F02 lived at:
// `runSolver` handed the admission policy to the relay client, the relay
// client's options did not declare it, and it evaporated. The residual budget
// (F03) is wired the same way, so it is asserted here too — end to end from the
// wallet's balance read to the bytes on the socket and back through admission.
//
// RE-ENCODED at 00006-R2 (FR-003 / SC-002). This test was
// "an underfunded solver publishes nothing and refuses the job its ladder would
// have implied": the wallet held only tokenOut, the tokenIn publication cap
// therefore withheld EVERY rung, and the assertion was an empty `price-levels`
// frame plus a `route_unavailable` refusal of the exact-rung job. Both halves
// have changed meaning now that fee sizing spends no tokenIn:
//
//   * publication is NOT empty — the whole-maker rung publishes from a wallet
//     holding NOTHING, which is the availability this project exists to restore;
//   * the refusal that remains is the one that was always a solvency fact: an
//     INTERIOR job whose residual tokenOut the solver cannot pay, refused
//     fail-closed with zero wallet mutation (spec 00006 edge case
//     "zero-tokenOut + interior-demand job racing publication").
test("a solver with NO inventory publishes its whole-maker rung and still refuses an unaffordable residual", async () => {
  const lifecycle: string[] = [];
  const socket = new RunSocket(lifecycle);
  let mutations = 0;
  const wallet = {
    shielded: { getAddress: async () => "solver-address" },
    dust: { balanceTransactions: async () => { mutations += 1; throw new Error("must not size fees"); } },
    // Every wallet entry point counts a mutation: the residual refusal happens
    // inside `resolveSwapJobRoute`, before `buildHalf` touches the wallet at all.
    initSwap: async () => { mutations += 1; throw new Error("must not mutate"); },
    finalizeTransaction: async () => { mutations += 1; throw new Error("must not mutate"); },
    revertTransaction: async () => { mutations += 1; },
    revert: async () => { mutations += 1; },
    stop: async () => { lifecycle.push("wallet-stop"); },
  };

  const handle = await runSolver({
    dryRun: false,
    api: "http://backend.test",
    relayUrl: "ws://relay.test/solver",
    relayHttpUrl: "http://relay.test/api/v1",
    relayAuthToken: "r".repeat(64),
    relayPushIntervalMs: 60_000,
    relayReconnectDelayMs: 60_000,
    relayConnectTimeoutMs: 1_000,
    relayWithdrawTimeoutMs: 100,
    jobSweepIntervalMs: 60_000,
    resyncIntervalMs: 60_000,
    backendHealthCheckIntervalMs: 30_000,
    backendHealthMaxAgeMs: 60_000,
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    journalOptions: { path: ":memory:", allowMemory: true },
    syncDependencies: syncHarness(lifecycle, [row, row2]),
    relayCreateWebSocket: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
    walletDependencies: {
      buildWallet: async () => ({ wallet, dustSecretKey: "dust-key", zswapSecretKeys: {} }),
      waitForSync: async () => {},
      // NOTHING. Not the pair's tokenIn (which nothing reads any more), and not
      // its tokenOut either. Was `{[B]: 1_000n}` — tokenOut had to be funded so
      // that the empty ladder could be attributed to the tokenIn cap alone.
      shieldedBalances: async () => ({}),
      shieldedKeys: () => ({ dustSecretKey: "dust-key" }),
    } as any,
    log: () => {},
  });

  try {
    await handle.ready;
    await waitFor(
      () => socket.sent.some((frame) => frame.type === "price-levels" &&
        Array.isArray(frame.levels) && frame.levels.length > 0),
      "the first non-empty ladder push",
    );
    // AVAILABILITY RESTORED, on the wire, from a wallet with no tokens at all:
    // the whole-maker first rung publishes because the maker offer it consumes
    // pays it, and it opens no interpolation interval. The SECOND rung is
    // withheld by the unchanged F03 residual bound, since the interval it opens
    // could demand 9 of tokenOut this solver does not have.
    expect(handle.book.get(OFFER_HASH)).toBeDefined();
    expect(handle.book.get(OFFER_HASH_2)).toBeDefined();
    const levels = socket.sent.filter((frame) => frame.type === "price-levels");
    expect(levels.at(-1)).toEqual({
      type: "price-levels",
      levels: [{ tokenIn: A, tokenOut: B, levels: [{ input: "10", output: "20" }] }],
    });
    const capabilities = socket.sent.filter((frame) => frame.type === "solver-capabilities");
    expect(capabilities.at(-1)).toMatchObject({ tokenIds: [A, B] });

    // And if the relay dispatches an INTERIOR job anyway (a stale quote, or an
    // operator running with the publication budget open), admission refuses it
    // fail-closed with zero wallet mutation. Size 15 quotes 25 against the full
    // book; the maker prefix pays 20, so 5 of tokenOut would come out of a Stock
    // holding none.
    socket.receive({
      type: "swap", jobId: "unaffordable-residual", tokenIn: A, tokenOut: B,
      amountIn: "15", amountOut: "25",
    });
    await waitFor(
      () => socket.sent.some((frame) =>
        frame.type === "job-error" && frame.jobId === "unaffordable-residual"),
      "the fail-closed job refusal",
    );
    expect(socket.sent.findLast((frame) => frame.type === "job-error")).toEqual({
      type: "job-error",
      jobId: "unaffordable-residual",
      reason: JOB_ROUTE_UNAVAILABLE,
    });
    expect(mutations).toBe(0);
    expect(handle.stock.reserved(B)).toBe(0n);
  } finally {
    await handle.stop();
  }
});
