import { Database } from "bun:sqlite";

export const SOLVER_JOURNAL_SCHEMA_VERSION = 2;
export const DEFAULT_JOURNAL_MAX_ROWS = 10_000;
export const DEFAULT_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_JOURNAL_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RECONCILIATION_MARGIN_MS = 24 * 60 * 60 * 1_000;

const HEX_32 = /^[0-9a-f]{64}$/;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const TERMINAL_STATES = new Set<JournalLifecycleState>(["SETTLED", "REVERTED", "FAILED"]);
const OPERATION_KINDS = [
  // LEGACY, READ-ONLY as of 00006-R1 (FR-004). Fee sizing used to reserve real
  // tokenIn coins with `initSwap` and revert them; it now models the taker half
  // with a fabricated transaction that is not wallet state, so no new row of
  // either kind is ever written. Both kinds MUST stay in the grammar: a journal
  // carried across the upgrade can hold non-terminal rows whose coins are real
  // and still need reverting, and dropping them would be a silent schema break.
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

/**
 * A journal row as a READ-ONLY OBSERVER may see it (00007 Q-S-4 option B).
 *
 * Two fields of `JournalOperation` are deliberately absent rather than merely
 * unused by the caller:
 *
 * - `walletArtifactBytes` — serialised transactions. 00007 FR-006 forbids them
 *   leaving the process, and `listRecent` does not even SELECT the column, so
 *   the bytes are never loaded into the heap in the first place; only
 *   `walletArtifactByteLength`, computed by SQLite, comes back.
 * - `claim.inputs` — the coin nullifiers Stock reserved. They identify coins
 *   and answer no operator question, so only their count survives.
 *
 * The type therefore makes the redaction structural: a future collector cannot
 * forward a field that does not exist here.
 */
export interface JournalOperationSummary
  extends Omit<JournalOperation, "walletArtifactBytes" | "claim"> {
  claim: {
    inputCount: number;
    /** Token id → canonical unsigned amount string. */
    payouts: Record<string, string>;
  };
  walletArtifactByteLength: number | null;
}

/** Every lifecycle state, including the ones at count 0, so a consumer can
 *  render a complete table without knowing the grammar. */
export type JournalStateCounts = Record<JournalLifecycleState, number>;

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

export type DustReservationState = "RESERVED" | "SPENT" | "RELEASED";

export interface DustReservation {
  operationKey: string;
  jobId: string;
  generation: number;
  amount: bigint;
  state: DustReservationState;
  reservedAtMs: number;
  spentAtMs?: number;
  updatedAtMs: number;
}

export type DustReservationResult =
  | { accepted: true; reservation: DustReservation; usage: bigint }
  | { accepted: false; reason: "per-job" | "window"; usage: bigint };

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

function requirePositiveBigint(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new TypeError(`${name} must be a positive bigint`);
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

/** `OperationRow` with the artifact blob replaced by its length — the shape
 *  `SELECT_OPERATION_SUMMARY` produces. */
type OperationSummaryRow =
  & Omit<OperationRow, "wallet_artifact_bytes">
  & { wallet_artifact_byte_length: number | null };

interface DustReservationRow {
  operation_key: string;
  job_id: string;
  generation: number;
  amount_text: string;
  state: DustReservationState;
  reserved_at_ms: number;
  spent_at_ms: number | null;
  updated_at_ms: number;
}

function hydrateDust(row: DustReservationRow): DustReservation {
  if (!CANONICAL_UINT.test(row.amount_text) || row.amount_text === "0") {
    throw new Error("journal contains a noncanonical DUST amount");
  }
  return {
    operationKey: row.operation_key,
    jobId: row.job_id,
    generation: row.generation,
    amount: BigInt(row.amount_text),
    state: row.state,
    reservedAtMs: row.reserved_at_ms,
    ...(row.spent_at_ms === null ? {} : { spentAtMs: row.spent_at_ms }),
    updatedAtMs: row.updated_at_ms,
  };
}

const SELECT_OPERATION = `
  SELECT o.*,
         r.relay_job_id, r.relay_state, r.relay_extrinsic_hash,
         r.ledger_tx_hash, r.ledger_height
    FROM journal_operations o
    LEFT JOIN journal_receipts r ON r.operation_id = o.id
`;

/**
 * The observer projection (00007 FR-003 / Q-S-4).
 *
 * Column-for-column explicit, NOT `o.*`, and that is the point: the artifact
 * blob is replaced by `length(...)` inside SQLite, so a status read of a
 * journal holding megabytes of proved transactions transfers none of them into
 * the process heap. `o.*` plus a delete-after-the-fact would have loaded them.
 */
const SELECT_OPERATION_SUMMARY = `
  SELECT o.id, o.operation_key, o.job_id, o.generation,
         o.offer_hashes_json, o.claim_inputs_json, o.claim_payouts_json,
         o.operation_kind, o.lifecycle_state,
         o.ttl_expires_at_ms, o.deadline_at_ms, o.retention_until_ms,
         o.wallet_artifact_kind,
         length(o.wallet_artifact_bytes) AS wallet_artifact_byte_length,
         o.error_code, o.error_detail, o.retry_count, o.next_retry_at_ms,
         o.created_at_ms, o.updated_at_ms,
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
      // SQLite CHECK constraints cannot express canonical decimal text.
      // Hydrate the new authority before returning an apparently usable journal.
      // Existing operation rows retain RF1B's executor-reconciliation failure
      // boundary (runSolver also explicitly hydrates them before wallet start).
      journal.listDustReservations();
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

  /**
   * The NEWEST `limit` rows, redacted for a read-only observer (00007 FR-003,
   * Q-S-4 option B).
   *
   * Newest first because that is the only useful order for an operator asking
   * "what just happened"; `list()` stays oldest-first because recovery replays
   * in insertion order and must not change.
   *
   * Bounded at the SQL level, not by slicing `list()`: a busy solver's journal
   * holds up to `maxRows` (10 000 by default) rows with artifacts attached, and
   * a status endpoint that materialised all of them to keep 100 would be the
   * expensive-status failure 00007 FR-005 exists to prevent.
   */
  listRecent(limit: number): JournalOperationSummary[] {
    this.#assertOpen();
    requireSafeInteger("listRecent limit", limit, 1);
    return (this.#db.query(`${SELECT_OPERATION_SUMMARY} ORDER BY o.id DESC LIMIT ?`)
      .all(limit) as OperationSummaryRow[]).map(hydrateSummary);
  }

  /** How many rows sit in each lifecycle state, over the WHOLE journal rather
   *  than the tail `listRecent` returns. Every state is present, at 0 if empty,
   *  so a consumer renders a complete table without knowing the grammar. */
  countsByState(): JournalStateCounts {
    this.#assertOpen();
    const counts = Object.fromEntries(
      LIFECYCLE_STATES.map((state) => [state, 0]),
    ) as JournalStateCounts;
    const rows = this.#db.query(`
      SELECT lifecycle_state, count(*) AS total
        FROM journal_operations GROUP BY lifecycle_state
    `).all() as Array<{ lifecycle_state: string; total: number }>;
    for (const row of rows) {
      if (!(LIFECYCLE_STATES as readonly string[]).includes(row.lifecycle_state)) {
        throw new Error("journal contains an unknown lifecycle state");
      }
      counts[row.lifecycle_state as JournalLifecycleState] = row.total;
    }
    return counts;
  }

  /** Atomically check and reserve the dynamic RF3 DUST budget. Active
   * reservations count regardless of age; settled spend counts for one rolling
   * window from settlement. A database lock/error is surfaced and therefore
   * fails job admission closed. */
  reserveDust(input: {
    operationKey: string;
    jobId: string;
    generation: number;
    amount: bigint;
    maxPerJob: bigint;
    maxPerWindow: bigint;
    windowMs: number;
  }): DustReservationResult {
    this.#assertOpen();
    requireText("dust operationKey", input.operationKey);
    requireText("dust jobId", input.jobId);
    requireSafeInteger("dust generation", input.generation);
    requirePositiveBigint("dust amount", input.amount);
    requirePositiveBigint("dust maxPerJob", input.maxPerJob);
    requirePositiveBigint("dust maxPerWindow", input.maxPerWindow);
    requireSafeInteger("dust windowMs", input.windowMs, 1);
    const now = this.#now();
    const reserve = this.#db.transaction((): DustReservationResult => {
      const existing = this.#dustByOperationKey(input.operationKey);
      if (existing) {
        if (existing.jobId !== input.jobId || existing.generation !== input.generation ||
            existing.amount !== input.amount || existing.state === "RELEASED") {
          throw new JournalCasConflictError(`${input.operationKey}: conflicting DUST reservation replay`);
        }
        return { accepted: true, reservation: existing, usage: this.#dustUsage(input.windowMs, now) };
      }
      if (input.amount > input.maxPerJob) {
        return { accepted: false, reason: "per-job", usage: this.#dustUsage(input.windowMs, now) };
      }
      const usage = this.#dustUsage(input.windowMs, now);
      if (usage + input.amount > input.maxPerWindow) {
        return { accepted: false, reason: "window", usage };
      }
      const settlement = this.#db.query(`
        SELECT job_id, generation FROM journal_operations WHERE operation_key = ?
      `).get(input.operationKey) as { job_id: string; generation: number } | null;
      if (!settlement || settlement.job_id !== input.jobId || settlement.generation !== input.generation) {
        throw new JournalTransitionError("DUST reservation requires its durable job settlement row");
      }
      this.#db.query(`
        INSERT INTO journal_dust_reservations (
          operation_key, job_id, generation, amount_text, state,
          reserved_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)
      `).run(input.operationKey, input.jobId, input.generation, input.amount.toString(), now, now);
      this.#assertWithinCeilings();
      return {
        accepted: true,
        reservation: this.#dustByOperationKey(input.operationKey)!,
        usage: usage + input.amount,
      };
    });
    return reserve();
  }

  markDustSpent(operationKey: string): DustReservation | undefined {
    return this.#transitionDust(operationKey, "SPENT");
  }

  releaseDust(operationKey: string): DustReservation | undefined {
    return this.#transitionDust(operationKey, "RELEASED");
  }

  dustUsage(windowMs: number, nowMs = this.#now()): bigint {
    this.#assertOpen();
    requireSafeInteger("dust windowMs", windowMs, 1);
    requireSafeInteger("dust usage clock", nowMs, 1);
    return this.#dustUsage(windowMs, nowMs);
  }

  listDustReservations(): DustReservation[] {
    this.#assertOpen();
    return (this.#db.query(`
      SELECT operation_key, job_id, generation, amount_text, state,
             reserved_at_ms, spent_at_ms, updated_at_ms
        FROM journal_dust_reservations ORDER BY rowid
    `).all() as DustReservationRow[]).map(hydrateDust);
  }

  pruneTerminal(nowMs = this.#now()): number {
    this.#assertOpen();
    requireSafeInteger("prune nowMs", nowMs, 1);
    const prune = this.#db.transaction(() => {
      const candidates = this.#db.query(`
        SELECT id FROM journal_operations
         WHERE lifecycle_state IN ('SETTLED', 'REVERTED', 'FAILED')
           AND retention_until_ms <= ?
           AND NOT EXISTS (
             SELECT 1 FROM journal_dust_reservations d
              WHERE d.operation_key = journal_operations.operation_key
           )
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
              AND NOT EXISTS (
                SELECT 1 FROM journal_dust_reservations d
                 WHERE d.operation_key = journal_operations.operation_key
              )
            ORDER BY id
            LIMIT 1000
         )
      `).run(nowMs);
      this.#assertWithinCeilings();
      return candidates.length;
    });
    return prune();
  }

  /** Remove only DUST rows that no longer contribute to any possible rolling
   * window. Parent operation retention can proceed on the next prune pass. */
  pruneDust(windowMs: number, nowMs = this.#now()): number {
    this.#assertOpen();
    requireSafeInteger("dust windowMs", windowMs, 1);
    requireSafeInteger("dust prune clock", nowMs, 1);
    const cutoff = Math.max(0, nowMs - windowMs);
    const result = this.#db.query(`
      DELETE FROM journal_dust_reservations
       WHERE state = 'RELEASED' OR (state = 'SPENT' AND spent_at_ms <= ?)
    `).run(cutoff);
    return result.changes;
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

  #dustByOperationKey(operationKey: string): DustReservation | undefined {
    const row = this.#db.query(`
      SELECT operation_key, job_id, generation, amount_text, state,
             reserved_at_ms, spent_at_ms, updated_at_ms
        FROM journal_dust_reservations WHERE operation_key = ?
    `).get(operationKey) as DustReservationRow | null;
    return row ? hydrateDust(row) : undefined;
  }

  #dustUsage(windowMs: number, nowMs: number): bigint {
    const cutoff = Math.max(0, nowMs - windowMs);
    const rows = this.#db.query(`
      SELECT amount_text FROM journal_dust_reservations
       WHERE state = 'RESERVED' OR (state = 'SPENT' AND spent_at_ms > ?)
    `).all(cutoff) as Array<{ amount_text: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n);
  }

  #transitionDust(operationKey: string, next: "SPENT" | "RELEASED"): DustReservation | undefined {
    this.#assertOpen();
    requireText("dust operationKey", operationKey);
    const now = this.#now();
    const change = this.#db.transaction(() => {
      const current = this.#dustByOperationKey(operationKey);
      if (!current) return undefined;
      if (current.state === next) return current;
      if (current.state !== "RESERVED") {
        throw new JournalTransitionError(
          `${operationKey}: DUST cannot transition ${current.state} -> ${next}`,
        );
      }
      this.#db.query(`
        UPDATE journal_dust_reservations
           SET state = ?, spent_at_ms = ?, updated_at_ms = ?
         WHERE operation_key = ? AND state = 'RESERVED'
      `).run(next, next === "SPENT" ? now : null, now, operationKey);
      return this.#dustByOperationKey(operationKey);
    });
    return change();
  }

  #assertWithinCeilings(): void {
    const count = this.#db.query(`
      SELECT (SELECT count(*) FROM journal_operations) +
             (SELECT count(*) FROM journal_dust_reservations) AS count
    `).get() as { count: number };
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
  if (version === 1) {
    db.transaction(() => {
      createDustReservationTable(db);
      db.exec(`
        UPDATE journal_meta SET schema_version = ${SOLVER_JOURNAL_SCHEMA_VERSION}
         WHERE singleton = 1 AND schema_version = 1;
        PRAGMA user_version = ${SOLVER_JOURNAL_SCHEMA_VERSION};
      `);
    })();
    return;
  }
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
    `);
    createDustReservationTable(db);
    db.exec(`PRAGMA user_version = ${SOLVER_JOURNAL_SCHEMA_VERSION}`);
  })();
}

