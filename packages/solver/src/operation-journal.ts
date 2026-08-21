import { Database } from "bun:sqlite";

export const SOLVER_JOURNAL_SCHEMA_VERSION = 1;
export const DEFAULT_JOURNAL_MAX_ROWS = 10_000;
export const DEFAULT_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_JOURNAL_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RECONCILIATION_MARGIN_MS = 24 * 60 * 60 * 1_000;

const HEX_32 = /^[0-9a-f]{64}$/;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const TERMINAL_STATES = new Set<JournalLifecycleState>(["SETTLED", "REVERTED", "FAILED"]);
const OPERATION_KINDS = [
  "MIRROR_RESERVATION",
  "MIRROR_REVERT",
  "RESIDUAL_BUILD",
  "DUST_BALANCE",
  "FINALIZED_CONTRIBUTION",
  "JOB_SETTLEMENT",
  "JOB_REVERT",
] as const;
const LIFECYCLE_STATES = [
  "PREPARED",
  "APPLIED",
  "AWAITING_RELAY",
  "RELAY_SUBMITTED",
  "CONFIRMING",
  "REVERTING",
  "SETTLED",
  "REVERTED",
  "FAILED",
  "QUARANTINED",
] as const;

export type JournalOperationKind = (typeof OPERATION_KINDS)[number];
export type JournalLifecycleState = (typeof LIFECYCLE_STATES)[number];
export type WalletArtifactKind = "FINALIZED_TRANSACTION" | "UNPROVEN_TRANSACTION";

export interface JournalClaim {
  /** Nullifiers or other canonical 32-byte input identities reserved by Stock. */
  inputs: string[];
  /** Token id to canonical unsigned amount string. */
  payouts: Record<string, string>;
}

export interface JournalReceipt {
  relayJobId?: string;
  relayState?: string;
  relayExtrinsicHash?: string;
  ledgerTxHash?: string;
  ledgerHeight?: number;
}

export interface PreparedOperation {
  operationKey: string;
  jobId: string;
  generation: number;
  offerHashes: string[];
  claim: JournalClaim;
  operationKind: JournalOperationKind;
  ttlExpiresAtMs: number;
  deadlineAtMs: number;
  walletArtifactKind?: WalletArtifactKind;
  walletArtifactBytes?: Uint8Array;
  receipt?: JournalReceipt;
}

export interface TransitionPatch {
  walletArtifactKind?: WalletArtifactKind;
  walletArtifactBytes?: Uint8Array;
  receipt?: JournalReceipt;
  errorCode?: string;
  errorDetail?: string;
  retryCount?: number;
  nextRetryAtMs?: number;
}

export interface JournalOperation extends PreparedOperation {
  id: number;
  lifecycleState: JournalLifecycleState;
  retentionUntilMs: number;
  receipt: JournalReceipt;
  errorCode?: string;
  errorDetail?: string;
  retryCount: number;
  nextRetryAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SolverOperationJournalOptions {
  path: string;
  allowMemory?: boolean;
  maxRows?: number;
  maxBytes?: number;
  maxArtifactBytes?: number;
  reconciliationMarginMs?: number;
  nowMs?: () => number;
  warn?: (message: string) => void;
}

export class JournalOpenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JournalOpenError";
  }
}

export class JournalCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalCapacityError";
  }
}

export class JournalCasConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalCasConflictError";
  }
}

export class JournalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalTransitionError";
  }
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

const allowedTransitions: Record<JournalLifecycleState, ReadonlySet<JournalLifecycleState>> = {
  PREPARED: new Set(["APPLIED", "FAILED", "REVERTING", "REVERTED", "QUARANTINED"]),
  APPLIED: new Set(["AWAITING_RELAY", "CONFIRMING", "REVERTING", "QUARANTINED"]),
  AWAITING_RELAY: new Set(["RELAY_SUBMITTED", "REVERTING", "QUARANTINED"]),
  RELAY_SUBMITTED: new Set(["CONFIRMING", "SETTLED", "QUARANTINED"]),
  CONFIRMING: new Set(["SETTLED", "REVERTING", "QUARANTINED"]),
  REVERTING: new Set(["REVERTED", "QUARANTINED"]),
  QUARANTINED: new Set(["CONFIRMING", "REVERTING", "SETTLED", "REVERTED"]),
  SETTLED: new Set(),
  REVERTED: new Set(),
  FAILED: new Set(),
};

