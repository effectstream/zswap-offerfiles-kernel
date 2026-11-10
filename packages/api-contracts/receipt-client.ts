// Strict, bounded reads for RF2's two independent settlement authorities.
//
// Relay `txId` is a finalized Substrate extrinsic hash. Backend
// `ledgerTxHash` is the inner Midnight ledger transaction hash. They are
// deliberately different fields and no function in this module compares them.

export const MAX_RECEIPT_BODY_BYTES = 64 * 1024;
export const DEFAULT_RECEIPT_TIMEOUT_MS = 15_000;

const OFFER_HASH = /^[0-9a-f]{64}$/;
const HASH_32_OPTIONAL_PREFIX = /^(?:0x)?[0-9a-fA-F]{64}$/;
const RELAY_JOB_STATUSES = new Set(["pending", "solving", "done", "error"]);
const OFFER_STATUSES = new Set(["live", "consumed", "cancelled", "expired", "not_found"]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

export class ReceiptRequestError extends Error {
  readonly kind: "timeout" | "aborted" | "network" | "http" | "malformed";
  readonly status?: number;

  constructor(
    kind: ReceiptRequestError["kind"],
    operation: string,
    detail: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(`${operation}: ${detail}`, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "ReceiptRequestError";
    this.kind = kind;
    this.status = options.status;
  }
}

export interface ReceiptRequestOptions {
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type RelayJobStatus =
  | { status: "pending" }
  | { status: "solving" }
  | { status: "done"; txId: string }
  | { status: "error"; reason: string };

export interface OfferConsumptionEvidence {
  ledgerTxHash: string;
  height: number;
}

export interface OfferConsumptionResponse {
  version: 1;
  offerId: string;
  status: "live" | "consumed" | "cancelled" | "expired" | "not_found";
  evidence?: OfferConsumptionEvidence;
}

/** Canonical journal representation for the relay's Substrate extrinsic hash. */
export function canonicalRelayExtrinsicHash(value: unknown): string | null {
  if (typeof value !== "string" || !HASH_32_OPTIONAL_PREFIX.test(value)) return null;
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

export function parseRelayJobStatus(value: unknown): RelayJobStatus | null {
  if (!record(value) || typeof value.status !== "string" || !RELAY_JOB_STATUSES.has(value.status)) {
    return null;
  }
  if (value.status === "pending" || value.status === "solving") {
    return exactKeys(value, ["status"]) ? { status: value.status } : null;
  }
  if (value.status === "done") {
    if (!exactKeys(value, ["status", "txId"])) return null;
    const txId = canonicalRelayExtrinsicHash(value.txId);
    return txId === null ? null : { status: "done", txId };
  }
  if (!exactKeys(value, ["status", "reason"]) ||
      typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 1024 ||
      value.reason.includes("\0")) {
    return null;
  }
  return { status: "error", reason: value.reason };
}

export function parseOfferConsumptionResponse(
  value: unknown,
  expectedOfferId: string,
): OfferConsumptionResponse | null {
  if (!OFFER_HASH.test(expectedOfferId) || !record(value)) return null;
  if (value.version !== 1 || value.offerId !== expectedOfferId ||
      typeof value.status !== "string" || !OFFER_STATUSES.has(value.status)) {
    return null;
  }
  const status = value.status as OfferConsumptionResponse["status"];
  if (value.evidence === undefined) {
    return exactKeys(value, ["version", "offerId", "status"])
      ? { version: 1, offerId: expectedOfferId, status }
      : null;
  }
  if (status !== "consumed" || !exactKeys(value, ["version", "offerId", "status", "evidence"]) ||
      !record(value.evidence) || !exactKeys(value.evidence, ["ledgerTxHash", "height"])) {
    return null;
  }
  const { ledgerTxHash, height } = value.evidence;
  if (typeof ledgerTxHash !== "string" || !OFFER_HASH.test(ledgerTxHash) ||
      typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) {
    return null;
  }
  return {
    version: 1,
    offerId: expectedOfferId,
    status: "consumed",
    evidence: { ledgerTxHash, height },
  };
}

function requireRequestOptions(operation: string, options: ReceiptRequestOptions): number {
  if (options.baseUrl.length === 0 || options.baseUrl.includes("\0")) {
    throw new ReceiptRequestError("malformed", operation, "base URL is empty or contains NUL");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${operation} timeout must be a positive safe integer`);
  }
  return timeoutMs;
}

async function readBoundedJson(
  response: Response,
  operation: string,
  signal: AbortSignal,
): Promise<unknown> {
  const malformed = (detail: string, cause?: unknown) =>
    new ReceiptRequestError("malformed", operation, detail, { cause });
  const length = response.headers.get("content-length");
  if (length !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(MAX_RECEIPT_BODY_BYTES)) {
      throw malformed(`response exceeds the ${MAX_RECEIPT_BODY_BYTES}-byte limit`);
    }
  }
  if (response.body === null) throw malformed("response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RECEIPT_BODY_BYTES) {
        cancel();
        throw malformed(`response exceeds the ${MAX_RECEIPT_BODY_BYTES}-byte limit`);
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ReceiptRequestError) throw error;
    if (signal.aborted) throw signal.reason;
    throw malformed("response body could not be read", error);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw malformed("response body is not valid UTF-8 JSON", error);
  }
}

async function getBoundedJson(
  operation: string,
  url: string,
  options: ReceiptRequestOptions,
): Promise<unknown> {
  const timeoutMs = requireRequestOptions(operation, options);
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  let timedOut = false;
  const abortOwner = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortOwner();
  else options.signal?.addEventListener("abort", abortOwner, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${operation} timed out`));
  }, timeoutMs);
  let rejectAbort!: (error: ReceiptRequestError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(new ReceiptRequestError(
    timedOut ? "timeout" : "aborted",
    operation,
    timedOut ? `timed out after ${timeoutMs} ms` : "cancelled by request owner",
    { cause: controller.signal.reason },
  ));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        let response: Response;
        try {
          response = await fetchImpl(url, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new ReceiptRequestError("network", operation, String(error), { cause: error });
        }
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* best effort */ }
          throw new ReceiptRequestError("http", operation, `HTTP ${response.status}`, {
            status: response.status,
          });
        }
        return readBoundedJson(response, operation, controller.signal);
      }),
      aborted,
    ]);
  } catch (error) {
    if (error instanceof ReceiptRequestError) throw error;
    if (controller.signal.aborted) {
      throw new ReceiptRequestError(
        timedOut ? "timeout" : "aborted",
        operation,
        timedOut ? `timed out after ${timeoutMs} ms` : "cancelled by request owner",
        { cause: error },
      );
    }
    throw new ReceiptRequestError("network", operation, String(error), { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortOwner);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function getRelayJobStatus(
  jobId: string,
  options: ReceiptRequestOptions,
): Promise<RelayJobStatus> {
  const operation = "GET relay /jobs/:jobId";
  if (jobId.length === 0 || jobId.length > 512 || jobId.includes("\0")) {
    throw new ReceiptRequestError("malformed", operation, "jobId is empty, oversized, or contains NUL");
  }
  const body = await getBoundedJson(
    operation,
    `${options.baseUrl.replace(/\/$/, "")}/jobs/${encodeURIComponent(jobId)}`,
    options,
  );
  const parsed = parseRelayJobStatus(body);
  if (parsed === null) throw new ReceiptRequestError("malformed", operation, "response violates the pinned relay contract");
  return parsed;
}

export async function getOfferConsumptionEvidence(
  offerId: string,
  options: ReceiptRequestOptions,
): Promise<OfferConsumptionResponse> {
  const operation = "GET backend /v1/offers/:hash/consumption";
  if (!OFFER_HASH.test(offerId)) {
    throw new ReceiptRequestError("malformed", operation, "offerId must be canonical lowercase 32-byte hex");
  }
  const body = await getBoundedJson(
    operation,
    `${options.baseUrl.replace(/\/$/, "")}/v1/offers/${offerId}/consumption`,
    options,
  );
  const parsed = parseOfferConsumptionResponse(body, offerId);
  if (parsed === null) throw new ReceiptRequestError("malformed", operation, "response is unbound or noncanonical");
  return parsed;
}
