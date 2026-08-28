/**
 * Instrumented wrapper around the production `runSolver` entrypoint.
 *
 * The only test instrumentation is replacing selected live-wallet method
 * boundaries with pass-through recording wrappers. Every wrapper invokes its
 * exact original method first and returns the exact original result/promise or
 * thrown value. Wallet construction, synchronization, proving, validation,
 * matching, and chain submission remain production code.
 *
 * CLI contract:
 *   bun packages/tests/grand-e2e/lib/solver-offerfiles-real-solver-service.ts run
 *
 * Required environment:
 *   E1_RUN_ID, E1_SOLVER_SEED, E1_SOLVER_API, E1_SOLVER_AUTH_TOKEN,
 *   E1_SOLVER_LADDER_CONFIG, E1_SOLVER_TELEMETRY_PATH,
 *   E1_SOLVER_RUNTIME_PATH
 * Optional central ordering evidence:
 *   E1_SOLVER_RECORDER_URL (the telemetry relay's exact /record URL),
 *   E1_SOLVER_RECORDER_TOKEN, E1_SOLVER_RECORDER_TIMEOUT_MS
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type { WalletResult } from "@effectstream/midnight-contracts/types";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { tokenImbalances } from "@zswap-da/solver-core/batcher";
import {
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  waitForSync,
} from "@zswap-da/solver-core/wallet";
import {
  runSolver,
  type SolverHandle,
  type SolverWalletDependencies,
} from "../../../solver/src/run.ts";

/**
 * R3/FR-006 removal note. This harness used to pass `onValidationTrace`,
 * `onOutcome` and `onMatchOutcome` to `runSolver`, plus the
 * `ValidationGateTrace` shape and `recordRealValidationTraceEvidence` helper
 * that fed them. `SolverOptions` has had none of those options since N5 deleted
 * the pre-match validation gate, so the callbacks were never invoked at
 * runtime — they only survived because nothing typechecked this file. They are
 * gone; the evidence they would have produced (per-offer stock rows keyed by
 * the offers a fill selected) needs a live source from the current solver, and
 * that is N6's replacement of this pre-R2 harness, not a type fix.
 * `stockSnapshot(hashes)` still produces those rows for any caller that knows
 * the hashes, and the terminal snapshot still records solver-wide token rows.
 */