function normalizeCanonical(value: unknown): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical JSON numbers must be safe integers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object") {
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) throw new TypeError(`canonical JSON does not permit undefined at ${key}`);
      result[key] = normalizeCanonical(child);
    }
    return result;
  }
  throw new TypeError(`canonical JSON does not permit ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value));
}

export function parseCanonicalJson<T>(serialized: string): T {
  const parsed = JSON.parse(serialized) as unknown;
  if (canonicalJson(parsed) !== serialized) throw new Error("journal contains non-canonical JSON");
  return parsed as T;
}

function requireSafeInteger(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer >= ${min}`);
  }
}

function requireText(name: string, value: string, max = 512): void {
  if (value.length === 0 || value.length > max || value.includes("\0")) {
    throw new TypeError(`${name} must be non-empty, at most ${max} characters, and contain no NUL`);
  }
}

function requireHex32(name: string, value: string): void {
  if (!HEX_32.test(value)) throw new TypeError(`${name} must be canonical lowercase 32-byte hex`);
}

function requireUniqueSortedHex(name: string, values: string[]): void {
  if (values.length === 0) throw new TypeError(`${name} must not be empty`);
  values.forEach((value, index) => requireHex32(`${name}[${index}]`, value));
  const sorted = [...new Set(values)].sort();
  if (sorted.length !== values.length || sorted.some((value, index) => value !== values[index])) {
    throw new TypeError(`${name} must be unique and lexicographically sorted`);
  }
}

function requireReceipt(receipt: JournalReceipt | undefined): void {
  if (!receipt) return;
  for (const [name, value] of Object.entries(receipt)) {
    if (value === undefined) continue;
    if (name === "ledgerHeight") requireSafeInteger(`receipt.${name}`, value as number);
    else requireText(`receipt.${name}`, value as string, 1024);
  }
}

function requirePrepared(input: PreparedOperation, maxArtifactBytes: number): void {
  requireText("operationKey", input.operationKey);
  requireText("jobId", input.jobId);
  requireSafeInteger("generation", input.generation);
  requireUniqueSortedHex("offerHashes", input.offerHashes);
  requireUniqueSortedHex("claim.inputs", input.claim.inputs);
  for (const [token, amount] of Object.entries(input.claim.payouts)) {
    requireHex32("claim.payouts token", token);
    if (!CANONICAL_UINT.test(amount)) throw new TypeError(`claim payout for ${token} is not canonical unsigned decimal`);
  }
  if (!OPERATION_KINDS.includes(input.operationKind)) throw new TypeError("unknown operationKind");
  requireSafeInteger("ttlExpiresAtMs", input.ttlExpiresAtMs, 1);
  requireSafeInteger("deadlineAtMs", input.deadlineAtMs, 1);
  if (input.deadlineAtMs > input.ttlExpiresAtMs) {
    throw new TypeError("deadlineAtMs must not exceed ttlExpiresAtMs");
  }
  const hasKind = input.walletArtifactKind !== undefined;
  const hasBytes = input.walletArtifactBytes !== undefined;
  if (hasKind !== hasBytes) throw new TypeError("wallet artifact kind and bytes must be supplied together");
  if (input.walletArtifactBytes && input.walletArtifactBytes.byteLength > maxArtifactBytes) {
    throw new JournalCapacityError(`wallet artifact exceeds ${maxArtifactBytes} byte ceiling`);
  }
  requireReceipt(input.receipt);
}

function safeAdd(left: number, right: number, name: string): number {
  const value = left + right;
  requireSafeInteger(name, value, 1);
  return value;
}

