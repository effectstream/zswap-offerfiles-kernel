// Solver-side helpers for batcher-settled swaps.
//
// The batcher's `midnight-balancer` target balances DUST ONLY
// (tokenKindsToBalance:["dust"]) — it pays fees but never provides
// counterparty tokens. So a swap must be merged into ONE token-balanced
// transaction before it is handed to the batcher; the batcher then only adds
// dust, proves, and submits. No swap participant needs dust — only the batcher.

import type { FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";

const BALANCER_URL = process.env["BATCHER_SUBMIT_URL"] ?? "http://127.0.0.1:3334";

const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");

/** Merge N independently-proven offers into one atomic, token-balanced tx.
 *  Each offer must already be finalized (proven + bound) by its own owner —
 *  zswap requires each spend be proven by its key, so we prove per-owner first
 *  and only merge the proven halves. */
export function mergeFinalized(offers: FinalizedTransaction[]): FinalizedTransaction {
  if (offers.length === 0) throw new Error("mergeFinalized: no offers");
  let merged = offers[0];
  for (let i = 1; i < offers.length; i++) {
    merged = (merged as any).merge(offers[i]) as FinalizedTransaction;
  }
  return merged;
}

export interface Imbalance {
  seg: number;
  tag: string;
  raw: string;
  amount: bigint;
}

/** All per-segment token imbalances. A balanced swap leaves only `dust`
 *  (which the batcher fills); any non-dust entry means the merged tx is NOT a
 *  complete swap and must NOT be settled. */
/** Raised when a transaction's imbalances cannot be read at all.
 *
 *  Distinct from "balanced": a missing method, a changed SDK shape, or a thrown
 *  getter means the safety check did not run. Reporting that as an empty
 *  imbalance list made the guard below fail OPEN — it would wave through
 *  exactly the transactions it exists to stop. */
export class ImbalanceUnreadableError extends Error {
  constructor(reason: string) {
    super(`cannot read transaction imbalances: ${reason}`);
    this.name = "ImbalanceUnreadableError";
  }
}

const MAX_LEDGER_SEGMENT = 0xffff;

/** ledger-v8 declares token-bearing segments in three places: guaranteed
 * segment 0, intent keys, and fallible-offer keys. Segment IDs are arbitrary
 * u16 values (they are not a dense 0..N range), so guessing 0/1 is unsafe. */
export function declaredLedgerSegments(tx: FinalizedTransaction): number[] {
  if (!tx || typeof tx !== "object") {
    throw new ImbalanceUnreadableError("transaction is not an object");
  }

  const segments = new Set<number>([0]);
  for (const field of ["intents", "fallibleOffer"] as const) {
    let collection: unknown;
    try {
      collection = (tx as any)[field];
    } catch {
      throw new ImbalanceUnreadableError(`transaction.${field} could not be read`);
    }
    if (collection === undefined || collection === null) continue;
    if (!(collection instanceof Map)) {
      throw new ImbalanceUnreadableError(`transaction.${field} is not a keyed collection`);
    }
    try {
      for (const segment of (collection as any).keys() as Iterable<unknown>) {
        if (
          typeof segment !== "number" ||
          !Number.isInteger(segment) ||
          segment < 0 ||
          segment > MAX_LEDGER_SEGMENT
        ) {
          throw new ImbalanceUnreadableError(
            `transaction.${field} contains an invalid ledger segment`,
          );
        }
        segments.add(segment);
      }
    } catch (err) {
      if (err instanceof ImbalanceUnreadableError) throw err;
      throw new ImbalanceUnreadableError(`transaction.${field} keys could not be enumerated`);
    }
  }
  return [...segments].sort((a, b) => a - b);
}

export function tokenImbalances(tx: FinalizedTransaction): Imbalance[] {
  if (typeof (tx as any)?.imbalances !== "function") {
    throw new ImbalanceUnreadableError("transaction exposes no imbalances()");
  }

  const out: Imbalance[] = [];
  for (const seg of declaredLedgerSegments(tx)) {
    let m: unknown;
    try {
      m = (tx as any).imbalances(seg);
    } catch {
      throw new ImbalanceUnreadableError(`declared segment ${seg} could not be read`);
    }
    if (!(m instanceof Map)) {
      throw new ImbalanceUnreadableError(`declared segment ${seg} returned no imbalance map`);
    }
    try {
      for (const [k, v] of (m as any).entries() as Iterable<[unknown, bigint]>) {
        if (typeof v !== "bigint") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned a non-bigint amount`);
        }
        if (!k || typeof k !== "object") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned an invalid token kind`);
        }
        const tag = (k as any).tag;
        const raw = tag === "dust" ? "dust" : (k as any).raw;
        if (tag !== "dust" && tag !== "shielded" && tag !== "unshielded") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned unknown token tag`);
        }
        if (typeof raw !== "string") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned an invalid token value`);
        }
        if (v !== 0n) out.push({ seg, tag, raw, amount: v });
      }
    } catch (err) {
      if (err instanceof ImbalanceUnreadableError) throw err;
      throw new ImbalanceUnreadableError(`segment ${seg} imbalance map could not be enumerated`);
    }
  }
  return out;
}

/** Non-dust imbalances — these must be empty for a tx to be a settleable swap.
 *  (Dust imbalance is expected; the batcher covers it.) */
export function nonDustImbalances(tx: FinalizedTransaction): Imbalance[] {
  return tokenImbalances(tx).filter((i) => i.tag !== "dust");
}