const SCHEMA = "zswap-offer-files-real-solver/v1";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const nowIso = (): string => new Date().toISOString();
const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function jsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, seen));
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => [jsonValue(key, seen), jsonValue(entry, seen)]);
  }
  if (value instanceof Set) return [...value].map((entry) => jsonValue(entry, seen));
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    try {
      output[key] = jsonValue((value as Record<string, unknown>)[key], seen);
    } catch (error) {
      output[key] = `[unreadable: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }
  return output;
}

function requireAbsolutePath(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requireRunId(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) {
    throw new Error("E1_RUN_ID must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}");
  }
  return value;
}

function requireSeed(value: string | undefined): string {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("E1_SOLVER_SEED must be exactly 64 hexadecimal characters");
  }
  return value.toLowerCase();
}

function requireHttpUrl(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function requireWsUrl(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`${name} must be an absolute WS(S) URL`);
  }
  return parsed.toString();
}

function requireRecorderUrl(value: string | undefined): string {
  const canonical = requireHttpUrl("E1_SOLVER_RECORDER_URL", value);
  const parsed = new URL(value!);
  if (parsed.pathname !== "/record" || parsed.search || parsed.hash) {
    throw new Error("E1_SOLVER_RECORDER_URL must target the exact /record path");
  }
  return canonical;
}

function positiveSafeInteger(name: string, value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export interface RealSolverServiceConfig {
  runId: string;
  seed: string;
  api: string;
  authToken: string;
  relayUrl?: string;
  relayAuthToken?: string;
  ladderConfigPath: string;
  telemetryPath: string;
  runtimePath: string;
  recorderUrl?: string;
  recorderToken?: string;
  recorderTimeoutMs: number;
  startupTimeoutMs: number;
  walletOperationTimeoutMs: number;
  stopTimeoutMs: number;
}

export function readRealSolverServiceConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealSolverServiceConfig {
  if (net.id !== "undeployed") {
    throw new Error(`real solver service requires MIDNIGHT_NETWORK_ID=undeployed, got ${net.id}`);
  }
  const authToken = env["E1_SOLVER_AUTH_TOKEN"];
  if (!authToken || authToken.length < 16 || /\s/.test(authToken)) {
    throw new Error("E1_SOLVER_AUTH_TOKEN must contain at least 16 non-whitespace characters");
  }
  const recorderUrl = env["E1_SOLVER_RECORDER_URL"] === undefined
    ? undefined
    : requireRecorderUrl(env["E1_SOLVER_RECORDER_URL"]);
  const recorderToken = env["E1_SOLVER_RECORDER_TOKEN"];
  const relayAuthToken = env["E1_SOLVER_RELAY_AUTH_TOKEN"];
  if (recorderToken !== undefined && recorderUrl === undefined) {
    throw new Error("E1_SOLVER_RECORDER_TOKEN requires E1_SOLVER_RECORDER_URL");
  }
  if (recorderToken !== undefined && (recorderToken.length < 16 || /\s/.test(recorderToken))) {
    throw new Error("E1_SOLVER_RECORDER_TOKEN must contain at least 16 non-whitespace characters");
  }
  if (relayAuthToken !== undefined && (relayAuthToken.length < 32 || /\s/.test(relayAuthToken))) {
    throw new Error("E1_SOLVER_RELAY_AUTH_TOKEN must contain at least 32 non-whitespace characters");
  }
  const ladderConfigPath = requireAbsolutePath(
    "E1_SOLVER_LADDER_CONFIG",
    env["E1_SOLVER_LADDER_CONFIG"],
  );
  const telemetryPath = requireAbsolutePath(
    "E1_SOLVER_TELEMETRY_PATH",
    env["E1_SOLVER_TELEMETRY_PATH"],
  );
  const runtimePath = requireAbsolutePath(
    "E1_SOLVER_RUNTIME_PATH",
    env["E1_SOLVER_RUNTIME_PATH"],
  );
  if (new Set([ladderConfigPath, telemetryPath, runtimePath]).size !== 3) {
    throw new Error("solver ladder, telemetry, and runtime paths must be distinct");
  }
  return {
    runId: requireRunId(env["E1_RUN_ID"]),
    seed: requireSeed(env["E1_SOLVER_SEED"]),
    api: requireHttpUrl("E1_SOLVER_API", env["E1_SOLVER_API"]),
    authToken,
    ...(env["E1_SOLVER_RELAY_WS_URL"] === undefined
      ? {}
      : { relayUrl: requireWsUrl("E1_SOLVER_RELAY_WS_URL", env["E1_SOLVER_RELAY_WS_URL"]) }),
    ...(relayAuthToken === undefined ? {} : { relayAuthToken }),
    ladderConfigPath,
    telemetryPath,
    runtimePath,
    ...(recorderUrl ? { recorderUrl } : {}),
    ...(recorderToken ? { recorderToken } : {}),
    recorderTimeoutMs: positiveSafeInteger(
      "E1_SOLVER_RECORDER_TIMEOUT_MS",
      env["E1_SOLVER_RECORDER_TIMEOUT_MS"],
      15_000,
    ),
    startupTimeoutMs: positiveSafeInteger(
      "E1_SOLVER_STARTUP_TIMEOUT_MS",
      env["E1_SOLVER_STARTUP_TIMEOUT_MS"],
      240_000,
    ),
    walletOperationTimeoutMs: positiveSafeInteger(
      "E1_SOLVER_WALLET_OPERATION_TIMEOUT_MS",
      env["E1_SOLVER_WALLET_OPERATION_TIMEOUT_MS"],
      300_000,
    ),
    stopTimeoutMs: positiveSafeInteger(
      "E1_SOLVER_STOP_TIMEOUT_MS",
      env["E1_SOLVER_STOP_TIMEOUT_MS"],
      30_000,
    ),
  };
}

export type RealSolverTelemetryKind =
  | "service-starting"
  | "wallet-built"
  | "solver-log"
  | "validation-trace"
  | "fill-outcome"
  | "match-outcome"
  | "submit-started"
  | "submit-succeeded"
  | "submit-failed"
  | "wallet-boundary"
  | "stock-snapshot"
  | "solver-ready"
  | "solver-ready-failed"
  | "service-stopping"
  | "service-stopped";

export interface RealSolverTelemetryEvent {
  schema: typeof SCHEMA;
  runId: string;
  sequence: number;
  recordedAt: string;
  monotonicMs: number;
  kind: RealSolverTelemetryKind;
  data: JsonValue;
}

class SerializedTelemetry {
  readonly #path: string;
  readonly #runId: string;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();
  #error: Error | null = null;

  private constructor(path: string, runId: string) {
    this.#path = path;
    this.#runId = runId;
  }

  static async create(path: string, runId: string): Promise<SerializedTelemetry> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "", { encoding: "utf8", mode: 0o600 });
    return new SerializedTelemetry(path, runId);
  }

  emit(kind: RealSolverTelemetryKind, data: unknown): Promise<void> {
    const event: RealSolverTelemetryEvent = {
      schema: SCHEMA,
      runId: this.#runId,
      sequence: ++this.#sequence,
      recordedAt: nowIso(),
      monotonicMs: performance.now(),
      kind,
      data: jsonValue(data),
    };
    const write = this.#tail.then(async () => {
      if (this.#error) throw this.#error;
      try {
        await appendFile(this.#path, `${JSON.stringify(event)}\n`, "utf8");
      } catch (error) {
        this.#error = error instanceof Error ? error : new Error(String(error));
        throw this.#error;
      }
    });
    this.#tail = write.catch(() => undefined);
    return write;
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#error) throw this.#error;
  }

  get count(): number {
    return this.#sequence;
  }
}

export class RealSolverEvidenceFailures {
  readonly #errors: Error[] = [];
  readonly #keys = new Set<string>();

  add(label: string, reason: unknown): void {
    const cause = reason instanceof Error ? reason : new Error(String(reason));
    const key = `${label}\u0000${cause.message}`;
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#errors.push(new Error(`${label}: ${cause.message}`, { cause }));
  }

  messages(): string[] {
    return this.#errors.map((error) => error.message);
  }

  assertNone(): void {
    if (this.#errors.length === 1) throw this.#errors[0];
    if (this.#errors.length > 1) {
      throw new AggregateError([...this.#errors], "real solver evidence collection failed");
    }
  }
}

/**
 * Bound an evidence-only drain without cancelling or otherwise changing the
 * observed production operation. A deadline is retained as an evidence
 * failure for the outer acceptance gate; it is never rethrown into the solver
 * lifecycle.
 */
export async function waitForRealEvidenceWithin(
  label: string,
  operation: Promise<unknown>,
  timeoutMs: number,
  failures: RealSolverEvidenceFailures,
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("real evidence timeout must be a positive safe integer");
  }
  // Promise.race installs rejection handlers on the original promise. Keep an
  // explicit observer too so a late failure remains handled after the deadline.
  void operation.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`did not settle within ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch (error) {
    failures.add(label, error);
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export interface RealSolverCentralRecorderConfig {
  url?: string;
  token?: string;
  timeoutMs: number;
  runId: string;
  failures: RealSolverEvidenceFailures;
  /** Deterministic test-only seam; production always uses global fetch. */
  request?: typeof fetch;
}

/**
 * One serialized HTTP queue shared by every solver milestone. The recorder's
 * returned sequence is the only cross-container ordering authority; local
 * clocks are deliberately omitted from the relayed body.
 */
export class RealSolverCentralRecorder {
  readonly #config: RealSolverCentralRecorderConfig;
  #tail: Promise<void> = Promise.resolve();
  #localSequence = 0;
  #lastCentralSequence: number | null = null;
  #failed = false;

  constructor(config: RealSolverCentralRecorderConfig) {
    this.#config = config;
  }

  enqueue(phase: string, event: string, data: unknown): void {
    if (!this.#config.url) return;
    const localSequence = ++this.#localSequence;
    let normalized: JsonValue;
    try {
      normalized = jsonValue(data);
    } catch (error) {
      this.#config.failures.add(`central recorder ${phase}/${event} snapshot`, error);
      return;
    }
    const fields =
      normalized && typeof normalized === "object" && !Array.isArray(normalized)
        ? normalized
        : { data: normalized };
    const body = JSON.stringify({
      ...fields,
      phase,
      event,
      runId: this.#config.runId,
      solverSequence: localSequence,
    });
    const operation = this.#tail.then(async () => {
      if (this.#failed) return;
      const response = await (this.#config.request ?? fetch)(this.#config.url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#config.token
            ? { authorization: `Bearer ${this.#config.token}` }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(this.#config.timeoutMs),
      });
      if (response.status !== 201 && response.status !== 202) {
        throw new Error(`recorder returned ${response.status}`);
      }
      const parsed = await response.json() as { sequence?: unknown };
      const sequence = Number(parsed.sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error("recorder returned a non-canonical sequence");
      }
      if (this.#lastCentralSequence !== null && sequence <= this.#lastCentralSequence) {
        throw new Error(
          `recorder sequence regressed from ${this.#lastCentralSequence} to ${sequence}`,
        );
      }
      this.#lastCentralSequence = sequence;
    });
    this.#tail = operation.catch((error) => {
      this.#failed = true;
      this.#config.failures.add(`central recorder ${phase}/${event}`, error);
    });
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  get enabled(): boolean {
    return this.#config.url !== undefined;
  }

  get lastSequence(): number | null {
    return this.#lastCentralSequence;
  }
}

class RuntimeManifest {
  readonly #path: string;
  readonly #base: Record<string, JsonValue>;
  readonly #values: Record<string, JsonValue> = {};
  #tail: Promise<void> = Promise.resolve();
  #error: Error | null = null;

  constructor(path: string, base: Record<string, JsonValue>) {
    this.#path = path;
    this.#base = base;
  }

  update(state: string, values: Record<string, unknown> = {}): Promise<void> {
    Object.assign(
      this.#values,
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, jsonValue(value)])),
    );
    const document = {
      ...this.#base,
      ...this.#values,
      state,
      updatedAt: nowIso(),
    };
    const update = this.#tail.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#path);
    });
    this.#tail = update.catch((error) => {
      this.#error = error instanceof Error ? error : new Error(String(error));
    });
    return update;
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#error) throw this.#error;
  }
}