interface OperationRow {
  id: number;
  operation_key: string;
  job_id: string;
  generation: number;
  offer_hashes_json: string;
  claim_inputs_json: string;
  claim_payouts_json: string;
  operation_kind: JournalOperationKind;
  lifecycle_state: JournalLifecycleState;
  ttl_expires_at_ms: number;
  deadline_at_ms: number;
  retention_until_ms: number;
  wallet_artifact_kind: WalletArtifactKind | null;
  wallet_artifact_bytes: Uint8Array | null;
  error_code: string | null;
  error_detail: string | null;
  retry_count: number;
  next_retry_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  relay_job_id: string | null;
  relay_state: string | null;
  relay_extrinsic_hash: string | null;
  ledger_tx_hash: string | null;
  ledger_height: number | null;
}

const SELECT_OPERATION = `
  SELECT o.*,
         r.relay_job_id, r.relay_state, r.relay_extrinsic_hash,
         r.ledger_tx_hash, r.ledger_height
    FROM journal_operations o
    LEFT JOIN journal_receipts r ON r.operation_id = o.id
`;

export class SolverOperationJournal {
  readonly path: string;
  readonly journalMode: "wal" | "memory";
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxArtifactBytes: number;
  readonly reconciliationMarginMs: number;

  #db: Database;
  #nowMs: () => number;
  #closed = false;

  private constructor(db: Database, options: Required<Omit<SolverOperationJournalOptions, "warn">>) {
    this.#db = db;
    this.#nowMs = options.nowMs;
    this.path = options.path;
    this.journalMode = options.path === ":memory:" ? "memory" : "wal";
    this.maxRows = options.maxRows;
    this.maxBytes = options.maxBytes;
    this.maxArtifactBytes = options.maxArtifactBytes;
    this.reconciliationMarginMs = options.reconciliationMarginMs;
  }

  static open(options: SolverOperationJournalOptions): SolverOperationJournal {
    const normalized = normalizeOptions(options);
    let db: Database | undefined;
    try {
      db = new Database(normalized.path, { create: true, strict: true });
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA trusted_schema = OFF");
      const desiredMode = normalized.path === ":memory:" ? "MEMORY" : "WAL";
      const modeRow = db.query(`PRAGMA journal_mode = ${desiredMode}`).get() as Record<string, unknown>;
      const actualMode = String(Object.values(modeRow)[0] ?? "").toLowerCase();
      if (actualMode !== desiredMode.toLowerCase()) {
        throw new Error(`journal mode ${actualMode || "unknown"}, expected ${desiredMode.toLowerCase()}`);
      }
      if (desiredMode === "WAL") db.exec("PRAGMA wal_autocheckpoint = 100");

      migrateEmptyDatabase(db);
      validateDatabase(db);
      applyPageCeiling(db, normalized.maxBytes);
      const journal = new SolverOperationJournal(db, normalized);
      journal.#assertWithinCeilings();
      if (normalized.path === ":memory:") {
        try {
          options.warn?.("[JOURNAL] in-memory harness opened; crash durability is disabled");
        } catch {
          // A diagnostic sink is never allowed to change journal authority.
        }
      }
      return journal;
    } catch (error) {
      try { db?.close(false); } catch { /* retain the original failure */ }
      throw new JournalOpenError(`failed to open solver journal at ${JSON.stringify(normalized.path)}`, {
        cause: error,
      });
    }
  }

