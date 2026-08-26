import { SolverOperationJournal } from "./src/operation-journal.ts";

const path = process.argv[2];
const operationKey = process.argv[3];
if (!path || !operationKey) throw new Error("expected journal path and operation key");

const journal = SolverOperationJournal.open({ path });
const before = journal.require(operationKey);
const after = journal.transition(operationKey, "PREPARED", "APPLIED");
journal.close();

console.log(JSON.stringify({
  beforeState: before.lifecycleState,
  afterState: after.lifecycleState,
  artifactHex: after.walletArtifactBytes?.toHex(),
  receipt: after.receipt,
}));
