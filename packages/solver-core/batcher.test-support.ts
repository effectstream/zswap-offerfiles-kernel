// Legacy pre-relay network surface retained only for its historical unit test
// and manual test-support probe. This module is deliberately absent from the
// package exports map and must never be imported by production source.

import type { FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";
import { nonDustImbalances } from "./batcher.ts";

const BALANCER_URL = process.env["BATCHER_SUBMIT_URL"] ?? "http://127.0.0.1:3334";
const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");

export function batcherInputFingerprint(tx: FinalizedTransaction): string {
  const input = JSON.stringify({ tx: toHex(tx.serialize()), txStage: "finalized" });
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface SettleOpts {
  timeoutMs?: number;
  serverTimeoutMs?: number;
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

function cancelResponseBody(response: Response | undefined): void {
  try {
    const cancellation = response?.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch { /* cleanup cannot replace the timeout */ }
}

export function parseBatcherAcknowledgement(
  value: unknown,
  level: NonNullable<SettleOpts["level"]> = "wait-receipt",
): BatcherAcknowledgement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.success !== true || typeof body.message !== "string" || body.message.length === 0 ||
      body.inputsProcessed !== 1) return null;
  if (level === "no-wait") return { success: true, message: body.message, inputsProcessed: 1 };
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
  const opts = typeof optsOrTimeout === "number" ? { timeoutMs: optsOrTimeout } : optsOrTimeout;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`batcher timeout must be a positive finite number, got ${timeoutMs}`);
  }
  const level = opts.level ?? "wait-receipt";
  const bad = nonDustImbalances(tx);
  if (bad.length > 0) {
    throw new Error(`REFUSED: merged tx is not a complete swap (non-dust imbalance: ${
      bad.map((i) => `${i.tag}:${i.raw.slice(0, 8)}=${i.amount}`).join(", ")})`);
  }
  const body = {
    data: {
      address: "midnight-balancer",
      addressType: -1,
      input: JSON.stringify({ tx: toHex(tx.serialize()), txStage: "finalized" }),
      signature: "",
      timestamp: String(Date.now()),
      target: "midnight-balancer",
    },
    confirmationLevel: level,
    ...(opts.serverTimeoutMs === undefined ? {} : { timeoutMs: opts.serverTimeoutMs }),
  };
  const controller = new AbortController();
  const timeoutError = new BatcherRequestTimeoutError(timeoutMs);
  let deadlineFired = false;
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      deadlineFired = true;
      reject(timeoutError);
      controller.abort(timeoutError);
      cancelResponseBody(response);
    }, timeoutMs);
  });
  const request = (async (): Promise<{ ok: boolean; status: number; body: unknown }> => {
    const result = await fetch(`${BALANCER_URL}/send-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    response = result;
    if (deadlineFired) {
      cancelResponseBody(result);
      throw timeoutError;
    }
    let parsed: unknown = null;
    try {
      const raw = await result.text();
      if (deadlineFired) throw timeoutError;
      if (raw !== "") parsed = JSON.parse(raw);
    } catch {
      if (deadlineFired) throw timeoutError;
    }
    return {
      ok: result.ok && parseBatcherAcknowledgement(parsed, level) !== null,
      status: result.status,
      body: parsed,
    };
  })();
  void request.catch(() => undefined);
  try { return await Promise.race([request, deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
