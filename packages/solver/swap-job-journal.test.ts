import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Book } from "./src/book.ts";
import {
  SolverOperationJournal,
  type JournalLifecycleState,
  type JournalOperationKind,
} from "./src/operation-journal.ts";
import { Stock } from "./src/stock.ts";
import {
  JOB_DUPLICATE,
  startSwapJobExecutor,
  type SwapJobExecutorHandle,
} from "./src/swap-job-executor.ts";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const H = "11".repeat(32);
const N = "31".repeat(32);
const RELAY_TX = `0x${"cd".repeat(32)}`;
const LEDGER_TX = "ef".repeat(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JOURNAL_CHILD = new URL("./swap-job-journal-child.ts", import.meta.url).pathname;

interface FakeTx {
  label: string;
  serialize: () => Uint8Array;
}

const tx = (label: string): FakeTx => ({
  label,
  serialize: () => encoder.encode(label),
});

const operationKey = (generation: number, kind: JournalOperationKind, label: string): string =>
  `job:restart-job:g${generation}:${kind}:${label}`;

const prepare = (
  journal: SolverOperationJournal,
  generation: number,
  kind: JournalOperationKind,
  label: string,
  artifact?: { kind: "FINALIZED_TRANSACTION" | "UNPROVEN_TRANSACTION"; value: string },
): string => {
  const key = operationKey(generation, kind, label);
  journal.createPrepared({
    operationKey: key,
    jobId: "restart-job",
    generation,
    offerHashes: [H],
    claim: { inputs: [N], payouts: { [B]: "5" } },
    operationKind: kind,
    ttlExpiresAtMs: Date.now() + 60_000,
    deadlineAtMs: Date.now() + 30_000,
    ...(artifact
      ? {
        walletArtifactKind: artifact.kind,
        walletArtifactBytes: encoder.encode(artifact.value),
      }
      : {}),
  });
  return key;
};

const move = (
  journal: SolverOperationJournal,
  key: string,
  state: JournalLifecycleState,
): void => {
  let current = journal.require(key).lifecycleState;
  const step = (next: JournalLifecycleState): void => {
    journal.transition(key, current, next);
    current = next;
  };
  if (state === "PREPARED") return;
  if (state === "APPLIED") return step("APPLIED");
  if (state === "AWAITING_RELAY") {
    step("APPLIED");
    return step("AWAITING_RELAY");
  }
  if (state === "RELAY_SUBMITTED") {
    step("APPLIED");
    step("AWAITING_RELAY");
    return step("RELAY_SUBMITTED");
  }
  if (state === "CONFIRMING") {
    step("APPLIED");
    return step("CONFIRMING");
  }
  if (state === "REVERTING") return step("REVERTING");
  if (state === "QUARANTINED") {
    journal.transition(key, current, "QUARANTINED", {
      errorCode: "LOCAL_REVERT_FAILED",
      errorDetail: "injected crash after a failed revert",
    });
    return;
  }
  throw new Error(`unsupported fixture state ${state}`);
};

interface Started {
  executor: SwapJobExecutorHandle;
  journal: SolverOperationJournal;
  stock: Stock;
  calls: string[];
}

const start = (
  path: string,
  options: {
    signal?: AbortSignal;
    loggerThrows?: boolean;
    blockRevert?: Promise<void>;
    relayStatus?: "pending" | "done" | "error";
    backendStatus?: "live" | "consumed";
  } = {},
): Started => {
  const journal = SolverOperationJournal.open({ path });
  const stock = new Stock();
  stock.setBalances({ [B]: 100n });
  const calls: string[] = [];
  const book = new Book();
  const wallet = {
    shielded: { getAddress: async () => "address" },
    dust: { balanceTransactions: async () => tx("dust") },
    initSwap: async () => ({ transaction: tx("raw") }),
    finalizeTransaction: async () => tx("final"),
    revertTransaction: async (value: FakeTx) => {
      calls.push(`raw:${value.label}`);
      await options.blockRevert;
    },
    revert: async (value: FakeTx) => {
      calls.push(`final:${value.label}`);
      await options.blockRevert;
    },
  };
  const executor = startSwapJobExecutor({
    cache: { book, isCurrent: () => true },
    stock,
    wallet,
    journal,
    keys: { dustSecretKey: "dust" },
    relayHttpUrl: "http://relay.test/api/v1",
    maxParallelSwaps: 2,
    expiryMarginSeconds: 120,
    settleTtlMinutes: 1,
    sweepIntervalMs: 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
    dependencies: {
      readExactOfferFiles: async () => ({ schemaVersion: 1, profile: "native-shielded-v1", files: [] }),
      getOfferConsumptionEvidence: async (offerId) => options.backendStatus === "consumed"
        ? { version: 1, offerId, status: "consumed", evidence: { ledgerTxHash: LEDGER_TX, height: 99 } }
        : { version: 1, offerId, status: "live" },
      getRelayJobStatus: async () => options.relayStatus === "done"
        ? { status: "done", txId: RELAY_TX }
        : options.relayStatus === "error"
          ? { status: "error", reason: "relay rejected" }
          : { status: "pending" },
      reconstructOffer: () => tx("maker") as any,
      deriveOfferSemantics: () => ({ gives: [], wants: [], nullifiers: [] }),
      mergeFinalized: ((values: FakeTx[]) => tx(values.map((value) => value.label).join("+"))) as any,
      tokenImbalances: (() => []) as any,
      serializeUnproven: (value: any) => value.serialize(),
      deserializeUnproven: (bytes) => tx(decoder.decode(bytes)),
      serializeFinalized: (value: any) => value.serialize(),
      deserializeFinalized: (bytes) => tx(decoder.decode(bytes)) as any,
    },
    log: options.loggerThrows ? () => { throw new Error("observer failed"); } : () => {},
  });
  return { executor, journal, stock, calls };
};

const withJournalPath = async (run: (path: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "cow-rf1b-journal-"));
  try {
    await run(join(dir, "solver.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("reopen matrix retries only locally provable artifacts and tombstones the terminal generation", async () => {
  for (const state of ["APPLIED", "REVERTING", "QUARANTINED"] as const) {
    await withJournalPath(async (path) => {
      const seed = SolverOperationJournal.open({ path });
      const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
      if (state !== "REVERTING") move(seed, settlement, state);
      const mutationKind = state === "APPLIED" ? "FINALIZED_CONTRIBUTION" : "JOB_REVERT";
      const mutation = prepare(seed, 1, mutationKind, "wallet", {
        kind: "FINALIZED_TRANSACTION",
        value: `artifact-${state}`,
      });
      move(seed, mutation, state);
      seed.close();

      const first = start(path, { loggerThrows: true });
      await first.executor.ready;
      expect(first.calls).toEqual([`final:artifact-${state}`]);
      expect(first.stock.reserved(B)).toBe(0n);
      expect(first.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
      await first.executor.stop();
      first.journal.close();

      const second = start(path);
      await second.executor.ready;
      expect(second.calls).toEqual([]);
      expect(await second.executor.onSwap({
        type: "swap", jobId: "restart-job", tokenIn: A, tokenOut: B,
        amountIn: "10", amountOut: "20",
      })).toEqual({ type: "job-error", jobId: "restart-job", reason: JOB_DUPLICATE });
      await second.executor.stop();
      second.journal.close();
    });
  }
});

test("abrupt child-process exit reopens fail-closed at every lifecycle boundary", async () => {
  for (const state of [
    "ARTIFACTLESS",
    "APPLIED",
    "AWAITING_RELAY",
    "RELAY_SUBMITTED",
    "CONFIRMING",
    "REVERTING",
    "QUARANTINED",
    "REVERTED",
    "SETTLED",
  ] as const) {
    await withJournalPath(async (path) => {
      const child = Bun.spawn([process.execPath, JOURNAL_CHILD, path, state], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "", stderr: "", exitCode: 0 });

      const reopened = start(path);
      await reopened.executor.ready;
      if (state === "APPLIED" || state === "REVERTING" || state === "QUARANTINED") {
        expect(reopened.calls).toEqual([`final:child-${state}`]);
        expect(reopened.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
        expect(reopened.stock.reserved(B)).toBe(0n);
      } else if (state === "REVERTED") {
        expect(reopened.calls).toEqual([]);
        expect(reopened.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
        expect(reopened.stock.reserved(B)).toBe(0n);
      } else if (state === "SETTLED") {
        expect(reopened.calls).toEqual([]);
        expect(reopened.journal.list().every((row) => row.lifecycleState === "SETTLED")).toBe(true);
        expect(reopened.stock.reserved(B)).toBe(0n);
      } else {
        expect(reopened.calls).toEqual([]);
        expect(reopened.journal.list().every((row) => row.lifecycleState === "QUARANTINED")).toBe(true);
        expect(reopened.stock.reserved(B)).toBe(5n);
        expect(reopened.executor.unavailableOfferHashes()).toEqual([H]);
      }
      await reopened.executor.stop();
      reopened.journal.close();
    });
  }
});

test("every APPLIED public unproven artifact is locally restorable after reopen", async () => {
  for (const kind of ["MIRROR_RESERVATION", "RESIDUAL_BUILD", "DUST_BALANCE"] as const) {
    await withJournalPath(async (path) => {
      const seed = SolverOperationJournal.open({ path });
      const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
      move(seed, settlement, "APPLIED");
      const mutation = prepare(seed, 1, kind, kind.toLowerCase(), {
        kind: "UNPROVEN_TRANSACTION",
        value: `raw-${kind}`,
      });
      move(seed, mutation, "APPLIED");
      seed.close();

      const reopened = start(path);
      await reopened.executor.ready;
      expect(reopened.calls).toEqual([`raw:raw-${kind}`]);
      expect(reopened.stock.reserved(B)).toBe(0n);
      expect(reopened.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
      await reopened.executor.stop();
      reopened.journal.close();
    });
  }
});

test("reopen completes journal-only terminal boundaries without repeating wallet mutation", async () => {
  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    const contribution = prepare(seed, 1, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION",
      value: "already-reverted",
    });
    move(seed, settlement, "AWAITING_RELAY");
    move(seed, contribution, "AWAITING_RELAY");
    const revert = prepare(seed, 1, "JOB_REVERT", "wallet", {
      kind: "FINALIZED_TRANSACTION",
      value: "already-reverted",
    });
    seed.transition(revert, "PREPARED", "REVERTING");
    seed.transition(revert, "REVERTING", "REVERTED");
    seed.close();

    const reopened = start(path);
    await reopened.executor.ready;
    expect(reopened.calls).toEqual([]);
    expect(reopened.stock.reserved(B)).toBe(0n);
    expect(reopened.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
    await reopened.executor.stop();
    reopened.journal.close();
  });

  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    const contribution = prepare(seed, 1, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION",
      value: "already-settled",
    });
    move(seed, settlement, "RELAY_SUBMITTED");
    move(seed, contribution, "RELAY_SUBMITTED");
    seed.transition(settlement, "RELAY_SUBMITTED", "SETTLED");
    seed.close();

    const reopened = start(path);
    await reopened.executor.ready;
    expect(reopened.calls).toEqual([]);
    expect(reopened.journal.list().every((row) => row.lifecycleState === "SETTLED")).toBe(true);
    await reopened.executor.stop();
    reopened.journal.close();
  });
});

