import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JournalCapacityError,
  JournalCasConflictError,
  JournalOpenError,
  JournalTransitionError,
  SOLVER_JOURNAL_SCHEMA_VERSION,
  SolverOperationJournal,
  canonicalJson,
  parseCanonicalJson,
  type PreparedOperation,
} from "./src/operation-journal.ts";

const H1 = "11".repeat(32);
const H2 = "22".repeat(32);
const N1 = "31".repeat(32);
const N2 = "32".repeat(32);
const TOKEN_A = "aa".repeat(32);
const TOKEN_B = "bb".repeat(32);
const JOURNAL_CHILD = new URL("./operation-journal-child.ts", import.meta.url).pathname;

const prepared = (
  operationKey: string,
  overrides: Partial<PreparedOperation> = {},
): PreparedOperation => ({
  operationKey,
  jobId: "job-1",
  generation: 1,
  offerHashes: [H1, H2],
  claim: { inputs: [N1, N2], payouts: { [TOKEN_A]: "10", [TOKEN_B]: "20" } },
  operationKind: "MIRROR_RESERVATION",
  ttlExpiresAtMs: 2_000,
  deadlineAtMs: 1_500,
  walletArtifactKind: "UNPROVEN_TRANSACTION",
  walletArtifactBytes: new Uint8Array([1, 2, 3]),
  receipt: { relayJobId: "relay-job-1" },
  ...overrides,
});

