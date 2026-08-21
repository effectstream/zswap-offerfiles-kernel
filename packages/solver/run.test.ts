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

function syncHarness(lifecycle: string[]): SyncDependencies {
  return {
    getZswapsPage: async () => ({ offers: [row], nextCursor: null }),
    getZswapByHash: async () => row as any,
    getBackendSyncHealth: async () => ({
      ts: Date.now(),
      status: "ok",
      blockL2: { height: "7" },
      ntp: { current: 7, tip: 7, pct: 100, lagBlocks: 0, lagSeconds: 0 },
      midnight: { current: 7, fetched: 7, tip: 7, pct: 100, lagBlocks: 0 },
      celestia: { current: 7, fetched: 7, tip: 7, pct: 100, lagBlocks: 0 },
    }),
    openUpdatesStream: (_handler, options) => {
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

test("runSolver starts relay beside the mirror, executes a job, and shuts down in authority order", async () => {
  const lifecycle: string[] = [];
  const socket = new RunSocket(lifecycle);
  const walletReverts: unknown[] = [];
  const wallet = {
    shielded: { getAddress: async () => "solver-address" },
    dust: { balanceTransactions: async () => tx("dust-unproved", [
      { seg: 0, tag: "dust", raw: "dust", amount: 1n },
    ]) },
    initSwap: async () => ({ transaction: tx("mirror") }),
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
    syncDependencies: syncHarness(lifecycle),
    relayCreateWebSocket: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
    walletDependencies: {
      buildWallet: async () => walletOwner,
      waitForSync: async () => {},
      shieldedBalances: async () => ({ [B]: 1_000n }),
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
      getOfferStatus: async (offerId) => ({ offerId, status: "live" }),
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