export interface RealSubmissionInspection {
  count: number;
  transactionHash: string | null;
  identifiers: readonly string[];
  blobHash: string | null;
  blobBytes: number | null;
  imbalanceCount: number;
  imbalances: ReadonlyArray<{ segment: number; tag: string; token: string; amount: string }>;
  protocolFee: Readonly<{
    asset: "DUST";
    specks: string;
    source: "wallet.calculateTransactionFee";
    transactionHash: string;
  }> | null;
  inspectionErrors: readonly string[];
}

function inspectSubmission(transaction: unknown, count: number): Readonly<RealSubmissionInspection> {
  const errors: string[] = [];
  let transactionHash: string | null = null;
  let identifiers: string[] = [];
  let blobHash: string | null = null;
  let blobBytes: number | null = null;
  let imbalances: Array<{ segment: number; tag: string; token: string; amount: string }> = [];
  try {
    if (!transaction || typeof transaction !== "object") {
      throw new Error("transaction is not an object");
    }
    const serialize = (transaction as { serialize?: unknown }).serialize;
    if (typeof serialize !== "function") throw new Error("transaction exposes no serialize()");
    const bytes = Reflect.apply(serialize, transaction, []);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error("transaction serialized to no bytes");
    }
    blobHash = sha256(bytes);
    blobBytes = bytes.length;
  } catch (error) {
    errors.push(`serialization: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const getIdentifiers = (transaction as { identifiers?: unknown } | null)?.identifiers;
    if (typeof getIdentifiers !== "function") throw new Error("transaction exposes no identifiers()");
    const values = Reflect.apply(getIdentifiers, transaction, []);
    if (!Array.isArray(values) || values.length === 0) throw new Error("transaction returned no identifiers");
    identifiers = values.map(String).sort();
  } catch (error) {
    errors.push(`identifiers: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const getHash = (transaction as { transactionHash?: unknown } | null)?.transactionHash;
    if (typeof getHash !== "function") throw new Error("transaction exposes no transactionHash()");
    const value = String(Reflect.apply(getHash, transaction, []));
    if (value.length === 0) throw new Error("transaction returned an empty hash");
    transactionHash = value;
  } catch (error) {
    errors.push(`transaction hash: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    imbalances = tokenImbalances(transaction as never).map((imbalance) => Object.freeze({
      segment: imbalance.seg,
      tag: imbalance.tag,
      token: imbalance.raw,
      amount: imbalance.amount.toString(),
    }));
  } catch (error) {
    errors.push(`imbalances: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({
    count,
    transactionHash,
    identifiers: Object.freeze(identifiers),
    blobHash,
    blobBytes,
    imbalanceCount: imbalances.length,
    imbalances: Object.freeze(imbalances),
    protocolFee: null,
    inspectionErrors: Object.freeze(errors),
  });
}

export async function attachExactProtocolFee(
  wallet: Record<string, unknown>,
  transaction: unknown,
  inspection: Readonly<RealSubmissionInspection>,
  timeoutMs?: number,
): Promise<Readonly<RealSubmissionInspection>> {
  const calculate = wallet["calculateTransactionFee"];
  if (typeof calculate !== "function") {
    throw new Error("real solver wallet exposes no calculateTransactionFee method");
  }
  if (inspection.transactionHash === null) {
    throw new Error("cannot bind exact protocol fee without the submitted transaction hash");
  }
  const calculation = Promise.resolve(Reflect.apply(calculate, wallet, [transaction]));
  void calculation.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const fee = await (timeoutMs === undefined
    ? calculation
    : Promise.race([
        calculation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`exact protocol fee calculation timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ])).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
  if (typeof fee !== "bigint" || fee <= 0n) {
    throw new Error(`wallet.calculateTransactionFee returned invalid fee ${String(fee)}`);
  }
  return Object.freeze({
    ...inspection,
    protocolFee: Object.freeze({
      asset: "DUST" as const,
      specks: fee.toString(),
      source: "wallet.calculateTransactionFee" as const,
      transactionHash: inspection.transactionHash,
    }),
  });
}

function submissionResultIdentity(value: unknown): JsonValue {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return jsonValue(value);
  const record = value as Record<string, unknown>;
  return jsonValue({
    transactionHash: record["transactionHash"] ?? record["txHash"] ?? record["txId"],
    identifier: record["identifier"] ?? record["id"],
    status: record["status"],
  });
}

export type RealSubmitEvidenceEvent<Transaction, Result> =
  | { kind: "started"; count: number; transaction: Transaction }
  | { kind: "succeeded"; count: number; transaction: Transaction; result: Result }
  | { kind: "failed"; count: number; transaction: Transaction; error: unknown };

export interface SemanticsPreservingSubmitWrapper<Transaction, Result> {
  /** The original function's exact return value/promise and thrown value pass through unchanged. */
  readonly submit: (transaction: Transaction) => Promise<Result>;
  readonly count: () => number;
  /** Waits only for independent evidence observers; it never changes a submission outcome. */
  readonly flush: () => Promise<void>;
  /** Drains observers, then fails the outer evidence gate if any observer failed. */
  readonly flushEvidence: () => Promise<void>;
}

export type RealMethodEvidenceEvent<Arguments extends unknown[], Result> =
  | { kind: "started"; count: number; arguments: Arguments }
  | { kind: "succeeded"; count: number; arguments: Arguments; result: Result }
  | { kind: "failed"; count: number; arguments: Arguments; error: unknown };

export interface SemanticsPreservingMethodWrapper<Arguments extends unknown[], Result> {
  readonly invoke: (...arguments_: Arguments) => Promise<Result>;
  readonly count: () => number;
  readonly flush: () => Promise<void>;
}

/** The same pass-through rule as submitTransaction, for other async wallet boundaries. */
export function createSemanticsPreservingMethodWrapper<Arguments extends unknown[], Result>(options: {
  label: string;
  receiver: unknown;
  original: (...arguments_: Arguments) => Promise<Result>;
  observe: (event: RealMethodEvidenceEvent<Arguments, Result>) => void | Promise<void>;
  failures: RealSolverEvidenceFailures;
}): SemanticsPreservingMethodWrapper<Arguments, Result> {
  let count = 0;
  const pending = new Set<Promise<void>>();
  const retain = (operation: Promise<void>): void => {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
  };
  const observe = (event: RealMethodEvidenceEvent<Arguments, Result>): Promise<void> =>
    Promise.resolve()
      .then(() => options.observe(event))
      .catch((error) =>
        options.failures.add(`${options.label} ${event.count} ${event.kind} evidence`, error),
      );
  const invoke = function (...arguments_: Arguments): Promise<Result> {
    let originalResult: Promise<Result>;
    try {
      // Deliberately first: no counter, snapshot, observer, or I/O precedes it.
      originalResult = Reflect.apply(options.original, options.receiver, arguments_);
    } catch (error) {
      const invocationCount = ++count;
      const started = observe({ kind: "started", count: invocationCount, arguments: arguments_ });
      const lifecycle = started.then(() =>
        observe({ kind: "failed", count: invocationCount, arguments: arguments_, error }),
      );
      retain(lifecycle);
      throw error;
    }
    const invocationCount = ++count;
    const started = observe({ kind: "started", count: invocationCount, arguments: arguments_ });
    const lifecycle = Promise.resolve(originalResult).then(
      (result) => started.then(() =>
        observe({ kind: "succeeded", count: invocationCount, arguments: arguments_, result }),
      ),
      (error) => started.then(() =>
        observe({ kind: "failed", count: invocationCount, arguments: arguments_, error }),
      ),
    );
    retain(lifecycle);
    return originalResult;
  };
  return {
    invoke,
    count: () => count,
    flush: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

/**
 * Instrument one real submit boundary without putting evidence I/O in front of
 * it. Inspection starts in a microtask only after the original has been
 * invoked. The exact original promise (or exact synchronous thrown value) is
 * returned to production. Observer failures are retained by the independent
 * failure sink and are asserted later by the outer acceptance gate.
 */
export function createSemanticsPreservingSubmitWrapper<Transaction, Result>(options: {
  receiver: unknown;
  original: (transaction: Transaction) => Promise<Result>;
  observe: (event: RealSubmitEvidenceEvent<Transaction, Result>) => void | Promise<void>;
  failures: RealSolverEvidenceFailures;
}): SemanticsPreservingSubmitWrapper<Transaction, Result> {
  let count = 0;
  const pending = new Set<Promise<void>>();

  const retain = (operation: Promise<void>): void => {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
  };
  const observe = (event: RealSubmitEvidenceEvent<Transaction, Result>): Promise<void> =>
    Promise.resolve()
      .then(() => options.observe(event))
      .catch((error) => options.failures.add(`submit ${event.count} ${event.kind} evidence`, error));

  const submit = function (transaction: Transaction): Promise<Result> {
    let originalResult: Promise<Result>;
    try {
      // This is intentionally the first potentially user-code operation.
      originalResult = Reflect.apply(options.original, options.receiver, [transaction]);
    } catch (error) {
      const submissionCount = ++count;
      const started = observe({ kind: "started", count: submissionCount, transaction });
      const lifecycle = started.then(() =>
        observe({ kind: "failed", count: submissionCount, transaction, error }),
      );
      retain(lifecycle);
      throw error;
    }

    const submissionCount = ++count;
    const started = observe({ kind: "started", count: submissionCount, transaction });
    const lifecycle = Promise.resolve(originalResult).then(
      (result) => started.then(() =>
        observe({ kind: "succeeded", count: submissionCount, transaction, result }),
      ),
      (error) => started.then(() =>
        observe({ kind: "failed", count: submissionCount, transaction, error }),
      ),
    );
    retain(lifecycle);
    return originalResult;
  };

  const flush = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  return {
    submit,
    count: () => count,
    flush,
    flushEvidence: async () => {
      await flush();
      options.failures.assertNone();
    },
  };
}

export interface RealSolverEvidenceSummary {
  localEventCount: number;
  centralRecorderEnabled: boolean;
  lastCentralSequence: number | null;
  submissionCount: number;
  walletBoundaries: RealWalletBoundarySnapshot;
  stock: RealStockSnapshot;
  failures: readonly string[];
}

export const REAL_WALLET_BOUNDARIES = [
  "balanceFinalizedTransaction",
  "finalizeRecipe",
  "submitTransaction",
  "revert",
  "revertTransaction",
  "transferTransaction",
  "finalizeTransaction",
  "initSwap",
] as const;

export type RealWalletBoundaryName = typeof REAL_WALLET_BOUNDARIES[number];

export interface RealWalletBoundarySnapshot {
  features: {
    pathB: false;
    residualTopUps: false;
    cycles: false;
    levelsPublication: false;
  };
  methods: Record<RealWalletBoundaryName, { available: boolean; calls: number }>;
}

export interface RealStockSnapshot {
  tokens: ReadonlyArray<{
    token: string;
    balance: string;
    reserved: string;
    available: string;
  }>;
  offers: ReadonlyArray<{
    offerHash: string;
    resolvable: boolean;
    claimed: boolean | null;
    nullifiers: readonly string[];
  }>;
}

export interface RealStockSnapshotReader {
  tokens: () => string[];
  balance: (token: string) => bigint;
  reserved: (token: string) => bigint;
  available: (token: string) => bigint;
  isClaimed: (claim: { offerHashes: string[]; nullifiers: string[] }) => boolean;
}

export function buildRealStockSnapshot(
  stock: RealStockSnapshotReader | null,
  offers: ReadonlyArray<{ offerHash: string; inputNullifiers?: readonly string[] }>,
): RealStockSnapshot {
  const tokens = stock
    ? [...stock.tokens()].sort().map((token) => ({
        token,
        balance: stock.balance(token).toString(),
        reserved: stock.reserved(token).toString(),
        available: stock.available(token).toString(),
      }))
    : [];
  const offerRows = [...offers]
    .sort((left, right) => left.offerHash.localeCompare(right.offerHash))
    .map((offer) => ({
      offerHash: offer.offerHash.toLowerCase(),
      resolvable: stock !== null && offer.inputNullifiers !== undefined,
      claimed: stock !== null && offer.inputNullifiers !== undefined
        ? stock.isClaimed({
            offerHashes: [offer.offerHash.toLowerCase()],
            nullifiers: [...offer.inputNullifiers],
          })
        : null,
      nullifiers: Object.freeze([...(offer.inputNullifiers ?? [])]),
    }));
  return { tokens: Object.freeze(tokens), offers: Object.freeze(offerRows) };
}

export interface InstrumentedRealSolverHandle {
  readonly solver: SolverHandle;
  readonly ready: Promise<void>;
  readonly liveWallet: () => WalletResult | null;
  readonly submissionCount: () => number;
  readonly walletBoundaries: () => RealWalletBoundarySnapshot;
  readonly stockSnapshot: () => RealStockSnapshot;
  readonly evidenceFailures: () => readonly string[];
  flushEvidence: () => Promise<RealSolverEvidenceSummary>;
  stop: (reason?: string) => Promise<void>;
}

export function realSolverSignalExitCode(signal: "SIGINT" | "SIGTERM"): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

export async function startInstrumentedRealSolver(
  config: RealSolverServiceConfig,
  signal?: AbortSignal,
): Promise<InstrumentedRealSolverHandle> {
  setNetworkId(net.id as any);
  globalThis.WebSocket = WebSocket;
  const telemetry = await SerializedTelemetry.create(config.telemetryPath, config.runId);
  const failures = new RealSolverEvidenceFailures();
  const recorder = new RealSolverCentralRecorder({
    ...(config.recorderUrl ? { url: config.recorderUrl } : {}),
    ...(config.recorderToken ? { token: config.recorderToken } : {}),
    timeoutMs: config.recorderTimeoutMs,
    runId: config.runId,
    failures,
  });
  const runtime = new RuntimeManifest(config.runtimePath, {
    schema: SCHEMA,
    runId: config.runId,
    networkId: net.id,
    pid: process.pid,
    api: config.api,
    ladderConfigPath: config.ladderConfigPath,
    telemetryPath: config.telemetryPath,
    centralRecorderEnabled: recorder.enabled,
    seedFingerprint: sha256(config.seed).slice(0, 16),
    startedAt: nowIso(),
  });
  await runtime.update("starting", { submissionCount: 0 });
  await telemetry.emit("service-starting", {
    networkId: net.id,
    api: config.api,
    ladderConfigPath: config.ladderConfigPath,
  });
  recorder.enqueue("service", "starting", {
    networkId: net.id,
    api: config.api,
    ladderConfigPath: config.ladderConfigPath,
  });

  const pendingEvidence = new Set<Promise<unknown>>();
  const retainEvidence = <T>(label: string, operation: Promise<T>): Promise<T | undefined> => {
    const retained = operation.catch((error) => {
      failures.add(label, error);
      return undefined;
    });
    pendingEvidence.add(retained);
    void retained.finally(() => pendingEvidence.delete(retained)).catch(() => undefined);
    return retained;
  };
  const recordLocal = (kind: RealSolverTelemetryKind, data: unknown): void => {
    retainEvidence(`local ${kind}`, Promise.resolve().then(() => telemetry.emit(kind, data)));
  };
  const recordMilestone = (
    kind: RealSolverTelemetryKind,
    data: unknown,
    phase: string,
    event: string,
  ): void => {
    recordLocal(kind, data);
    recorder.enqueue(phase, event, data);
  };
  const updateRuntime = (state: string, data: Record<string, unknown>): void => {
    retainEvidence(`runtime ${state}`, Promise.resolve().then(() => runtime.update(state, data)));
  };
  const flushPendingEvidence = async (): Promise<void> => {
    while (pendingEvidence.size > 0) await Promise.all([...pendingEvidence]);
  };

  let walletResult: WalletResult | null = null;
  let restoreWalletInstrumentation: (() => void) | null = null;
  let submitInstrumentation: SemanticsPreservingSubmitWrapper<unknown, unknown> | null = null;
  const boundaryInstrumentations = new Map<
    RealWalletBoundaryName,
    { count: () => number; flush: () => Promise<void> }
  >();
  const boundaryAvailability = Object.fromEntries(
    REAL_WALLET_BOUNDARIES.map((method) => [method, false]),
  ) as Record<RealWalletBoundaryName, boolean>;
  let activeSolver: SolverHandle | null = null;
  let stopping: Promise<void> | null = null;
  let walletBoundaryEvidenceAbandoned = false;

  const walletBoundarySnapshot = (): RealWalletBoundarySnapshot => ({
    features: {
      pathB: false,
      residualTopUps: false,
      cycles: false,
      levelsPublication: false,
    },
    methods: Object.fromEntries(
      REAL_WALLET_BOUNDARIES.map((method) => [
        method,
        {
          available: boundaryAvailability[method],
          calls: boundaryInstrumentations.get(method)?.count() ?? 0,
        },
      ]),
    ) as RealWalletBoundarySnapshot["methods"],
  });
  // Offer rows come from the live book. The removed outcome callbacks were the
  // only thing that ever pre-recorded a selected offer, and their cache was
  // consulted second anyway (`remembered ?? live`), so reading the book is what
  // this always did in practice.
  const stockSnapshot = (offerHashes: readonly string[] = []): RealStockSnapshot => {
    try {
      const offers = [...new Set(offerHashes.map((hash) => hash.toLowerCase()))].sort().map(
        (offerHash) => {
          const live = activeSolver?.validatedBook.get(offerHash) ?? activeSolver?.book.get(offerHash);
          const offer = live
            ? { offerHash, inputNullifiers: [...live.inputNullifiers].sort() }
            : undefined;
          return {
            offerHash,
            ...(offer ? { inputNullifiers: offer.inputNullifiers } : {}),
          };
        },
      );
      return buildRealStockSnapshot(activeSolver?.stock ?? null, offers);
    } catch (error) {
      failures.add("stock snapshot", error);
      return { tokens: Object.freeze([]), offers: Object.freeze([]) };
    }
  };
  const emitStockSnapshot = (event: string, offerHashes?: string[]): RealStockSnapshot => {
    const snapshot = stockSnapshot(offerHashes);
    recordMilestone("stock-snapshot", snapshot, "stock", event);
    updateRuntime("running", {
      stock: snapshot,
      walletBoundaries: walletBoundarySnapshot(),
    });
    return snapshot;
  };
  const recordWalletBoundary = (
    method: RealWalletBoundaryName,
    event: { kind: string; count: number; error?: unknown },
  ): void => {
    const kind = event.kind === "started" ? "post-invocation" : event.kind;
    const snapshot = walletBoundarySnapshot();
    recordMilestone(
      "wallet-boundary",
      {
        method,
        kind,
        calls: event.count,
        walletBoundaries: snapshot,
        ...(event.error === undefined ? {} : { error: event.error }),
      },
      "wallet-boundary",
      `${method}-${kind}`,
    );
    updateRuntime("running", { walletBoundaries: snapshot });
  };
  const flushWalletBoundaryEvidence = async (): Promise<void> => {
    if (walletBoundaryEvidenceAbandoned) return;
    const settled = await waitForRealEvidenceWithin(
      "wallet boundary evidence flush",
      Promise.all(
        [...boundaryInstrumentations].map(([method, instrumentation]) =>
          instrumentation.flush().catch((error) =>
            failures.add(`${method} evidence flush`, error)
          ),
        ),
      ),
      config.stopTimeoutMs,
      failures,
    );
    // A non-cooperative live-wallet call may outlive the production stop
    // deadline. Do not let repeated stop/flush calls wait through the same
    // evidence deadline again; flushEvidence() will fail on the retained row.
    if (!settled) walletBoundaryEvidenceAbandoned = true;
  };

  const instrumentWallet = (result: WalletResult): WalletResult => {
    if (walletResult !== null) throw new Error("runSolver attempted to build more than one wallet");
    const wallet = result.wallet as any;
    for (const required of [
      "balanceFinalizedTransaction",
      "finalizeRecipe",
      "submitTransaction",
      "calculateTransactionFee",
    ] as const) {
      if (typeof wallet?.[required] !== "function") {
        throw new Error(`real solver wallet exposes no ${required} method`);
      }
    }
    const restorations: Array<() => void> = [];
    const install = (method: RealWalletBoundaryName, wrapped: (...args: any[]) => unknown): void => {
      const hadOwn = Object.prototype.hasOwnProperty.call(wallet, method);
      const ownDescriptor = Object.getOwnPropertyDescriptor(wallet, method);
      const restore = (): void => {
        try {
          if (hadOwn && ownDescriptor) Object.defineProperty(wallet, method, ownDescriptor);
          else delete wallet[method];
        } catch {
          // The solver owns wallet shutdown; restoration is hygiene only.
        }
      };
      try {
        if (!Reflect.set(wallet, method, wrapped) || wallet[method] !== wrapped) {
          throw new Error(`real solver wallet ${method} method is not instrumentable`);
        }
      } catch (error) {
        restore();
        throw error;
      }
      restorations.push(restore);
      boundaryAvailability[method] = true;
    };

    for (const method of REAL_WALLET_BOUNDARIES) {
      if (method === "submitTransaction" || typeof wallet[method] !== "function") continue;
      const original = wallet[method] as (...args: unknown[]) => Promise<unknown>;
      const instrumentation = createSemanticsPreservingMethodWrapper({
        label: method,
        receiver: wallet,
        original,
        failures,
        observe: (event) => {
          recordWalletBoundary(method, {
            kind: event.kind,
            count: event.count,
            ...(event.kind === "failed" ? { error: event.error } : {}),
          });
        },
      });
      boundaryInstrumentations.set(method, instrumentation);
      try {
        install(method, instrumentation.invoke);
      } catch (error) {
        for (const restore of restorations.reverse()) restore();
        throw error;
      }
    }

    const original = wallet.submitTransaction as (transaction: unknown) => Promise<unknown>;
    const inspections = new Map<number, Readonly<RealSubmissionInspection>>();
    submitInstrumentation = createSemanticsPreservingSubmitWrapper({
      receiver: wallet,
      original,
      failures,
      observe: async (event) => {
        recordWalletBoundary("submitTransaction", {
          kind: event.kind,
          count: event.count,
          ...(event.kind === "failed" ? { error: event.error } : {}),
        });
        if (event.kind === "started") {
          let inspection = inspectSubmission(event.transaction, event.count);
          try {
            inspection = await attachExactProtocolFee(
              wallet,
              event.transaction,
              inspection,
              Math.min(config.walletOperationTimeoutMs, config.stopTimeoutMs),
            );
          } catch (error) {
            failures.add(`submit ${event.count} exact protocol fee`, error);
          }
          inspections.set(event.count, inspection);
          if (inspection.inspectionErrors.length > 0) {
            failures.add(
              `submit ${event.count} immutable inspection`,
              new Error(inspection.inspectionErrors.join("; ")),
            );
          }
          const postInvocation = { ...inspection, boundary: "post-invocation" };
          recordMilestone("submit-started", postInvocation, "submission", "post-invocation");
          updateRuntime("running", {
            submissionCount: event.count,
            lastSubmission: postInvocation,
            walletBoundaries: walletBoundarySnapshot(),
          });
          return;
        }

        const inspection = inspections.get(event.count) ?? inspectSubmission(event.transaction, event.count);
        if (event.kind === "succeeded") {
          const resultIdentity = submissionResultIdentity(event.result);
          recordMilestone(
            "submit-succeeded",
            { ...inspection, result: resultIdentity },
            "submission",
            "succeeded",
          );
          updateRuntime("running", {
            lastSubmissionOutcome: { kind: "succeeded", count: event.count, result: resultIdentity },
          });
        } else {
          recordMilestone(
            "submit-failed",
            { ...inspection, error: event.error },
            "submission",
            "failed",
          );
          updateRuntime("running", {
            lastSubmissionOutcome: { kind: "failed", count: event.count, error: event.error },
          });
        }
        inspections.delete(event.count);
      },
    });
    boundaryInstrumentations.set("submitTransaction", submitInstrumentation);
    try {
      install("submitTransaction", submitInstrumentation.submit);
    } catch (error) {
      for (const restore of restorations.reverse()) restore();
      throw error;
    }
    restoreWalletInstrumentation = () => {
      for (const restore of restorations.reverse()) restore();
    };
    walletResult = result;
    recordMilestone("wallet-built", {
      unshieldedAddress: result.unshieldedAddress,
      seedFingerprint: sha256(config.seed).slice(0, 16),
      walletBoundaries: walletBoundarySnapshot(),
    }, "wallet", "built");
    updateRuntime("starting", { walletBoundaries: walletBoundarySnapshot() });
    return result;
  };

  const walletDependencies: SolverWalletDependencies = {
    buildWallet: async (seed: string) => instrumentWallet(await buildWallet(seed)),
    waitForSync,
    shieldedBalances,
    shieldedKeys,
  };

  let solver: SolverHandle;
  try {
    solver = await runSolver({
      api: config.api,
      seed: config.seed,
      dryRun: false,
      ladderConfigPath: config.ladderConfigPath,
      ...(config.relayUrl ? { relayUrl: config.relayUrl } : {}),
      ...(config.relayAuthToken ? { relayAuthToken: config.relayAuthToken } : {}),
      startupTimeoutMs: config.startupTimeoutMs,
      walletOperationTimeoutMs: config.walletOperationTimeoutMs,
      stopTimeoutMs: config.stopTimeoutMs,
      ...(signal ? { signal } : {}),
      walletDependencies,
      log: (message) => {
        recordLocal("solver-log", { message });
        if (/^\[solver\]\s+FILL\s/.test(message)) {
          recorder.enqueue("execution", "candidate-selected", { message });
        }
      },
      // No onValidationTrace/onOutcome/onMatchOutcome: `SolverOptions` has not
      // had them since N5, so they were dead weight the type system could not
      // see. See the removal note at the top of this file.
    });
    activeSolver = solver;
  } catch (error) {
    const startupRestore = restoreWalletInstrumentation as (() => void) | null;
    startupRestore?.();
    recordMilestone("service-stopped", { startupError: error }, "service", "startup-failed");
    updateRuntime("failed", { error });
    await flushWalletBoundaryEvidence();
    await flushPendingEvidence();
    await recorder.flush();
    await telemetry.flush().catch((e) => failures.add("startup local telemetry flush", e));
    await runtime.flush().catch((e) => failures.add("startup runtime flush", e));
    throw error;
  }

  const startupSubmitInstrumentation = submitInstrumentation as
    | SemanticsPreservingSubmitWrapper<unknown, unknown>
    | null;
  updateRuntime("running", {
    ready: false,
    submissionCount: startupSubmitInstrumentation?.count() ?? 0,
  });
  const ready = solver.ready.then(
    () => {
      recordMilestone("solver-ready", {
        rawBookSize: solver.book.size,
        validatedBookSize: solver.validatedBook.size,
      }, "service", "ready");
      updateRuntime("running", {
        ready: true,
        submissionCount: submitInstrumentation?.count() ?? 0,
      });
    },
    (error) => {
      recordMilestone("solver-ready-failed", { error }, "service", "ready-failed");
      updateRuntime("failed", { ready: false, error });
      throw error;
    },
  );
  void ready.catch(() => undefined);

  const stop = (reason = "requested"): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      const submissionCount = submitInstrumentation?.count() ?? 0;
      recordMilestone(
        "service-stopping",
        { reason, submissionCount },
        "service",
        "stopping",
      );
      updateRuntime("stopping", { reason, submissionCount });
      let stopError: unknown;
      try {
        await solver.stop();
      } catch (error) {
        stopError = error;
      } finally {
        restoreWalletInstrumentation?.();
        restoreWalletInstrumentation = null;
      }
      // Solver-wide token rows only: the per-offer rows needed a selected-offer
      // source that the removed outcome callbacks never actually supplied.
      const terminalStock = emitStockSnapshot("terminal", []);
      recordMilestone("service-stopped", {
        reason,
        submissionCount,
        walletBoundaries: walletBoundarySnapshot(),
        stock: terminalStock,
        ...(stopError === undefined ? {} : { error: stopError }),
      }, "service", "stopped");
      await flushWalletBoundaryEvidence();
      await flushPendingEvidence();
      await recorder.flush();
      await telemetry.flush().catch((e) => failures.add("stop local telemetry flush", e));
      updateRuntime(stopError === undefined ? "stopped" : "failed", {
        reason,
        ready: false,
        submissionCount,
        telemetryCount: telemetry.count,
        centralRecorderEnabled: recorder.enabled,
        lastCentralSequence: recorder.lastSequence,
        walletBoundaries: walletBoundarySnapshot(),
        stock: terminalStock,
        evidenceFailures: failures.messages(),
        ...(stopError === undefined ? {} : { error: stopError }),
      });
      await flushPendingEvidence();
      await runtime.flush().catch((e) => failures.add("stop runtime flush", e));
      // Evidence failures belong to flushEvidence(), not the production
      // lifecycle. Preserve the solver's exact stop failure if it had one.
      if (stopError !== undefined) throw stopError;
    })();
    return stopping;
  };

  const flushEvidence = async (): Promise<RealSolverEvidenceSummary> => {
    await flushWalletBoundaryEvidence();
    await flushPendingEvidence();
    await recorder.flush();
    await flushPendingEvidence();
    await telemetry.flush().catch((e) => failures.add("local telemetry flush", e));
    await runtime.flush().catch((e) => failures.add("runtime manifest flush", e));
    failures.assertNone();
    return {
      localEventCount: telemetry.count,
      centralRecorderEnabled: recorder.enabled,
      lastCentralSequence: recorder.lastSequence,
      submissionCount: submitInstrumentation?.count() ?? 0,
      walletBoundaries: walletBoundarySnapshot(),
      stock: stockSnapshot(),
      failures: Object.freeze(failures.messages()),
    };
  };

  return {
    solver,
    ready,
    liveWallet: () => walletResult,
    submissionCount: () => submitInstrumentation?.count() ?? 0,
    walletBoundaries: walletBoundarySnapshot,
    stockSnapshot,
    evidenceFailures: () => Object.freeze(failures.messages()),
    flushEvidence,
    stop,
  };
}

async function runCli(): Promise<void> {
  if (process.argv[2] !== "run") {
    throw new Error("usage: solver-offerfiles-real-solver-service.ts run");
  }
  const startup = new AbortController();
  let service: InstrumentedRealSolverHandle | null = null;
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
  let resolveTerminal!: () => void;
  let rejectTerminal!: (error: unknown) => void;
  const terminal = new Promise<void>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  const finish = (next: "SIGINT" | "SIGTERM"): void => {
    if (receivedSignal) return;
    receivedSignal = next;
    startup.abort(new Error(`real solver received ${next}`));
    if (service) service.stop(next).then(resolveTerminal, rejectTerminal);
  };
  const onTerm = (): void => finish("SIGTERM");
  const onInt = (): void => finish("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  let failure: unknown;
  try {
    service = await startInstrumentedRealSolver(readRealSolverServiceConfig(), startup.signal);
    if (receivedSignal) {
      await service.stop(receivedSignal);
    } else {
      void service.ready.catch(async (error) => {
        await service?.stop("ready-failed").catch(() => undefined);
        rejectTerminal(error);
      });
      await terminal;
    }
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  }

  if (service) {
    try {
      await service.flushEvidence();
    } catch (evidenceError) {
      failure = failure === undefined
        ? evidenceError
        : new AggregateError([failure, evidenceError], "solver work and evidence flush both failed");
    }
  }

  if (receivedSignal) {
    if (failure !== undefined) {
      console.error(
        `[real-solver] ${receivedSignal} cleanup/evidence: ` +
          `${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`,
      );
    }
    process.exitCode = realSolverSignalExitCode(receivedSignal);
    return;
  }
  if (failure !== undefined) throw failure;
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(`[real-solver] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
