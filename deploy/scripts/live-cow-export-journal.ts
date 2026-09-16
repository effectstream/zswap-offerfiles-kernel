import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";

const journalFile = (process.env.JOURNAL_FILE ?? "").trim();
const outFile = (process.env.OUT_FILE ?? "").trim();
const backupFile = (process.env.JOURNAL_BACKUP_FILE ?? "").trim();
if (!journalFile || !outFile || !backupFile) {
  throw new Error("JOURNAL_FILE, JOURNAL_BACKUP_FILE and OUT_FILE are required");
}
if (process.env.COW_SOLVER_STOPPED_ASSERTED !== "true") {
  throw new Error("refusing final journal export until COW_SOLVER_STOPPED_ASSERTED=true");
}

const source = new Database(journalFile, { readonly: true });
try {
  source.exec("BEGIN");
  const quickCheck = source.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {})[0] !== "ok") {
    throw new Error(`source journal quick_check failed: ${JSON.stringify(quickCheck)}`);
  }
  // sqlite3_serialize captures one transactionally coherent view, including
  // any WAL pages visible to this read transaction. The outer harness stops
  // the solver first, so this is also the authoritative final artifact.
  writeFileSync(backupFile, source.serialize());
} finally {
  try { source.exec("ROLLBACK"); } catch {}
  source.close();
}

const db = new Database(backupFile, { readonly: true });
try {
  const quickCheck = db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {})[0] !== "ok") {
    throw new Error(`backup journal quick_check failed: ${JSON.stringify(quickCheck)}`);
  }
  const operations = db.query(`
    SELECT o.id,o.operation_key,o.job_id,o.generation,o.offer_hashes_json,
           o.claim_inputs_json,o.claim_payouts_json,o.operation_kind,
           o.lifecycle_state,o.error_code,o.error_detail,o.retry_count,
           r.relay_job_id,r.relay_state,r.relay_extrinsic_hash,
           r.ledger_tx_hash,r.ledger_height
      FROM journal_operations o
      LEFT JOIN journal_receipts r ON r.operation_id=o.id
     ORDER BY o.id
  `).all();
  const dust = db.query(`
    SELECT operation_key,job_id,generation,amount_text,state,
           reserved_at_ms,spent_at_ms,updated_at_ms
      FROM journal_dust_reservations ORDER BY rowid
  `).all();
  const terminal = new Set(["SETTLED", "REVERTED", "FAILED"]);
  const activeOperations = operations.filter((row: any) => !terminal.has(row.lifecycle_state));
  const activeDust = dust.filter((row: any) => row.state === "RESERVED");
  const nonEmptyClaimPayouts = operations.filter((row: any) => {
    const parsed = JSON.parse(row.claim_payouts_json);
    return typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 0;
  });
  const settledJobs = operations.filter((row: any) => row.operation_kind === "JOB_SETTLEMENT" && row.lifecycle_state === "SETTLED");
  const invalidSettledJobs = settledJobs.filter((row: any) => {
    const fee = dust.find((entry: any) => entry.operation_key === row.operation_key);
    return row.relay_job_id !== row.job_id || row.relay_state !== "done" ||
      typeof row.relay_extrinsic_hash !== "string" || typeof row.ledger_tx_hash !== "string" ||
      !Number.isSafeInteger(row.ledger_height) || row.ledger_height < 0 ||
      fee?.state !== "SPENT" || !/^[1-9][0-9]*$/.test(String(fee?.amount_text ?? "")) ||
      !Number.isSafeInteger(fee?.spent_at_ms) || fee.spent_at_ms <= 0;
  });
  const assertions = {
    sourceStopped: true,
    coherentSqliteSerialization: true,
    quickCheck: "ok",
    noActiveOperations: activeOperations.length === 0,
    noActiveDustHolds: activeDust.length === 0,
    emptyClaimPayouts: nonEmptyClaimPayouts.length === 0,
    settledJobsHaveRelayLedgerAndSpentDust: invalidSettledJobs.length === 0 && settledJobs.length > 0,
  };
  const status = Object.values(assertions).every((value) => value === true || value === "ok") ? "PASS" : "FAIL";
  writeFileSync(outFile, `${JSON.stringify({
    status,
    capturedAt: new Date().toISOString(),
    sourceJournal: journalFile,
    authoritativeBackup: backupFile,
    assertions,
    failures: { activeOperations, activeDust, nonEmptyClaimPayouts, invalidSettledJobs },
    operations,
    dust,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status, operationCount: operations.length, dustCount: dust.length, assertions }));
  if (status !== "PASS") process.exitCode = 1;
} finally {
  db.close();
}