function createDustReservationTable(db: Database): void {
  db.exec(`
    CREATE TABLE journal_dust_reservations (
      operation_key TEXT PRIMARY KEY
        REFERENCES journal_operations(operation_key) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      amount_text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('RESERVED','SPENT','RELEASED')),
      reserved_at_ms INTEGER NOT NULL CHECK (reserved_at_ms > 0),
      spent_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= reserved_at_ms),
      CHECK ((state = 'SPENT') = (spent_at_ms IS NOT NULL))
    ) STRICT;
    CREATE INDEX journal_dust_window
      ON journal_dust_reservations(state, spent_at_ms);
  `);
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

/**
 * Hydrate the redacted observer projection.
 *
 * It re-checks the kind/state grammar exactly as `hydrate` does — a row with an
 * unknown state is a corrupt journal whichever reader finds it — but it does
 * NOT run `requirePrepared`/`validateTransitionPatch`: both need the claim
 * inputs and the artifact this projection deliberately does not carry, and
 * `runSolver` already forces a full `list()` hydration of every row before the
 * wallet is acquired. A status read is not the place to re-litigate that.
 */
function hydrateSummary(row: OperationSummaryRow): JournalOperationSummary {
  if (!OPERATION_KINDS.includes(row.operation_kind) || !LIFECYCLE_STATES.includes(row.lifecycle_state)) {
    throw new Error("journal contains an unknown operation kind or lifecycle state");
  }
  return {
    id: row.id,
    operationKey: row.operation_key,
    jobId: row.job_id,
    generation: row.generation,
    offerHashes: parseCanonicalJson<string[]>(row.offer_hashes_json),
    claim: {
      inputCount: parseCanonicalJson<string[]>(row.claim_inputs_json).length,
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
    walletArtifactByteLength: row.wallet_artifact_byte_length,
    ...(row.wallet_artifact_kind === null ? {} : { walletArtifactKind: row.wallet_artifact_kind }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_detail === null ? {} : { errorDetail: row.error_detail }),
    ...(row.next_retry_at_ms === null ? {} : { nextRetryAtMs: row.next_retry_at_ms }),
  };
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