  createPrepared(input: PreparedOperation): JournalOperation {
    this.#assertOpen();
    requirePrepared(input, this.maxArtifactBytes);
    const now = this.#now();
    const retentionUntil = safeAdd(
      input.ttlExpiresAtMs,
      this.reconciliationMarginMs,
      "retentionUntilMs",
    );
    const insert = this.#db.transaction(() => {
      this.#db.query(`
        INSERT INTO journal_operations (
          operation_key, job_id, generation, offer_hashes_json,
          claim_inputs_json, claim_payouts_json, operation_kind,
          lifecycle_state, ttl_expires_at_ms, deadline_at_ms,
          retention_until_ms, wallet_artifact_kind, wallet_artifact_bytes,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.operationKey,
        input.jobId,
        input.generation,
        canonicalJson(input.offerHashes),
        canonicalJson(input.claim.inputs),
        canonicalJson(input.claim.payouts),
        input.operationKind,
        input.ttlExpiresAtMs,
        input.deadlineAtMs,
        retentionUntil,
        input.walletArtifactKind ?? null,
        input.walletArtifactBytes ?? null,
        now,
        now,
      );
      const row = this.#db.query("SELECT id FROM journal_operations WHERE operation_key = ?")
        .get(input.operationKey) as { id: number };
      if (input.receipt) this.#writeReceipt(row.id, input.receipt);
      this.#assertWithinCeilings();
    });
    try {
      insert();
    } catch (error) {
      if (error instanceof JournalCapacityError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/full|too big|maximum|row ceiling/i.test(message)) {
        throw new JournalCapacityError(`journal capacity refusal: ${message}`);
      }
      throw error;
    }
    return this.require(input.operationKey);
  }

  /** The callback is invoked only after PREPARED is committed and readable. */
  async runPreparedOperation<T>(
    input: PreparedOperation,
    mutation: (prepared: JournalOperation) => Promise<T>,
  ): Promise<T> {
    const prepared = this.createPrepared(input);
    return mutation(prepared);
  }

  transition(
    operationKey: string,
    expectedState: JournalLifecycleState,
    nextState: JournalLifecycleState,
    patch: TransitionPatch = {},
  ): JournalOperation {
    this.#assertOpen();
    requireText("operationKey", operationKey);
    if (!LIFECYCLE_STATES.includes(expectedState) || !LIFECYCLE_STATES.includes(nextState)) {
      throw new JournalTransitionError("unknown lifecycle state");
    }
    const current = this.require(operationKey);
    if (current.lifecycleState === nextState && TERMINAL_STATES.has(nextState)) {
      assertIdempotentTerminalPatch(current, patch);
      return current;
    }
    if (current.lifecycleState !== expectedState) {
      throw new JournalCasConflictError(
        `${operationKey}: expected ${expectedState}, found ${current.lifecycleState}`,
      );
    }
    if (!allowedTransitions[expectedState].has(nextState)) {
      throw new JournalTransitionError(`${operationKey}: illegal ${expectedState} -> ${nextState}`);
    }
    validateTransitionPatch(patch, this.maxArtifactBytes);
    const now = this.#now();
    const update = this.#db.transaction(() => {
      const result = this.#db.query(`
        UPDATE journal_operations
           SET lifecycle_state = ?,
               wallet_artifact_kind = COALESCE(?, wallet_artifact_kind),
               wallet_artifact_bytes = COALESCE(?, wallet_artifact_bytes),
               error_code = COALESCE(?, error_code),
               error_detail = COALESCE(?, error_detail),
               retry_count = COALESCE(?, retry_count),
               next_retry_at_ms = COALESCE(?, next_retry_at_ms),
               updated_at_ms = ?
         WHERE operation_key = ? AND lifecycle_state = ?
      `).run(
        nextState,
        patch.walletArtifactKind ?? null,
        patch.walletArtifactBytes ?? null,
        patch.errorCode ?? null,
        patch.errorDetail ?? null,
        patch.retryCount ?? null,
        patch.nextRetryAtMs ?? null,
        now,
        operationKey,
        expectedState,
      );
      if (result.changes !== 1) {
        throw new JournalCasConflictError(`${operationKey}: compare-and-set lost`);
      }
      const row = this.#db.query("SELECT id FROM journal_operations WHERE operation_key = ?")
        .get(operationKey) as { id: number };
      if (patch.receipt) this.#writeReceipt(row.id, patch.receipt);
      this.#assertWithinCeilings();
    });
    update();
    return this.require(operationKey);
  }

  /** Add one independently observed receipt field without changing lifecycle.
   * Values are write-once: an identical replay is idempotent and any conflict
   * rolls back atomically. This lets RF2 persist relay and inner-ledger facts
   * as their separate authorities become available. */
  recordReceipt(operationKey: string, receipt: JournalReceipt): JournalOperation {
    this.#assertOpen();
    requireText("operationKey", operationKey);
    requireReceipt(receipt);
    const now = this.#now();
    const write = this.#db.transaction(() => {
      const row = this.#db.query("SELECT id FROM journal_operations WHERE operation_key = ?")
        .get(operationKey) as { id: number } | null;
      if (!row) throw new Error(`journal operation not found: ${operationKey}`);
      this.#writeReceipt(row.id, receipt);
      this.#db.query("UPDATE journal_operations SET updated_at_ms = ? WHERE id = ?")
        .run(now, row.id);
      this.#assertWithinCeilings();
    });
    write();
    return this.require(operationKey);
  }

  get(operationKey: string): JournalOperation | undefined {
    this.#assertOpen();
    const row = this.#db.query(`${SELECT_OPERATION} WHERE o.operation_key = ?`).get(operationKey) as
      OperationRow | null;
    return row ? hydrate(row) : undefined;
  }

  require(operationKey: string): JournalOperation {
    const row = this.get(operationKey);
    if (!row) throw new Error(`journal operation not found: ${operationKey}`);
    return row;
  }

  list(): JournalOperation[] {
    this.#assertOpen();
    return (this.#db.query(`${SELECT_OPERATION} ORDER BY o.id`).all() as OperationRow[]).map(hydrate);
  }

  pruneTerminal(nowMs = this.#now()): number {
    this.#assertOpen();
    requireSafeInteger("prune nowMs", nowMs, 1);
    const prune = this.#db.transaction(() => {
      const candidates = this.#db.query(`
        SELECT id FROM journal_operations
         WHERE lifecycle_state IN ('SETTLED', 'REVERTED', 'FAILED')
           AND retention_until_ms <= ?
         ORDER BY id
         LIMIT 1000
      `).all(nowMs) as Array<{ id: number }>;
      if (candidates.length === 0) return 0;
      this.#db.query(`
        DELETE FROM journal_operations
         WHERE id IN (
           SELECT id FROM journal_operations
            WHERE lifecycle_state IN ('SETTLED', 'REVERTED', 'FAILED')
              AND retention_until_ms <= ?
            ORDER BY id
            LIMIT 1000
         )
      `).run(nowMs);
      this.#assertWithinCeilings();
      return candidates.length;
    });
    return prune();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.journalMode === "wal") this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#db.close(false);
  }

  #writeReceipt(operationId: number, receipt: JournalReceipt): void {
    requireReceipt(receipt);
    const existing = this.#db.query(`
      SELECT relay_job_id, relay_state, relay_extrinsic_hash, ledger_tx_hash, ledger_height
        FROM journal_receipts WHERE operation_id = ?
    `).get(operationId) as {
      relay_job_id: string | null;
      relay_state: string | null;
      relay_extrinsic_hash: string | null;
      ledger_tx_hash: string | null;
      ledger_height: number | null;
    } | null;
    const requested: Array<[string, unknown, unknown]> = [
      ["relayJobId", receipt.relayJobId, existing?.relay_job_id],
      ["relayState", receipt.relayState, existing?.relay_state],
      ["relayExtrinsicHash", receipt.relayExtrinsicHash, existing?.relay_extrinsic_hash],
      ["ledgerTxHash", receipt.ledgerTxHash, existing?.ledger_tx_hash],
      ["ledgerHeight", receipt.ledgerHeight, existing?.ledger_height],
    ];
    for (const [name, next, current] of requested) {
      if (next !== undefined && current !== undefined && current !== null && next !== current) {
        throw new JournalTransitionError(`receipt.${name} conflicts with durable evidence`);
      }
    }
    this.#db.query(`
      INSERT INTO journal_receipts (
        operation_id, relay_job_id, relay_state, relay_extrinsic_hash,
        ledger_tx_hash, ledger_height
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        relay_job_id = COALESCE(excluded.relay_job_id, relay_job_id),
        relay_state = COALESCE(excluded.relay_state, relay_state),
        relay_extrinsic_hash = COALESCE(excluded.relay_extrinsic_hash, relay_extrinsic_hash),
        ledger_tx_hash = COALESCE(excluded.ledger_tx_hash, ledger_tx_hash),
        ledger_height = COALESCE(excluded.ledger_height, ledger_height)
    `).run(
      operationId,
      receipt.relayJobId ?? null,
      receipt.relayState ?? null,
      receipt.relayExtrinsicHash ?? null,
      receipt.ledgerTxHash ?? null,
      receipt.ledgerHeight ?? null,
    );
  }

  #assertWithinCeilings(): void {
    const count = this.#db.query("SELECT count(*) AS count FROM journal_operations").get() as { count: number };
    if (count.count > this.maxRows) {
      throw new JournalCapacityError(`journal row ceiling ${this.maxRows} exceeded`);
    }
    const pageCount = pragmaNumber(this.#db, "page_count");
    const pageSize = pragmaNumber(this.#db, "page_size");
    if (pageCount * pageSize > this.maxBytes) {
      throw new JournalCapacityError(`journal byte ceiling ${this.maxBytes} exceeded`);
    }
  }

  #now(): number {
    const now = this.#nowMs();
    requireSafeInteger("journal clock", now, 1);
    return now;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("solver journal is closed");
  }
}

function normalizeOptions(
  options: SolverOperationJournalOptions,
): Required<Omit<SolverOperationJournalOptions, "warn">> {
  requireText("journal path", options.path, 4096);
  const allowMemory = options.allowMemory ?? false;
  if (options.path === ":memory:" && !allowMemory) {
    throw new JournalOpenError(":memory: requires explicit allowMemory=true");
  }
  if (options.path !== ":memory:" && allowMemory) {
    throw new JournalOpenError("allowMemory=true is valid only for :memory:");
  }
  const maxRows = options.maxRows ?? DEFAULT_JOURNAL_MAX_ROWS;
  const maxBytes = options.maxBytes ?? DEFAULT_JOURNAL_MAX_BYTES;
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_JOURNAL_MAX_ARTIFACT_BYTES;
  const reconciliationMarginMs = options.reconciliationMarginMs ?? DEFAULT_RECONCILIATION_MARGIN_MS;
  requireSafeInteger("maxRows", maxRows, 1);
  requireSafeInteger("maxBytes", maxBytes, 64 * 1024);
  requireSafeInteger("maxArtifactBytes", maxArtifactBytes, 1);
  requireSafeInteger("reconciliationMarginMs", reconciliationMarginMs, 1);
  if (maxArtifactBytes > maxBytes) throw new JournalOpenError("artifact ceiling must not exceed journal byte ceiling");
  return {
    path: options.path,
    allowMemory,
    maxRows,
    maxBytes,
    maxArtifactBytes,
    reconciliationMarginMs,
    nowMs: options.nowMs ?? Date.now,
  };
}

function migrateEmptyDatabase(db: Database): void {
  const version = pragmaNumber(db, "user_version");
  if (version === SOLVER_JOURNAL_SCHEMA_VERSION) return;
  if (version !== 0) throw new Error(`unsupported journal schema version ${version}`);
  const tables = db.query(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>;
  if (tables.length !== 0) {
    throw new Error("journal has tables but no recognized schema version");
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE journal_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO journal_meta (singleton, schema_version)
      VALUES (1, ${SOLVER_JOURNAL_SCHEMA_VERSION});

      CREATE TABLE journal_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_key TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        offer_hashes_json TEXT NOT NULL,
        claim_inputs_json TEXT NOT NULL,
        claim_payouts_json TEXT NOT NULL,
        operation_kind TEXT NOT NULL CHECK (operation_kind IN (${OPERATION_KINDS.map((value) => `'${value}'`).join(",")})),
        lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (${LIFECYCLE_STATES.map((value) => `'${value}'`).join(",")})),
        ttl_expires_at_ms INTEGER NOT NULL CHECK (ttl_expires_at_ms > 0),
        deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms > 0 AND deadline_at_ms <= ttl_expires_at_ms),
        retention_until_ms INTEGER NOT NULL CHECK (retention_until_ms >= ttl_expires_at_ms),
        wallet_artifact_kind TEXT CHECK (wallet_artifact_kind IN ('FINALIZED_TRANSACTION','UNPROVEN_TRANSACTION')),
        wallet_artifact_bytes BLOB,
        error_code TEXT,
        error_detail TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        next_retry_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        CHECK ((wallet_artifact_kind IS NULL) = (wallet_artifact_bytes IS NULL))
      ) STRICT;

      CREATE TABLE journal_receipts (
        operation_id INTEGER PRIMARY KEY
          REFERENCES journal_operations(id) ON DELETE CASCADE,
        relay_job_id TEXT,
        relay_state TEXT,
        relay_extrinsic_hash TEXT,
        ledger_tx_hash TEXT,
        ledger_height INTEGER CHECK (ledger_height IS NULL OR ledger_height >= 0)
      ) STRICT;

      CREATE INDEX journal_operations_job_generation
        ON journal_operations(job_id, generation);
      CREATE INDEX journal_operations_retention
        ON journal_operations(lifecycle_state, retention_until_ms);
      PRAGMA user_version = ${SOLVER_JOURNAL_SCHEMA_VERSION};
    `);
  })();
}

