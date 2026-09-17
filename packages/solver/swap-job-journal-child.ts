import {
  SolverOperationJournal,
  type JournalLifecycleState,
  type JournalOperationKind,
} from "./src/operation-journal.ts";

const path = process.argv[2];
const state = process.argv[3] as JournalLifecycleState | "ARTIFACTLESS";
if (!path || !state) throw new Error("expected journal path and fixture state");

const B = "bb".repeat(32);
const H = "11".repeat(32);
const N = "31".repeat(32);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const journal = SolverOperationJournal.open({ path });
const ttl = Date.now() + 60_000;

const prepare = (
  kind: JournalOperationKind,
  label: string,
  artifact?: { kind: "FINALIZED_TRANSACTION" | "UNPROVEN_TRANSACTION"; value: string },
): string => {
  const key = `job:restart-job:g1:${kind}:${label}`;
  journal.createPrepared({
    operationKey: key,
    jobId: "restart-job",
    generation: 1,
    offerHashes: [H],
    claim: { inputs: [N], payouts: { [B]: "5" } },
    operationKind: kind,
    ttlExpiresAtMs: ttl,
    deadlineAtMs: ttl - 1,
    ...(artifact
      ? { walletArtifactKind: artifact.kind, walletArtifactBytes: encode(artifact.value) }
      : {}),
  });
  return key;
};

const move = (key: string, target: JournalLifecycleState): void => {
  let current = journal.require(key).lifecycleState;
  const step = (next: JournalLifecycleState): void => {
    journal.transition(key, current, next, next === "QUARANTINED"
      ? { errorCode: "LOCAL_REVERT_FAILED", errorDetail: "child-process fixture" }
      : {});
    current = next;
  };
  if (target === "PREPARED") return;
  if (target === "APPLIED") return step("APPLIED");
  if (target === "AWAITING_RELAY") { step("APPLIED"); return step("AWAITING_RELAY"); }
  if (target === "RELAY_SUBMITTED") {
    step("APPLIED"); step("AWAITING_RELAY"); return step("RELAY_SUBMITTED");
  }
  if (target === "CONFIRMING") { step("APPLIED"); return step("CONFIRMING"); }
  if (target === "REVERTING") return step("REVERTING");
  if (target === "QUARANTINED") return step("QUARANTINED");
  throw new Error(`unsupported direct fixture target ${target}`);
};

const settlement = prepare("JOB_SETTLEMENT", "settlement");
if (state === "ARTIFACTLESS") {
  prepare("RESIDUAL_BUILD", "wallet-call-without-result");
} else if (state === "APPLIED" || state === "AWAITING_RELAY" ||
  state === "RELAY_SUBMITTED" || state === "CONFIRMING") {
  const contribution = prepare("FINALIZED_CONTRIBUTION", "wallet", {
    kind: "FINALIZED_TRANSACTION",
    value: `child-${state}`,
  });
  move(settlement, state);
  move(contribution, state);
} else if (state === "REVERTING" || state === "QUARANTINED") {
  const revert = prepare("JOB_REVERT", "wallet", {
    kind: "FINALIZED_TRANSACTION",
    value: `child-${state}`,
  });
  if (state === "QUARANTINED") move(settlement, state);
  move(revert, state);
} else if (state === "REVERTED") {
  const contribution = prepare("FINALIZED_CONTRIBUTION", "wallet", {
    kind: "FINALIZED_TRANSACTION",
    value: "child-REVERTED",
  });
  move(settlement, "AWAITING_RELAY");
  move(contribution, "AWAITING_RELAY");
  const revert = prepare("JOB_REVERT", "wallet", {
    kind: "FINALIZED_TRANSACTION",
    value: "child-REVERTED",
  });
  journal.transition(revert, "PREPARED", "REVERTING");
  journal.transition(revert, "REVERTING", "REVERTED");
} else if (state === "SETTLED") {
  const contribution = prepare("FINALIZED_CONTRIBUTION", "wallet", {
    kind: "FINALIZED_TRANSACTION",
    value: "child-SETTLED",
  });
  move(settlement, "RELAY_SUBMITTED");
  move(contribution, "RELAY_SUBMITTED");
  journal.transition(settlement, "RELAY_SUBMITTED", "SETTLED");
} else {
  throw new Error(`unsupported fixture state ${state}`);
}

// Deliberately skip journal.close(): this is the injected process-kill edge.
process.exit(0);