export function describeImbalances(tx: FinalizedTransaction): string {
  return JSON.stringify(
    tokenImbalances(tx).map((i) => ({ seg: i.seg, tag: i.tag, raw: i.raw.slice(0, 10), amount: i.amount.toString() })),
  );
}

/** Hand a finalized, token-balanced tx to the batcher's midnight-balancer
 *  target. The batcher adds dust (fees), proves its balancing half, and submits.
 *  With confirmationLevel "wait-receipt" the call blocks until the settle
 *  receipt (or timeout). */
export interface SettleOpts {
  /** Client-side fetch abort (ms). */
  timeoutMs?: number;
  /** Server-side receipt-confirmation timeout (ms; batcher default is 60 s). */
  serverTimeoutMs?: number;
  /** "no-wait" queues and returns immediately (bulk flows that verify by
   *  effect); default "wait-receipt" blocks until the settle receipt. */
  level?: "no-wait" | "wait-receipt" | "wait-effectstream-processed";
}

export interface BatcherAcknowledgement {
  success: true;
  message: string;
  inputsProcessed?: 1;
  transactionHash?: string;
}

export class BatcherRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`batcher request timed out after ${timeoutMs} ms`);
    this.name = "BatcherRequestTimeoutError";
  }
}

/** Best-effort cleanup for a response which outlives the caller's deadline.
 * A response body can already be locked by `text()`, in which case cancel()
 * rejects. Observe that rejection so cleanup never creates an unhandled one. */
function cancelResponseBody(response: Response | undefined): void {
  try {
    const cancellation = response?.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Cleanup must not replace the request's timeout failure.
  }
}

/** The batcher's documented wait-receipt success shape. A generic HTTP 2xx,
 * truthy object, partial payload, or non-canonical transaction identity is not
 * evidence that a transaction was submitted. */
export function parseBatcherAcknowledgement(
  value: unknown,
  level: NonNullable<SettleOpts["level"]> = "wait-receipt",
): BatcherAcknowledgement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.success !== true || typeof body.message !== "string" || body.message.length === 0) {
    return null;
  }
  if (body.inputsProcessed !== 1) return null;
  // no-wait acknowledges queue admission, not settlement. Keep this explicitly
  // separate from the identity-bearing wait response used by the solver.
  if (level === "no-wait") {
    return { success: true, message: body.message, inputsProcessed: 1 };
  }

  if (typeof body.transactionHash !== "string") return null;
  const rawHash = body.transactionHash.replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(rawHash)) return null;
  return {
    success: true,
    message: body.message,
    inputsProcessed: 1,
    transactionHash: `0x${rawHash.toLowerCase()}`,
  };
}

export async function settleViaBatcher(
  tx: FinalizedTransaction,
  optsOrTimeout: number | SettleOpts = 240_000,
): Promise<{ ok: boolean; status: number; body: any }> {
  const opts: SettleOpts =
    typeof optsOrTimeout === "number" ? { timeoutMs: optsOrTimeout } : optsOrTimeout;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`batcher timeout must be a positive finite number, got ${timeoutMs}`);
  }
  const level = opts.level ?? "wait-receipt";
  // SAFETY: the batcher balances dust only. Handing it a tx with a non-dust
  // imbalance would settle an incomplete swap — consuming inputs without
  // delivering the wanted outputs (fund loss). Refuse.
  const bad = nonDustImbalances(tx);
  if (bad.length > 0) {
    throw new Error(
      `REFUSED: merged tx is not a complete swap (non-dust imbalance: ` +
        `${bad.map((i) => `${i.tag}:${i.raw.slice(0, 8)}=${i.amount}`).join(", ")})`,
    );
  }
  const hex = toHex(tx.serialize());
  const body = {
    data: {
      address: "midnight-balancer",
      addressType: -1,
      input: JSON.stringify({ tx: hex, txStage: "finalized" }),
      signature: "",
      timestamp: String(Date.now()),
      target: "midnight-balancer",
    },
    confirmationLevel: level,
    ...(opts.serverTimeoutMs !== undefined ? { timeoutMs: opts.serverTimeoutMs } : {}),
  };
  const controller = new AbortController();
  const timeoutError = new BatcherRequestTimeoutError(timeoutMs);
  let deadlineFired = false;
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadlineFired = true;
      // Reject independently of fetch so a fetch/body implementation which
      // ignores AbortSignal still cannot extend the absolute request budget.
      reject(timeoutError);
      controller.abort(timeoutError);
      cancelResponseBody(response);
    }, timeoutMs);
  });

  const request = (async (): Promise<{ ok: boolean; status: number; body: unknown }> => {
    const resp = await fetch(`${BALANCER_URL}/send-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    response = resp;
    if (deadlineFired) {
      cancelResponseBody(resp);
      throw timeoutError;
    }

    let j: unknown = null;
    try {
      const raw = await resp.text();
      if (deadlineFired) throw timeoutError;
      if (raw !== "") j = JSON.parse(raw);
    } catch (err) {
      if (deadlineFired) throw timeoutError;
      // A malformed/non-JSON body is intentionally not an acknowledgement.
    }
    const acknowledgement = parseBatcherAcknowledgement(j, level);
    return { ok: resp.ok && acknowledgement !== null, status: resp.status, body: j };
  })();

  // Promise.race observes its inputs, but retain an explicit rejection
  // observer for the timed-out request because it may settle long after this
  // function and its race have returned.
  void request.catch(() => undefined);

  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