function validateDatabase(db: Database): void {
  const version = pragmaNumber(db, "user_version");
  if (version !== SOLVER_JOURNAL_SCHEMA_VERSION) {
    throw new Error(`unsupported journal schema version ${version}`);
  }
  const meta = db.query("SELECT schema_version FROM journal_meta WHERE singleton = 1").get() as
    { schema_version: number } | null;
  if (meta?.schema_version !== SOLVER_JOURNAL_SCHEMA_VERSION) {
    throw new Error("journal schema metadata mismatch");
  }
  const foreignKeyErrors = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length !== 0) throw new Error("journal foreign-key check failed");
  const checks = db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (checks.length !== 1 || String(Object.values(checks[0]!)[0]).toLowerCase() !== "ok") {
    throw new Error("journal integrity check failed");
  }
}

function applyPageCeiling(db: Database, maxBytes: number): void {
  const pageSize = pragmaNumber(db, "page_size");
  const pageCount = pragmaNumber(db, "page_count");
  const maxPages = Math.floor(maxBytes / pageSize);
  if (maxPages < pageCount) throw new JournalCapacityError("journal schema exceeds configured byte ceiling");
  db.exec(`PRAGMA max_page_count = ${maxPages}`);
  if (pragmaNumber(db, "max_page_count") !== maxPages) {
    throw new JournalCapacityError("SQLite did not apply the configured page ceiling");
  }
}

