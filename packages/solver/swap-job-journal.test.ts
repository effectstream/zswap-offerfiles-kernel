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
  type SwapJobWallet,
} from "./src/swap-job-executor.ts";
import type { FinalizedTransaction } from "@midnightntwrk/ledger-v9";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const H = "11".repeat(32);
const N = "31".repeat(32);
const RELAY_TX = `0x${"cd".repeat(32)}`;
const LEDGER_TX = "ef".repeat(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JOURNAL_CHILD = new URL("./swap-job-journal-child.ts", import.meta.url).pathname;
const RECOVERY_CHILD = new URL("./swap-job-recovery-revert-child.ts", import.meta.url).pathname;

interface FakeTx {
  label: string;
  serialize: () => Uint8Array;
}

const tx = (label: string): FakeTx => ({
  label,
  serialize: () => encoder.encode(label),
});

const operationKeyFor = (
  jobId: string,
  generation: number,
  kind: JournalOperationKind,
  label: string,
): string => `job:${jobId}:g${generation}:${kind}:${label}`;

const operationKey = (generation: number, kind: JournalOperationKind, label: string): string =>
  operationKeyFor("restart-job", generation, kind, label);

const prepareFor = (
  journal: SolverOperationJournal,
  jobId: string,
  generation: number,
  kind: JournalOperationKind,
  label: string,
  artifact?: { kind: "FINALIZED_TRANSACTION" | "UNPROVEN_TRANSACTION"; value: string },
): string => {
  const key = operationKeyFor(jobId, generation, kind, label);
  journal.createPrepared({
    operationKey: key,
    jobId,
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

const prepare = (
  journal: SolverOperationJournal,
  generation: number,
  kind: JournalOperationKind,
  label: string,
  artifact?: { kind: "FINALIZED_TRANSACTION" | "UNPROVEN_TRANSACTION"; value: string },
): string => {
  return prepareFor(journal, "restart-job", generation, kind, label, artifact);
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
  // Typed as the executor's own wallet boundary: the doubles must satisfy the
  // real signatures (opaque `unknown` transactions in, a finalized transaction
  // out), so a change to that interface fails here instead of at runtime.
  const wallet: SwapJobWallet = {
    shielded: { getAddress: async () => "address" },
    dust: { balanceTransactions: async () => tx("dust") },
    initSwap: async () => ({ transaction: tx("raw") }),
    finalizeTransaction: async () => tx("final") as unknown as FinalizedTransaction,
    revertTransaction: async (value) => {
      calls.push(`raw:${(value as FakeTx).label}`);
      await options.blockRevert;
    },
    revert: async (value) => {
      calls.push(`final:${(value as FakeTx).label}`);
      await options.blockRevert;
    },
  };
  const executor = startSwapJobExecutor({
    cache: { book, isCurrent: () => true },
    stock,
    wallet,
    journal,
    keys: { dustSecretKey: "dust" },
    networkId: "undeployed",
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

interface RecoveryChildResult {
  calls: string[];
  counter: number;
  states: Array<{
    operationKey: string;
    generation: number;
    state: JournalLifecycleState;
    errorCode: string | null;
  }>;
  reserved: string;
  unavailable: string[];
  safetyLogs: string[];
}

const runRecoveryChild = async (
  path: string,
  counterPath: string,
  mode: "clean" | "crash" | "fail",
): Promise<{ exitCode: number; stdout: string; stderr: string; result?: RecoveryChildResult }> => {
  const child = Bun.spawn([process.execPath, RECOVERY_CHILD, path, counterPath, mode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    ...(exitCode === 0 ? { result: JSON.parse(stdout) as RecoveryChildResult } : {}),
  };
};

const seedLocalRecovery = (
  path: string,
  artifact: "finalized" | "unproven",
  options: { generation?: number; jobId?: string } = {},
): void => {
  const journal = SolverOperationJournal.open({ path });
  const generation = options.generation ?? 1;
  const jobId = options.jobId ?? "restart-job";
  const settlement = prepareFor(journal, jobId, generation, "JOB_SETTLEMENT", "settlement");
  move(journal, settlement, "APPLIED");
  const source = artifact === "finalized"
    ? prepareFor(journal, jobId, generation, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION", value: `recovery-${artifact}-g${generation}`,
    })
    : prepareFor(journal, jobId, generation, "MIRROR_RESERVATION", "wallet", {
      kind: "UNPROVEN_TRANSACTION", value: `recovery-${artifact}-g${generation}`,
    });
  move(journal, source, "APPLIED");
  journal.close();
};

test("recovered wallet call crash is invoked once and remains fail-closed across two fresh reopens", async () => {
  for (const artifact of ["finalized", "unproven"] as const) {
    await withJournalPath(async (path) => {
      const counterPath = `${path}.${artifact}.counter.sqlite`;
      seedLocalRecovery(path, artifact);

      const crashed = await runRecoveryChild(path, counterPath, "crash");
      expect(crashed).toMatchObject({ exitCode: 86, stdout: "", stderr: "" });

      const afterCrash = SolverOperationJournal.open({ path });
      const recovery = afterCrash.list().find((row) =>
        row.operationKey.startsWith(`job:restart-job:g1:JOB_REVERT:recovery-${artifact}-`));
      expect(recovery?.lifecycleState).toBe("REVERTING");
      afterCrash.close();

      const first = await runRecoveryChild(path, counterPath, "clean");
      expect(first).toMatchObject({ exitCode: 0, stderr: "" });
      expect(first.result).toMatchObject({
        calls: [], counter: 1, reserved: "5", unavailable: [H],
      });
      expect(first.result!.states.every((row) => row.state === "QUARANTINED")).toBe(true);
      expect(first.result!.states.some((row) => row.errorCode === "RECOVERY_REVERT_OUTCOME_UNKNOWN")).toBe(true);
      expect(first.result!.safetyLogs.some((line) =>
        line.includes("wallet mutation will not be repeated") && line.includes("remain unavailable"))).toBe(true);

      const second = await runRecoveryChild(path, counterPath, "clean");
      expect(second).toMatchObject({ exitCode: 0, stderr: "" });
      expect(second.result).toMatchObject({
        calls: [], counter: 1, reserved: "5", unavailable: [H],
      });
      expect(second.result!.states.every((row) => row.state === "QUARANTINED")).toBe(true);
      expect(second.result!.safetyLogs.length).toBeGreaterThan(0);
    });
  }
});

test("clean recovered revert releases only after terminal proof and is not repeated", async () => {
  for (const artifact of ["finalized", "unproven"] as const) {
    await withJournalPath(async (path) => {
      const counterPath = `${path}.${artifact}.clean-counter.sqlite`;
      seedLocalRecovery(path, artifact);

      const first = await runRecoveryChild(path, counterPath, "clean");
      expect(first).toMatchObject({ exitCode: 0, stderr: "" });
      expect(first.result).toMatchObject({
        calls: [`${artifact}:recovery-${artifact}-g1`],
        counter: 1,
        reserved: "0",
        unavailable: [],
      });
      expect(first.result!.states.every((row) => row.state === "REVERTED")).toBe(true);
      expect(first.result!.states.some((row) =>
        row.operationKey.startsWith(`job:restart-job:g1:JOB_REVERT:recovery-${artifact}-`) &&
        row.state === "REVERTED")).toBe(true);

      const second = await runRecoveryChild(path, counterPath, "clean");
      expect(second.result).toMatchObject({ calls: [], counter: 1, reserved: "0", unavailable: [] });
      expect(second.result!.states.every((row) => row.state === "REVERTED")).toBe(true);
    });
  }
});

test("failed recovered revert is not retried and retains durable authority", async () => {
  for (const artifact of ["finalized", "unproven"] as const) {
    await withJournalPath(async (path) => {
      const counterPath = `${path}.${artifact}.failed-counter.sqlite`;
      seedLocalRecovery(path, artifact);

      const failed = await runRecoveryChild(path, counterPath, "fail");
      expect(failed).toMatchObject({ exitCode: 0, stderr: "" });
      expect(failed.result).toMatchObject({
        calls: [`${artifact}:recovery-${artifact}-g1`],
        counter: 1,
        reserved: "5",
        unavailable: [H],
      });
      expect(failed.result!.states.every((row) => row.state === "QUARANTINED")).toBe(true);
      expect(failed.result!.safetyLogs.length).toBeGreaterThan(0);

      const reopened = await runRecoveryChild(path, counterPath, "clean");
      expect(reopened.result).toMatchObject({
        calls: [], counter: 1, reserved: "5", unavailable: [H],
      });
      expect(reopened.result!.states.every((row) => row.state === "QUARANTINED")).toBe(true);
    });
  }
});

test("recovery authority is generation-owned and odd job ids cannot spoof its discriminator", async () => {
  await withJournalPath(async (path) => {
    const journal = SolverOperationJournal.open({ path });
    const stale = prepareFor(journal, "restart-job", 1, "JOB_SETTLEMENT", "settlement");
    journal.transition(stale, "PREPARED", "REVERTED");
    journal.close();
    seedLocalRecovery(path, "finalized", { generation: 2 });

    const result = await runRecoveryChild(path, `${path}.generation-counter.sqlite`, "clean");
    expect(result.result).toMatchObject({ counter: 1, reserved: "0", unavailable: [] });
    expect(result.result!.states.filter((row) => row.operationKey.includes(":JOB_REVERT:recovery-")))
      .toEqual([expect.objectContaining({ generation: 2, state: "REVERTED" })]);
    expect(result.result!.states.find((row) => row.operationKey === stale)?.state).toBe("REVERTED");
  });

  await withJournalPath(async (path) => {
    const journal = SolverOperationJournal.open({ path });
    const settlement = prepare(journal, 1, "JOB_SETTLEMENT", "settlement");
    const unproven = prepare(journal, 1, "MIRROR_RESERVATION", "wallet", {
      kind: "UNPROVEN_TRANSACTION", value: "same-generation-unproven",
    });
    const finalized = prepare(journal, 1, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION", value: "same-generation-finalized",
    });
    move(journal, settlement, "APPLIED");
    move(journal, unproven, "APPLIED");
    move(journal, finalized, "APPLIED");
    journal.close();

    const result = await runRecoveryChild(path, `${path}.artifact-counter.sqlite`, "clean");
    expect(result.result).toMatchObject({
      calls: ["unproven:same-generation-unproven", "finalized:same-generation-finalized"],
      counter: 2,
      reserved: "0",
      unavailable: [],
    });
    const recoveryKeys = result.result!.states
      .filter((row) => row.operationKey.includes(":JOB_REVERT:recovery-"))
      .map((row) => row.operationKey);
    expect(new Set(recoveryKeys).size).toBe(2);
    expect(recoveryKeys.some((key) => key.includes(":recovery-unproven-"))).toBe(true);
    expect(recoveryKeys.some((key) => key.includes(":recovery-finalized-"))).toBe(true);
  });

  await withJournalPath(async (path) => {
    const oddJobId = "odd:JOB_REVERT:recovery-marker";
    const journal = SolverOperationJournal.open({ path });
    const settlement = prepareFor(journal, oddJobId, 1, "JOB_SETTLEMENT", "settlement");
    const contribution = prepareFor(journal, oddJobId, 1, "FINALIZED_CONTRIBUTION", "wallet", {
      kind: "FINALIZED_TRANSACTION", value: "odd-primary-proof",
    });
    move(journal, settlement, "AWAITING_RELAY");
    move(journal, contribution, "AWAITING_RELAY");
    const primary = prepareFor(journal, oddJobId, 1, "JOB_REVERT", "wallet", {
      kind: "FINALIZED_TRANSACTION", value: "odd-primary-proof",
    });
    journal.transition(primary, "PREPARED", "REVERTING");
    journal.transition(primary, "REVERTING", "REVERTED");
    journal.close();

    const result = await runRecoveryChild(path, `${path}.odd-counter.sqlite`, "clean");
    expect(result.result).toMatchObject({ calls: [], counter: 0, reserved: "0", unavailable: [] });
    expect(result.result!.states.every((row) => row.state === "REVERTED")).toBe(true);
    expect(result.result!.states.some((row) =>
      row.operationKey.includes(":JOB_REVERT:recovery-finalized-"))).toBe(false);
  });
});

test("reopen retries APPLIED artifacts but never replays an already-started primary revert", async () => {
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
      if (state === "APPLIED") {
        expect(first.calls).toEqual([`final:artifact-${state}`]);
        expect(first.stock.reserved(B)).toBe(0n);
        expect(first.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
      } else {
        expect(first.calls).toEqual([]);
        expect(first.stock.reserved(B)).toBe(5n);
        expect(first.executor.unavailableOfferHashes()).toEqual([H]);
        expect(first.journal.list().every((row) => row.lifecycleState === "QUARANTINED")).toBe(true);
      }
      await first.executor.stop();
      first.journal.close();

      const second = start(path);
      await second.executor.ready;
      expect(second.calls).toEqual([]);
      if (state === "APPLIED") {
        expect(await second.executor.onSwap({
          type: "swap", jobId: "restart-job", tokenIn: A, tokenOut: B,
          amountIn: "10", amountOut: "20",
        })).toEqual({ type: "job-error", jobId: "restart-job", reason: JOB_DUPLICATE });
      } else {
        expect(second.stock.reserved(B)).toBe(5n);
        expect(second.executor.unavailableOfferHashes()).toEqual([H]);
      }
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
      if (state === "APPLIED") {
        expect(reopened.calls).toEqual([`final:child-${state}`]);
        expect(reopened.journal.list().every((row) => row.lifecycleState === "REVERTED")).toBe(true);
        expect(reopened.stock.reserved(B)).toBe(0n);
      } else if (state === "REVERTING" || state === "QUARANTINED") {
        expect(reopened.calls).toEqual([]);
        expect(reopened.journal.list().every((row) => row.lifecycleState === "QUARANTINED")).toBe(true);
        expect(reopened.stock.reserved(B)).toBe(5n);
        expect(reopened.executor.unavailableOfferHashes()).toEqual([H]);
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