test("relay-ambiguous reopen states never trigger a local wallet mutation and remain unavailable", async () => {
  for (const state of ["AWAITING_RELAY", "RELAY_SUBMITTED", "CONFIRMING"] as const) {
    await withJournalPath(async (path) => {
      const seed = SolverOperationJournal.open({ path });
      const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
      const contribution = prepare(seed, 1, "FINALIZED_CONTRIBUTION", "wallet", {
        kind: "FINALIZED_TRANSACTION",
        value: `relay-${state}`,
      });
      move(seed, settlement, state);
      move(seed, contribution, state);
      seed.close();

      const reopened = start(path);
      await reopened.executor.ready;
      expect(reopened.calls).toEqual([]);
      expect(reopened.stock.reserved(B)).toBe(5n);
      expect(reopened.executor.unavailableOfferHashes()).toEqual([H]);
      expect(reopened.journal.list().every((row) => row.lifecycleState === "QUARANTINED")).toBe(true);
      await reopened.executor.stop();
      reopened.journal.close();
    });
  }
});

test("relay HTTP and durable receipts settle every restart boundary exactly once", async () => {
  const stages = [
    { name: "http-done-before-receipt", state: "AWAITING_RELAY" as const, receipt: false, ledger: false },
    { name: "done-receipt-before-transition", state: "AWAITING_RELAY" as const, receipt: true, ledger: false },
    { name: "after-relay-transition", state: "RELAY_SUBMITTED" as const, receipt: true, ledger: false },
    { name: "after-confirming-transition", state: "CONFIRMING" as const, receipt: true, ledger: false },
    { name: "ledger-receipt-before-settle", state: "CONFIRMING" as const, receipt: true, ledger: true },
  ];
  for (const stage of stages) {
    await withJournalPath(async (path) => {
      const seed = SolverOperationJournal.open({ path });
      const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
      const contribution = prepare(seed, 1, "FINALIZED_CONTRIBUTION", "wallet", {
        kind: "FINALIZED_TRANSACTION",
        value: `accepted-${stage.name}`,
      });
      move(seed, settlement, stage.state);
      move(seed, contribution, stage.state);
      if (stage.receipt) seed.recordReceipt(settlement, {
        relayJobId: "restart-job",
        relayState: "done",
        relayExtrinsicHash: RELAY_TX,
      });
      if (stage.ledger) seed.recordReceipt(settlement, {
        ledgerTxHash: LEDGER_TX,
        ledgerHeight: 99,
      });
      seed.close();

      const reopened = start(path, { relayStatus: "done", backendStatus: "consumed" });
      await reopened.executor.ready;
      expect(reopened.calls).toEqual([]);
      expect(reopened.stock.reserved(B)).toBe(0n);
      expect(reopened.journal.list().every((row) => row.lifecycleState === "SETTLED")).toBe(true);
      const receipt = reopened.journal.require(settlement).receipt;
      expect(receipt).toEqual({
        relayJobId: "restart-job",
        relayState: "done",
        relayExtrinsicHash: RELAY_TX,
        ledgerTxHash: LEDGER_TX,
        ledgerHeight: 99,
      });
      expect(receipt.relayExtrinsicHash).not.toBe(receipt.ledgerTxHash);
      await reopened.executor.stop();
      reopened.journal.close();

      const twice = start(path, { relayStatus: "error", backendStatus: "live" });
      await twice.executor.ready;
      expect(twice.calls).toEqual([]);
      expect(twice.stock.reserved(B)).toBe(0n);
      expect(twice.journal.list().every((row) => row.lifecycleState === "SETTLED")).toBe(true);
      await twice.executor.stop();
      twice.journal.close();
    });
  }
});