function pragmaNumber(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown>;
  const value = Number(Object.values(row)[0]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid PRAGMA ${name} result`);
  return value;
}

function validateTransitionPatch(patch: TransitionPatch, maxArtifactBytes: number): void {
  const hasKind = patch.walletArtifactKind !== undefined;
  const hasBytes = patch.walletArtifactBytes !== undefined;
  if (hasKind !== hasBytes) throw new TypeError("wallet artifact kind and bytes must be supplied together");
  if (patch.walletArtifactBytes && patch.walletArtifactBytes.byteLength > maxArtifactBytes) {
    throw new JournalCapacityError(`wallet artifact exceeds ${maxArtifactBytes} byte ceiling`);
  }
  if (patch.errorCode !== undefined) requireText("errorCode", patch.errorCode, 256);
  if (patch.errorDetail !== undefined) requireText("errorDetail", patch.errorDetail, 4096);
  if (patch.retryCount !== undefined) requireSafeInteger("retryCount", patch.retryCount);
  if (patch.nextRetryAtMs !== undefined) requireSafeInteger("nextRetryAtMs", patch.nextRetryAtMs, 1);
  requireReceipt(patch.receipt);
}

function assertIdempotentTerminalPatch(current: JournalOperation, patch: TransitionPatch): void {
  validateTransitionPatch(patch, Number.MAX_SAFE_INTEGER);
  const comparisons: Array<[string, unknown, unknown]> = [
    ["walletArtifactKind", patch.walletArtifactKind, current.walletArtifactKind],
    ["errorCode", patch.errorCode, current.errorCode],
    ["errorDetail", patch.errorDetail, current.errorDetail],
    ["retryCount", patch.retryCount, current.retryCount],
    ["nextRetryAtMs", patch.nextRetryAtMs, current.nextRetryAtMs],
  ];
  for (const [name, expected, actual] of comparisons) {
    if (expected !== undefined && expected !== actual) {
      throw new JournalTransitionError(`duplicate terminal transition conflicts on ${name}`);
    }
  }
  if (patch.walletArtifactBytes) {
    if (!current.walletArtifactBytes ||
        patch.walletArtifactBytes.byteLength !== current.walletArtifactBytes.byteLength ||
        !patch.walletArtifactBytes.every((value, index) => current.walletArtifactBytes![index] === value)) {
      throw new JournalTransitionError("duplicate terminal transition conflicts on walletArtifactBytes");
    }
  }
  for (const [key, expected] of Object.entries(patch.receipt ?? {})) {
    if (expected !== undefined && current.receipt[key as keyof JournalReceipt] !== expected) {
      throw new JournalTransitionError(`duplicate terminal transition conflicts on receipt.${key}`);
    }
  }
}

function hydrate(row: OperationRow): JournalOperation {
  if (!OPERATION_KINDS.includes(row.operation_kind) || !LIFECYCLE_STATES.includes(row.lifecycle_state)) {
    throw new Error("journal contains an unknown operation kind or lifecycle state");
  }
  const operation: JournalOperation = {
    id: row.id,
    operationKey: row.operation_key,
    jobId: row.job_id,
    generation: row.generation,
    offerHashes: parseCanonicalJson<string[]>(row.offer_hashes_json),
    claim: {
      inputs: parseCanonicalJson<string[]>(row.claim_inputs_json),
      payouts: parseCanonicalJson<Record<string, string>>(row.claim_payouts_json),
    },
    operationKind: row.operation_kind,
    lifecycleState: row.lifecycle_state,
    ttlExpiresAtMs: row.ttl_expires_at_ms,
    deadlineAtMs: row.deadline_at_ms,
    retentionUntilMs: row.retention_until_ms,
    receipt: {
      ...(row.relay_job_id === null ? {} : { relayJobId: row.relay_job_id }),
      ...(row.relay_state === null ? {} : { relayState: row.relay_state }),
      ...(row.relay_extrinsic_hash === null ? {} : { relayExtrinsicHash: row.relay_extrinsic_hash }),
      ...(row.ledger_tx_hash === null ? {} : { ledgerTxHash: row.ledger_tx_hash }),
      ...(row.ledger_height === null ? {} : { ledgerHeight: row.ledger_height }),
    },
    retryCount: row.retry_count,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.wallet_artifact_kind === null ? {} : { walletArtifactKind: row.wallet_artifact_kind }),
    ...(row.wallet_artifact_bytes === null
      ? {}
      : { walletArtifactBytes: new Uint8Array(row.wallet_artifact_bytes) }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_detail === null ? {} : { errorDetail: row.error_detail }),
    ...(row.next_retry_at_ms === null ? {} : { nextRetryAtMs: row.next_retry_at_ms }),
  };
  requirePrepared(operation, Number.MAX_SAFE_INTEGER);
  requireSafeInteger("retentionUntilMs", operation.retentionUntilMs, operation.ttlExpiresAtMs);
  validateTransitionPatch(operation, Number.MAX_SAFE_INTEGER);
  return operation;
}