async function withDirectory(
  body: (directory: string, path: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cow-rf1a-journal-"));
  try {
    await body(directory, join(directory, "operations.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("empty file migrates to current WAL schema and reopens with canonical bytes", async () => {
  await withDirectory(async (_directory, path) => {
    await writeFile(path, new Uint8Array());
    const journal = SolverOperationJournal.open({
      path,
      nowMs: () => 1_000,
      reconciliationMarginMs: 500,
    });
    expect(journal.journalMode).toBe("wal");
    const row = journal.createPrepared(prepared("op-reopen", {
      receipt: {
        relayJobId: "relay-job-1",
        relayState: "done",
        relayExtrinsicHash: "0xsubstrate",
        ledgerTxHash: "0xmidnight",
        ledgerHeight: 42,
      },
    }));
    expect(row.lifecycleState).toBe("PREPARED");
    expect(row.retentionUntilMs).toBe(2_500);
    expect(row.walletArtifactBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(row.receipt).toEqual({
      relayJobId: "relay-job-1",
      relayState: "done",
      relayExtrinsicHash: "0xsubstrate",
      ledgerTxHash: "0xmidnight",
      ledgerHeight: 42,
    });
    journal.close();

    const raw = new Database(path, { readonly: true, strict: true });
    expect((raw.query("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(SOLVER_JOURNAL_SCHEMA_VERSION);
    expect((raw.query("PRAGMA foreign_key_check").all())).toEqual([]);
    raw.close();

    const child = Bun.spawn([process.execPath, JOURNAL_CHILD, path, "op-reopen"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      beforeState: "PREPARED",
      afterState: "APPLIED",
      artifactHex: "010203",
      receipt: row.receipt,
    });

    const reopened = SolverOperationJournal.open({
      path,
      nowMs: () => 1_100,
      reconciliationMarginMs: 500,
    });
    expect(reopened.require("op-reopen")).toMatchObject({
      ...row,
      lifecycleState: "APPLIED",
      updatedAtMs: expect.any(Number),
    });
    reopened.close();
  });
});

test("DUST reservations are atomic, durable, rolling-window bounded, and terminally accounted", async () => {
  await withDirectory((_directory, path) => {
    let now = 1_000;
    const open = () => SolverOperationJournal.open({ path, nowMs: () => now });
    let journal = open();
    journal.createPrepared(prepared("job-1-settlement", {
      operationKind: "JOB_SETTLEMENT", walletArtifactKind: undefined,
      walletArtifactBytes: undefined,
    }));
    const first = journal.reserveDust({
      operationKey: "job-1-settlement", jobId: "job-1", generation: 1,
      amount: 6n, maxPerJob: 7n, maxPerWindow: 10n, windowMs: 100,
    });
    expect(first).toMatchObject({ accepted: true, usage: 6n });
    expect(journal.reserveDust({
      operationKey: "job-1-settlement", jobId: "job-1", generation: 1,
      amount: 6n, maxPerJob: 7n, maxPerWindow: 10n, windowMs: 100,
    })).toMatchObject({ accepted: true, usage: 6n });
    journal.close();

    // Reopen proves the reservation, not process memory, owns the budget.
    journal = open();
    journal.createPrepared(prepared("job-2-settlement", {
      jobId: "job-2", generation: 1, operationKind: "JOB_SETTLEMENT",
      walletArtifactKind: undefined, walletArtifactBytes: undefined,
    }));
    expect(journal.reserveDust({
      operationKey: "job-2-settlement", jobId: "job-2", generation: 1,
      amount: 5n, maxPerJob: 7n, maxPerWindow: 10n, windowMs: 100,
    })).toEqual({ accepted: false, reason: "window", usage: 6n });
    expect(journal.reserveDust({
      operationKey: "job-2-settlement", jobId: "job-2", generation: 1,
      amount: 8n, maxPerJob: 7n, maxPerWindow: 10n, windowMs: 100,
    })).toEqual({ accepted: false, reason: "per-job", usage: 6n });

    now = 1_200;
    // An unresolved reservation never ages out and remains fail-closed.
    expect(journal.dustUsage(100)).toBe(6n);
    expect(journal.markDustSpent("job-1-settlement")).toMatchObject({ state: "SPENT", amount: 6n });
    now = 1_301;
    expect(journal.dustUsage(100)).toBe(0n);

    now = 1_302;
    expect(journal.reserveDust({
      operationKey: "job-2-settlement", jobId: "job-2", generation: 1,
      amount: 5n, maxPerJob: 7n, maxPerWindow: 10n, windowMs: 100,
    })).toMatchObject({ accepted: true, usage: 5n });
    expect(journal.releaseDust("job-2-settlement")).toMatchObject({ state: "RELEASED" });
    expect(journal.dustUsage(100)).toBe(0n);
    expect(() => journal.reserveDust({
      operationKey: "job-2-settlement", jobId: "job-2", generation: 1,
      amount: 5n, maxPerJob: 7n, maxPerWindow: 10n, windowMs: 100,
    })).toThrow(JournalCasConflictError);
    journal.close();
  });
});

test("existing RF1 schema v1 migrates in place to durable DUST schema v2", async () => {
  await withDirectory((_directory, path) => {
    const initialized = SolverOperationJournal.open({ path, nowMs: () => 1_000 });
    initialized.close();
    const legacy = new Database(path, { strict: true });
    legacy.exec(`
      DROP TABLE journal_dust_reservations;
      UPDATE journal_meta SET schema_version = 1 WHERE singleton = 1;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = SolverOperationJournal.open({ path, nowMs: () => 1_100 });
    migrated.createPrepared(prepared("migrated-settlement", {
      operationKind: "JOB_SETTLEMENT", walletArtifactKind: undefined,
      walletArtifactBytes: undefined,
    }));
    expect(migrated.reserveDust({
      operationKey: "migrated-settlement", jobId: "job-1", generation: 1,
      amount: 1n, maxPerJob: 1n, maxPerWindow: 1n, windowMs: 100,
    })).toMatchObject({ accepted: true, usage: 1n });
    migrated.close();
    const raw = new Database(path, { readonly: true, strict: true });
    expect((raw.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    raw.close();
  });
});

test("terminal pruning cannot erase active DUST accounting before its own safe prune", async () => {
  await withDirectory((_directory, path) => {
    let now = 1_000;
    const journal = SolverOperationJournal.open({
      path, nowMs: () => now, reconciliationMarginMs: 1,
    });
    journal.createPrepared(prepared("dust-prune-parent", {
      operationKind: "JOB_SETTLEMENT", walletArtifactKind: undefined,
      walletArtifactBytes: undefined,
    }));
    expect(journal.reserveDust({
      operationKey: "dust-prune-parent", jobId: "job-1", generation: 1,
      amount: 1n, maxPerJob: 1n, maxPerWindow: 1n, windowMs: 100,
    })).toMatchObject({ accepted: true });
    journal.releaseDust("dust-prune-parent");
    journal.transition("dust-prune-parent", "PREPARED", "FAILED");
    now = 3_000;
    expect(journal.pruneTerminal(now)).toBe(0);
    expect(journal.pruneDust(100, now)).toBe(1);
    expect(journal.pruneTerminal(now)).toBe(1);
    journal.close();
  });
});

test("canonical JSON sorts object keys and rejects lossy values or noncanonical rows", () => {
  expect(canonicalJson({ z: [2, 1], a: { y: "2", x: "1" } }))
    .toBe('{"a":{"x":"1","y":"2"},"z":[2,1]}');
  expect(parseCanonicalJson<{ a: number; b: number }>('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
  expect(() => parseCanonicalJson('{"b":2,"a":1}')).toThrow(/non-canonical/);
  expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
  expect(() => canonicalJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integers/);
});

test("compare-and-set transitions are monotonic and duplicate terminals are idempotent", async () => {
  await withDirectory((_directory, path) => {
    const journal = SolverOperationJournal.open({ path, nowMs: () => 1_000 });
    journal.createPrepared(prepared("op-cas"));
    expect(() => journal.transition("op-cas", "APPLIED", "AWAITING_RELAY"))
      .toThrow(JournalCasConflictError);
    expect(() => journal.transition("op-cas", "PREPARED", "SETTLED"))
      .toThrow(JournalTransitionError);
    expect(() => journal.transition("op-cas", "PREPARED", "APPLIED", {
      receipt: { relayJobId: "conflicting-relay-job" },
    })).toThrow(/conflicts with durable evidence/);
    expect(journal.require("op-cas").lifecycleState).toBe("PREPARED");

    expect(journal.recordReceipt("op-cas", { relayState: "done", relayExtrinsicHash: "relay-hash" })
      .receipt).toMatchObject({ relayState: "done", relayExtrinsicHash: "relay-hash" });
    expect(journal.recordReceipt("op-cas", { relayState: "done" }).lifecycleState).toBe("PREPARED");
    expect(() => journal.recordReceipt("op-cas", { relayState: "error", ledgerHeight: 7 }))
      .toThrow(/conflicts with durable evidence/);
    expect(journal.require("op-cas").receipt.ledgerHeight).toBeUndefined();

    journal.transition("op-cas", "PREPARED", "APPLIED");
    journal.transition("op-cas", "APPLIED", "AWAITING_RELAY");
    journal.transition("op-cas", "AWAITING_RELAY", "RELAY_SUBMITTED", {
      receipt: { relayState: "done", relayExtrinsicHash: "relay-hash" },
    });
    journal.transition("op-cas", "RELAY_SUBMITTED", "CONFIRMING");
    const settled = journal.transition("op-cas", "CONFIRMING", "SETTLED", {
      receipt: { ledgerTxHash: "ledger-hash", ledgerHeight: 9 },
    });
    expect(journal.transition("op-cas", "CONFIRMING", "SETTLED", {
      receipt: { ledgerTxHash: "ledger-hash", ledgerHeight: 9 },
    })).toEqual(settled);
    expect(() => journal.transition("op-cas", "SETTLED", "SETTLED", {
      receipt: { ledgerTxHash: "different" },
    })).toThrow(/conflicts/);
    expect(() => journal.transition("op-cas", "SETTLED", "REVERTED"))
      .toThrow(JournalTransitionError);
    journal.close();
  });
});

test("PREPARED commits before the mutation callback; negative control refuses reversed ordering", async () => {
  await withDirectory(async (_directory, path) => {
    const journal = SolverOperationJournal.open({ path, nowMs: () => 1_000 });
    let mutations = 0;
    const guardedMutation = async (operationKey: string): Promise<string> => {
      const durable = journal.get(operationKey);
      if (durable?.lifecycleState !== "PREPARED") {
        throw new Error("mutation attempted before durable PREPARED");
      }
      mutations += 1;
      return "mutated";
    };

    // Negative control: prove the guard fails if mutation ordering is reversed.
    await expect(guardedMutation("op-negative-control")).rejects.toThrow(
      /before durable PREPARED/,
    );
    expect(mutations).toBe(0);

    expect(await journal.runPreparedOperation(
      prepared("op-write-ahead"),
      () => guardedMutation("op-write-ahead"),
    )).toBe("mutated");
    expect(mutations).toBe(1);
    journal.close();
  });
});

test("row ceiling failure rolls the whole insert transaction back", async () => {
  await withDirectory((_directory, path) => {
    const journal = SolverOperationJournal.open({ path, nowMs: () => 1_000, maxRows: 1 });
    journal.createPrepared(prepared("op-first"));
    expect(() => journal.createPrepared(prepared("op-overflow", { jobId: "job-2" })))
      .toThrow(JournalCapacityError);
    expect(journal.list().map((row) => row.operationKey)).toEqual(["op-first"]);
    journal.close();
  });
});

test("SQLite page ceiling turns disk-full into a transactional capacity refusal", async () => {
  await withDirectory((_directory, path) => {
    const journal = SolverOperationJournal.open({
      path,
      nowMs: () => 1_000,
      maxBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024,
    });
    let admitted = 0;
    for (let index = 0; index < 100; index += 1) {
      try {
        journal.createPrepared(prepared(`op-byte-${index}`, {
          jobId: `job-byte-${index}`,
          walletArtifactBytes: new Uint8Array(12 * 1024).fill(index % 251),
        }));
        admitted += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(JournalCapacityError);
        break;
      }
    }
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThan(100);
    expect(journal.list()).toHaveLength(admitted);
    journal.close();
  });
});

test("terminal retention honors TTL plus margin and never prunes quarantine", async () => {
  await withDirectory((_directory, path) => {
    const journal = SolverOperationJournal.open({
      path,
      nowMs: () => 1_000,
      reconciliationMarginMs: 500,
    });
    journal.createPrepared(prepared("op-terminal"));
    journal.transition("op-terminal", "PREPARED", "FAILED", {
      errorCode: "NO_MUTATION",
      errorDetail: "failed before wallet call",
    });
    journal.createPrepared(prepared("op-quarantine", { jobId: "job-2" }));
    journal.transition("op-quarantine", "PREPARED", "QUARANTINED");

    expect(journal.pruneTerminal(2_499)).toBe(0);
    expect(journal.pruneTerminal(2_500)).toBe(1);
    expect(journal.list().map((row) => [row.operationKey, row.lifecycleState]))
      .toEqual([["op-quarantine", "QUARANTINED"]]);
    journal.close();
  });
});

test("artifact and canonical identity ceilings fail before durable admission", async () => {
  await withDirectory((_directory, path) => {
    const journal = SolverOperationJournal.open({
      path,
      nowMs: () => 1_000,
      maxArtifactBytes: 2,
    });
    expect(() => journal.createPrepared(prepared("op-large")))
      .toThrow(JournalCapacityError);
    expect(() => journal.createPrepared(prepared("op-unsorted", {
      offerHashes: [H2, H1],
      walletArtifactBytes: new Uint8Array([1]),
    }))).toThrow(/lexicographically sorted/);
    expect(() => journal.createPrepared(prepared("op-bad-payout", {
      claim: { inputs: [N1], payouts: { [TOKEN_A]: "01" } },
      walletArtifactBytes: new Uint8Array([1]),
    }))).toThrow(/canonical unsigned/);
    expect(journal.list()).toEqual([]);
    journal.close();
  });
});

test("corrupt, missing-parent, incompatible, and foreign-key-broken journals fail open", async () => {
  await withDirectory(async (directory, path) => {
    const corrupt = join(directory, "corrupt.sqlite");
    await writeFile(corrupt, new Uint8Array([1, 2, 3, 4, 5]));
    expect(() => SolverOperationJournal.open({ path: corrupt })).toThrow(JournalOpenError);

    expect(() => SolverOperationJournal.open({
      path: join(directory, "missing", "operations.sqlite"),
    })).toThrow(JournalOpenError);

    const incompatible = join(directory, "incompatible.sqlite");
    const future = new Database(incompatible, { create: true, strict: true });
    future.exec("PRAGMA user_version = 2");
    future.close();
    expect(() => SolverOperationJournal.open({ path: incompatible })).toThrow(JournalOpenError);

    const broken = join(directory, "broken-fk.sqlite");
    const initialized = SolverOperationJournal.open({ path: broken });
    initialized.createPrepared(prepared("op-fk"));
    initialized.close();
    const raw = new Database(broken, { strict: true });
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("DELETE FROM journal_operations");
    // The receipt row now points to a deleted operation.
    raw.close();
    expect(() => SolverOperationJournal.open({ path: broken })).toThrow(JournalOpenError);

    const badDust = join(directory, "bad-dust.sqlite");
    const dustJournal = SolverOperationJournal.open({ path: badDust, nowMs: () => 1_000 });
    dustJournal.createPrepared(prepared("bad-dust-parent", {
      operationKind: "JOB_SETTLEMENT", walletArtifactKind: undefined,
      walletArtifactBytes: undefined,
    }));
    dustJournal.reserveDust({
      operationKey: "bad-dust-parent", jobId: "job-1", generation: 1,
      amount: 1n, maxPerJob: 1n, maxPerWindow: 1n, windowMs: 100,
    });
    dustJournal.close();
    const dustRaw = new Database(badDust, { strict: true });
    dustRaw.exec("UPDATE journal_dust_reservations SET amount_text = '01'");
    dustRaw.close();
    expect(() => SolverOperationJournal.open({ path: badDust })).toThrow(JournalOpenError);
  });
});

test("an active SQLite writer lock refuses work without losing prior rows", async () => {
  await withDirectory((_directory, path) => {
    const journal = SolverOperationJournal.open({ path, nowMs: () => 1_000 });
    journal.createPrepared(prepared("op-before-lock"));
    const blocker = new Database(path, { strict: true });
    blocker.exec("PRAGMA busy_timeout = 0");
    blocker.exec("BEGIN IMMEDIATE");
    expect(() => journal.createPrepared(prepared("op-locked", { jobId: "job-locked" })))
      .toThrow(/locked|busy/i);
    blocker.exec("ROLLBACK");
    blocker.close();
    expect(journal.list().map((row) => row.operationKey)).toEqual(["op-before-lock"]);
    journal.close();
  });
});

test("memory mode is explicit, warns safely, and remains schema-identical", () => {
  const warnings: string[] = [];
  expect(() => SolverOperationJournal.open({ path: ":memory:" })).toThrow(JournalOpenError);
  const journal = SolverOperationJournal.open({
    path: ":memory:",
    allowMemory: true,
    nowMs: () => 1_000,
    warn: (message) => warnings.push(message),
  });
  expect(journal.journalMode).toBe("memory");
  expect(warnings).toEqual([expect.stringContaining("crash durability is disabled")]);
  journal.createPrepared(prepared("op-memory"));
  expect(journal.require("op-memory").lifecycleState).toBe("PREPARED");
  journal.close();

  const throwingWarningJournal = SolverOperationJournal.open({
    path: ":memory:",
    allowMemory: true,
    warn: () => { throw new Error("logger failure"); },
  });
  throwingWarningJournal.close();
});