test("backend lag survives one restart and later settles from the durable relay receipt", async () => {
  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    const contribution = prepare(seed, 1, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION",
      value: "accepted-backend-lag",
    });
    move(seed, settlement, "RELAY_SUBMITTED");
    move(seed, contribution, "RELAY_SUBMITTED");
    seed.recordReceipt(settlement, {
      relayJobId: "restart-job",
      relayState: "done",
      relayExtrinsicHash: RELAY_TX,
    });
    seed.close();

    const lagged = start(path, { relayStatus: "error", backendStatus: "live" });
    await lagged.executor.ready;
    expect(lagged.calls).toEqual([]);
    expect(lagged.stock.reserved(B)).toBe(5n);
    expect(lagged.journal.list().every((row) => row.lifecycleState === "QUARANTINED")).toBe(true);
    await lagged.executor.stop();
    lagged.journal.close();

    const caughtUp = start(path, { relayStatus: "error", backendStatus: "consumed" });
    await caughtUp.executor.ready;
    expect(caughtUp.calls).toEqual([]);
    expect(caughtUp.stock.reserved(B)).toBe(0n);
    expect(caughtUp.journal.list().every((row) => row.lifecycleState === "SETTLED")).toBe(true);
    await caughtUp.executor.stop();
    caughtUp.journal.close();
  });
});

