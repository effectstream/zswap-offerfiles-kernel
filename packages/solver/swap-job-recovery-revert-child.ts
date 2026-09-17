import { Database } from "bun:sqlite";

import { Book } from "./src/book.ts";
import { SolverOperationJournal } from "./src/operation-journal.ts";
import { Stock } from "./src/stock.ts";
import { startSwapJobExecutor } from "./src/swap-job-executor.ts";

const journalPath = process.argv[2];
const counterPath = process.argv[3];
const mode = process.argv[4] as "clean" | "crash" | "fail" | undefined;
if (!journalPath || !counterPath || !mode || !["clean", "crash", "fail"].includes(mode)) {
  throw new Error("expected journal path, counter path, and clean|crash|fail mode");
}

const B = "bb".repeat(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeTx {
  label: string;
  serialize: () => Uint8Array;
}

const tx = (label: string): FakeTx => ({
  label,
  serialize: () => encoder.encode(label),
});

const openCounter = (): Database => {
  const counter = new Database(counterPath, { create: true, strict: true });
  counter.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  counter.exec(`
    CREATE TABLE IF NOT EXISTS mutation_counter (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      calls INTEGER NOT NULL CHECK (calls >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO mutation_counter (singleton, calls) VALUES (1, 0);
  `);
  return counter;
};

const mutate = (): number => {
  const counter = openCounter();
  counter.query("UPDATE mutation_counter SET calls = calls + 1 WHERE singleton = 1").run();
  const result = counter.query("SELECT calls FROM mutation_counter WHERE singleton = 1")
    .get() as { calls: number };
  counter.close(false);
  return result.calls;
};

const readCounter = (): number => {
  const counter = openCounter();
  const result = counter.query("SELECT calls FROM mutation_counter WHERE singleton = 1")
    .get() as { calls: number };
  counter.close(false);
  return result.calls;
};

const calls: string[] = [];
const logs: string[] = [];
const walletCall = async (kind: "finalized" | "unproven", value: FakeTx): Promise<void> => {
  calls.push(`${kind}:${value.label}`);
  mutate();
  if (mode === "fail") throw new Error(`injected ${kind} recovery failure`);
};

const journal = SolverOperationJournal.open({ path: journalPath });
const stock = new Stock();
stock.setBalances({ [B]: 100n });
const executor = startSwapJobExecutor({
  cache: { book: new Book(), isCurrent: () => true },
  stock,
  wallet: {
    shielded: { getAddress: async () => "address" },
    dust: { balanceTransactions: async () => tx("dust") },
    initSwap: async () => ({ transaction: tx("raw") }),
    finalizeTransaction: async () => tx("final") as any,
    revertTransaction: async (value) => walletCall("unproven", value as FakeTx),
    revert: async (value) => walletCall("finalized", value as unknown as FakeTx),
  },
  journal,
  keys: { dustSecretKey: "dust" },
  networkId: "undeployed",
  relayHttpUrl: "http://relay.test/api/v1",
  maxParallelSwaps: 2,
  expiryMarginSeconds: 120,
  settleTtlMinutes: 1,
  sweepIntervalMs: 60_000,
  dependencies: {
    readExactOfferFiles: async () => ({ schemaVersion: 1, profile: "native-shielded-v1", files: [] }),
    getOfferConsumptionEvidence: async (offerId) => ({ version: 1, offerId, status: "live" }),
    getRelayJobStatus: async () => ({ status: "pending" }),
    reconstructOffer: () => tx("maker") as any,
    deriveOfferSemantics: () => ({ gives: [], wants: [], nullifiers: [] }),
    mergeFinalized: ((values: FakeTx[]) => tx(values.map((value) => value.label).join("+"))) as any,
    tokenImbalances: (() => []) as any,
    serializeUnproven: (value: any) => value.serialize(),
    deserializeUnproven: (bytes) => tx(decoder.decode(bytes)),
    serializeFinalized: (value: any) => value.serialize(),
    deserializeFinalized: (bytes) => tx(decoder.decode(bytes)) as any,
  },
  ...(mode === "crash"
    ? { recoveryRevertTestHook: () => process.exit(86) }
    : {}),
  log: (message) => logs.push(message),
});

await executor.ready;
await executor.stop();
const rows = journal.list();
const result = {
  calls,
  counter: readCounter(),
  states: rows.map((row) => ({
    operationKey: row.operationKey,
    generation: row.generation,
    state: row.lifecycleState,
    errorCode: row.errorCode ?? null,
  })),
  reserved: stock.reserved(B).toString(),
  unavailable: executor.unavailableOfferHashes(),
  safetyLogs: logs.filter((message) => message.includes("[SAFETY]")),
};
journal.close();
process.stdout.write(JSON.stringify(result));