test("HTTP relay failure plus no ledger proof reverts once across double restart", async () => {
  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    const contribution = prepare(seed, 1, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION",
      value: "http-failed-wallet",
    });
    move(seed, settlement, "AWAITING_RELAY");
    move(seed, contribution, "AWAITING_RELAY");
    seed.close();

    const failed = start(path, { relayStatus: "error", backendStatus: "live" });
    await failed.executor.ready;
    expect(failed.calls).toEqual(["final:http-failed-wallet"]);
    expect(failed.stock.reserved(B)).toBe(0n);
    expect(failed.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
    expect(failed.journal.require(settlement).receipt).toMatchObject({
      relayJobId: "restart-job",
      relayState: "error",
    });
    await failed.executor.stop();
    failed.journal.close();

    const twice = start(path, { relayStatus: "done", backendStatus: "consumed" });
    await twice.executor.ready;
    expect(twice.calls).toEqual([]);
    expect(twice.stock.reserved(B)).toBe(0n);
    expect(twice.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
    await twice.executor.stop();
    twice.journal.close();
  });
});

test("artifact-less PREPARED crash window is quarantined without releasing its durable claim", async () => {
  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    prepare(seed, 1, "RESIDUAL_BUILD", "wallet-call-without-result");
    seed.close();

    const reopened = start(path);
    await reopened.executor.ready;
    expect(reopened.calls).toEqual([]);
    expect(reopened.stock.reserved(B)).toBe(5n);
    expect(reopened.executor.unavailableOfferHashes()).toEqual([H]);
    expect(reopened.journal.list().every((row) => row.lifecycleState === "QUARANTINED")).toBe(true);
    await reopened.executor.stop();
    reopened.journal.close();
  });
});

test("latest generation owns reconciliation and an older terminal generation is never rewritten", async () => {
  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    const old = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    seed.transition(old, "PREPARED", "REVERTED");
    prepare(seed, 2, "JOB_SETTLEMENT", "settlement");
    prepare(seed, 2, "RESIDUAL_BUILD", "late-owned-call");
    seed.close();

    const reopened = start(path);
    await reopened.executor.ready;
    expect(reopened.journal.require(old).lifecycleState).toBe("REVERTED");
    expect(reopened.journal.list().filter((row) => row.generation === 2)
      .every((row) => row.lifecycleState === "QUARANTINED")).toBe(true);
    expect(reopened.stock.reserved(B)).toBe(5n);
    await reopened.executor.stop();
    reopened.journal.close();
  });
});

test("corrupt durable row rejects reconciliation before work can be accepted", async () => {
  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    seed.close();
    const db = new Database(path, { strict: true });
    db.query("UPDATE journal_operations SET offer_hashes_json = ?").run("not-json");
    db.close(false);

    const reopened = start(path);
    await expect(reopened.executor.ready).rejects.toThrow();
    expect(reopened.calls).toEqual([]);
    await reopened.executor.stop();
    reopened.journal.close();
  });
});

test("signal during a blocked reconciliation prevents readiness without losing terminal evidence", async () => {
  await withJournalPath(async (path) => {
    const seed = SolverOperationJournal.open({ path });
    const settlement = prepare(seed, 1, "JOB_SETTLEMENT", "settlement");
    move(seed, settlement, "APPLIED");
    const contribution = prepare(seed, 1, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION",
      value: "blocked-revert",
    });
    move(seed, contribution, "APPLIED");
    seed.close();

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const reopened = start(path, { signal: controller.signal, blockRevert: barrier });
    await Promise.resolve();
    controller.abort(new Error("startup cancelled"));
    release();
    await expect(reopened.executor.ready).rejects.toThrow("startup cancelled");
    expect(reopened.calls).toEqual(["final:blocked-revert"]);
    expect(reopened.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
    await reopened.executor.stop();
    reopened.journal.close();
  });
});
