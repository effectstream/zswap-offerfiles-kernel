// Node HTTP API helpers: submit offers and read them back. Reading offers back
// from GET /v1/offers (and reconstructing the tx from the blob the API serves)
// is the faithful path — it exercises the Celestia fetch + validate + index +
// serve primitives, not an in-memory shortcut.

import { Transaction, type FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { createHash } from "node:crypto";

const API = process.env["ZSWAP_API"] ?? "http://127.0.0.1:9999";

const resolveApi = (override?: string): string => override ?? API;

/** Every finite REST request must have an absolute deadline.  This is kept
 * here, rather than at individual call sites, so a new API helper cannot
 * accidentally introduce an unbounded fetch. */
export const DEFAULT_API_TIMEOUT_MS = 15_000;

export type ApiFailureKind = "timeout" | "aborted" | "network" | "http" | "malformed";

/** A typed boundary failure.  Callers must not turn any of these into a
 * business-domain state such as `live`; transport uncertainty is its own
 * explicit state. */
export class ApiRequestError extends Error {
  readonly kind: ApiFailureKind;
  readonly operation: string;
  readonly status?: number;
  readonly rootCause?: unknown;

  constructor(
    kind: ApiFailureKind,
    operation: string,
    message: string,
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(`${operation}: ${message}`);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.operation = operation;
    this.status = opts.status;
    this.rootCause = opts.cause;
  }
}

export interface ApiRequestOptions {
  api?: string;
  /** Absolute wall-clock budget for fetch plus body parsing. */
  timeoutMs?: number;
  /** Optional owner cancellation, composed with the absolute deadline. */
  signal?: AbortSignal;
}

export type ApiTarget = string | ApiRequestOptions | undefined;

const requestOptions = (target: ApiTarget): Required<Pick<ApiRequestOptions, "timeoutMs">> & ApiRequestOptions => {
  const opts = typeof target === "string" ? { api: target } : (target ?? {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`API timeout must be a positive finite number, got ${timeoutMs}`);
  }
  return { ...opts, timeoutMs };
};

/** Run one complete request (including body consumption) under a deadline.
 * Promise.race is intentional: a faulty fetch test double may ignore its
 * AbortSignal, and the client must still settle on time. */
async function withRequestDeadline<T>(
  operation: string,
  target: ApiTarget,
  run: (signal: AbortSignal, api: string) => Promise<T>,
): Promise<T> {
  const opts = requestOptions(target);
  const controller = new AbortController();
  const timeoutError = new ApiRequestError(
    "timeout",
    operation,
    `timed out after ${opts.timeoutMs} ms`,
  );
  let timedOut = false;

  const onOwnerAbort = (): void => {
    controller.abort(opts.signal?.reason);
  };
  if (opts.signal?.aborted) onOwnerAbort();
  else opts.signal?.addEventListener("abort", onOwnerAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, opts.timeoutMs);

  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => {
      if (timedOut) {
        reject(timeoutError);
        return;
      }
      reject(
        new ApiRequestError("aborted", operation, "cancelled by request owner", {
          cause: controller.signal.reason,
        }),
      );
    };
    if (controller.signal.aborted) rejectOnAbort();
    else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal, resolveApi(opts.api))),
      aborted,
    ]);
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    if (timedOut) throw timeoutError;
    if (controller.signal.aborted) {
      throw new ApiRequestError("aborted", operation, "cancelled by request owner", {
        cause: err,
      });
    }
    throw new ApiRequestError("network", operation, err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOwnerAbort);
    if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

const httpError = (operation: string, status: number): ApiRequestError =>
  new ApiRequestError("http", operation, `HTTP ${status}`, { status });

async function parseJson(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    throw new ApiRequestError("malformed", operation, "response body is not valid JSON", {
      cause: err,
    });
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalOfferHash = (hash: string, operation: string): string => {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new ApiRequestError(
      "malformed",
      operation,
      "requested offer hash must be exactly 64 lowercase hexadecimal characters",
    );
  }
  return hash;
};

/** Decode a MIP-0005 offer and return its canonical content identity. */
export const hashOfferBlob = (blob: string, operation = "offer blob identity"): string => {
  try {
    return createHash("sha256").update(OfferFiles.decode(blob)).digest("hex");
  } catch (err) {
    throw new ApiRequestError("malformed", operation, "offerBech32 is not a valid MIP-0005 blob", {
      cause: err,
    });
  }
};

/** Assert both sides of the content-addressed offer contract. Kept public so
 * consumers can apply the same binding to blobs already cached in memory. */
export function assertOfferBlobIdentity(
  blob: string,
  expectedHash: string,
  operation = "offer blob identity",
): void {
  const canonical = canonicalOfferHash(expectedHash, operation);
  const actual = hashOfferBlob(blob, operation);
  if (actual !== canonical) {
    throw new ApiRequestError(
      "malformed",
      operation,
      "offerBech32 content hash does not match the requested offerId",
    );
  }
}

export interface SubmitResult {
  status: number;
  body: any;
}

export async function submitOffer(blob: string, target?: ApiTarget): Promise<SubmitResult> {
  const operation = "POST /v1/offers";
  return withRequestDeadline(operation, target, async (signal, api) => {
    const r = await fetch(`${api}/v1/offers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: blob }),
      signal,
    });
    const text = await r.text();
    let body: any = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // Preserve the old helper contract: non-JSON error/success bodies are
        // returned as text for the caller to classify.
      }
    }
    return { status: r.status, body };
  });
}

export interface ApiTokenLeg { token: string; amount: string; type: string }
export interface ApiZswap {
  version: 1;
  offerId: string | null;
  offerBech32?: string;
  blobChars?: number;
  blockHeight?: number | string;  // effectstream L2 block, not a Celestia height
  computed: {
    gives: ApiTokenLeg[];
    wants: ApiTokenLeg[];
    expiresAt?: string | null;
    inputNullifiers: string[];
    firstSeenAt?: string | null;
    status: string;
  };
}

export type ApiZswapDetail = ApiZswap & { offerBech32: string };

export interface ApiZswapsPage {
  offers: ApiZswap[];
  nextCursor: string | null;
}

/** One page; pass after_hash (= previous nextCursor) to continue. */
export async function getZswapsPage(
  params: {
    token?: string;
    limit?: number;
    after_hash?: string;
    api?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ApiZswapsPage> {
  const q = new URLSearchParams();
  if (params.token) q.set("token", params.token);
  if (params.after_hash) q.set("after_hash", params.after_hash);
  q.set("limit", String(params.limit ?? 100));
  const operation = "GET /v1/offers";
  return withRequestDeadline(operation, params, async (signal, api) => {
    const r = await fetch(`${api}/v1/offers?${q.toString()}`, { signal });
    if (!r.ok) throw httpError(operation, r.status);
    const body = await parseJson(r, operation);
    if (
      !record(body) ||
      !Array.isArray(body.offers) ||
      !(body.nextCursor === null || typeof body.nextCursor === "string")
    ) {
      throw new ApiRequestError("malformed", operation, "expected { offers, nextCursor }");
    }
    return body as unknown as ApiZswapsPage;
  });
}

/** Convenience: first page's offers (enough for e2e books of < limit). */
export async function getZswaps(
  params: {
    token?: string;
    limit?: number;
    api?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ApiZswap[]> {
  return (await getZswapsPage(params)).offers;
}

/** The list is blob-free; the blob is served per-offer by content hash. */
export async function getZswapByHash(hash: string, target?: ApiTarget): Promise<ApiZswapDetail> {
  const operation = `GET /v1/offers/${hash}`;
  const expectedHash = canonicalOfferHash(hash, operation);
  return withRequestDeadline(operation, target, async (signal, api) => {
    const r = await fetch(`${api}/v1/offers/${expectedHash}`, { signal });
    if (!r.ok) throw httpError(operation, r.status);
    const body = await parseJson(r, operation);
    if (
      !record(body) ||
      typeof body.offerId !== "string" ||
      body.offerId !== expectedHash ||
      typeof body.offerBech32 !== "string" ||
      body.offerBech32.length === 0
    ) {
      throw new ApiRequestError(
        "malformed",
        operation,
        "offer detail is not bound to the requested offerId",
      );
    }
    assertOfferBlobIdentity(body.offerBech32, expectedHash, operation);
    return body as unknown as ApiZswapDetail;
  });
}

/** Read-time classification. `unknown` is a terminally ambiguous archived row,
 * never positive settlement evidence. */
export type OfferStatus = "live" | "consumed" | "cancelled" | "expired" | "unknown" | "not_found";

export interface OfferStatusResult {
  offerId?: string;
  status: OfferStatus;
}

export type IdentifiedOfferStatusResult = OfferStatusResult & { offerId: string };

const OFFER_STATUSES = new Set<OfferStatus>([
  "live",
  "consumed",
  "cancelled",
  "expired",
  "unknown",
  "not_found",
]);

function parseStatusResult(
  body: unknown,
  operation: string,
  expectedHash?: string,
): OfferStatusResult {
  if (!record(body) || typeof body.status !== "string" || !OFFER_STATUSES.has(body.status as OfferStatus)) {
    throw new ApiRequestError("malformed", operation, "unknown or missing offer status");
  }
  if (body.offerId !== undefined && typeof body.offerId !== "string") {
    throw new ApiRequestError("malformed", operation, "offerId must be a string when present");
  }
  if (expectedHash !== undefined) {
    if (typeof body.offerId !== "string" || body.offerId.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new ApiRequestError("malformed", operation, "status response is not bound to the requested offer");
    }
  }
  return {
    ...(typeof body.offerId === "string" ? { offerId: body.offerId } : {}),
    status: body.status as OfferStatus,
  };
}

export async function getOfferStatus(
  hash: string,
  target?: ApiTarget,
): Promise<IdentifiedOfferStatusResult> {
  const operation = `GET /v1/offers/${hash}/status`;
  return withRequestDeadline(operation, target, async (signal, api) => {
    const r = await fetch(`${api}/v1/offers/${hash}/status`, { signal });
    if (!r.ok) throw httpError(operation, r.status);
    return parseStatusResult(await parseJson(r, operation), operation, hash) as IdentifiedOfferStatusResult;
  });
}

/** Bulk status by blob. The endpoint caps a batch at 50, so longer inputs are
 *  chunked here and the results concatenated in input order. */
export async function postOffersStatus(
  blobs: string[],
  target?: ApiTarget,
): Promise<OfferStatusResult[]> {
  const out: OfferStatusResult[] = [];
  for (let i = 0; i < blobs.length; i += 50) {
    const chunk = blobs.slice(i, i + 50);
    const operation = "POST /v1/offers/status";
    const statuses = await withRequestDeadline(operation, target, async (signal, api) => {
      const r = await fetch(`${api}/v1/offers/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk.length === 1 ? { offer: chunk[0] } : { offers: chunk }),
        signal,
      });
      if (!r.ok) throw httpError(operation, r.status);
      const body = await parseJson(r, operation);
      const raw = record(body) && Array.isArray(body.statuses) ? body.statuses : [body];
      if (raw.length !== chunk.length) {
        throw new ApiRequestError("malformed", operation, "status result count does not match request");
      }
      return raw.map((item) => parseStatusResult(item, operation));
    });
    out.push(...statuses);
  }
  return out;
}

/** Rebuild a finalized offer tx from the blob the API serves (the same blob
 *  that round-tripped through Celestia and was re-validated at ingestion). */
export function reconstructOffer(transactionHex: string): FinalizedTransaction {
  return Transaction.deserialize(
    "signature",
    "proof",
    "binding",
    OfferFiles.decode(transactionHex),
  ) as unknown as FinalizedTransaction;
}

// ── SSE stream ───────────────────────────────────────────────────────────────

/** Frames on GET /v1/offers/stream: the node's AppEvent plus a server-stamped
 *  `timestamp`. Frames carry no `event:` field, so dispatch on `type`.
 *  `offerId` is the node's internal row id, NOT the content hash — correlate
 *  with REST by `offerHash`. */
export type SseEvent =
  | { type: "connected"; timestamp: number }
  | {
      type: "offer_indexed";
      offerId: number;
      offerHash: string;
      blockHeight: number | string;
      gives: unknown[];
      wants: unknown[];
      timestamp: number;
    }
  | {
      type: "offer_consumed";
      offerId: number;
      offerHash?: string;
      nullifier?: string;
      unshieldedSpend?: { owner: string; intentHash: string; outputNo: number };
      timestamp: number;
    }
  | { type: "offer_expired"; offerId: number; offerHash?: string; timestamp: number }
  | { type: "token_minted"; name: string; color: string; kind?: string; timestamp: number }
  | {
      type: "offer_rejected";
      code?: string;
      reason?: string;
      offerHash?: string;
      blockHeight: number | string;
      timestamp: number;
    };

export interface SseStreamOpts {
  api?: string;
  /** Fires on every successful (re)connection, including the first. The stream
   *  has no replay and no Last-Event-ID, so a consumer holding derived state
   *  must treat this as "resync from REST now". */
  onOpen?: () => void;
  /** Fires after a successfully opened connection ends unexpectedly (clean
   * EOF or read failure), before reconnect backoff. Not called by close(). */
  onDisconnect?: () => void;
  onError?: (err: unknown) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Deadline for receiving the SSE response headers. The stream body is
   * intentionally long-lived and remains owned by close(). */
  connectTimeoutMs?: number;
  /** Maximum bytes retained for one frame before its blank-line separator.
   * Prevents a peer from growing the solver heap with an unterminated event. */
  maxFrameBytes?: number;
}

export interface SseStreamHandle {
  /** Abort the active connection/read, cancel reconnect backoff, and resolve
   * only after the stream lifecycle has stopped. Idempotent. */
  close: () => Promise<void>;
}

const DEFAULT_SSE_BASE_BACKOFF_MS = 500;
const DEFAULT_SSE_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_SSE_MAX_FRAME_BYTES = 256 * 1024;

/** Consume the node's SSE offer stream, reconnecting with exponential backoff
 *  and jitter until close(). */
export function openSseStream(
  onEvent: (ev: SseEvent) => void,
  opts: SseStreamOpts = {},
): SseStreamHandle {
  const base = opts.baseBackoffMs ?? DEFAULT_SSE_BASE_BACKOFF_MS;
  const max = opts.maxBackoffMs ?? DEFAULT_SSE_MAX_BACKOFF_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_SSE_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError(
      `SSE maxFrameBytes must be a positive safe integer, got ${maxFrameBytes}`,
    );
  }
  const url = `${resolveApi(opts.api)}/v1/offers/stream`;

  let stopped = false;
  let controller: AbortController | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeBackoff: (() => void) | null = null;

  const reportError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // Diagnostics are never allowed to become a stream-lifecycle failure.
    }
  };

  const dispatch = (payload: string): void => {
    let parsed: SseEvent;
    try {
      parsed = JSON.parse(payload) as SseEvent;
    } catch (err) {
      reportError(err);
      return;
    }
    try {
      onEvent(parsed);
    } catch (err) {
      reportError(err);
    }
  };

  const connect = async (owner: AbortController): Promise<Response> => {
    const operation = "GET /v1/offers/stream (connect)";
    const timeoutError = new ApiRequestError(
      "timeout",
      operation,
      `timed out after ${connectTimeoutMs} ms`,
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      owner.abort(timeoutError);
    }, connectTimeoutMs);

    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => {
        reject(
          timedOut
            ? timeoutError
            : new ApiRequestError("aborted", operation, "stream owner cancelled connection"),
        );
      };
      owner.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });

    try {
      return await Promise.race([
        fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: owner.signal,
        }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      if (rejectOnAbort) owner.signal.removeEventListener("abort", rejectOnAbort);
    }
  };

  const readFrames = async (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let reachedEof = false;
    let notifyAbort!: () => void;
    const aborted = new Promise<"aborted">((resolve) => {
      notifyAbort = () => resolve("aborted");
      if (signal.aborted) notifyAbort();
      else signal.addEventListener("abort", notifyAbort, { once: true });
    });

    try {
      for (;;) {
        // Do not rely solely on fetch's body implementation honouring abort.
        // Racing the read makes our pump terminate even for a faulty transport
        // double; reader.cancel below still asks the source to release itself.
        const next = await Promise.race([
          reader.read().then((value) => ({ kind: "read" as const, value })),
          aborted.then(() => ({ kind: "aborted" as const })),
        ]);
        if (next.kind === "aborted" || stopped) return;
        const { done, value } = next.value;
        if (done) {
          reachedEof = true;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; a chunk may split one, so only
        // consume up to the last complete separator and keep the remainder.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (encoder.encode(frame).byteLength > maxFrameBytes) {
            throw new ApiRequestError(
              "malformed",
              "GET /v1/offers/stream (read)",
              `SSE frame exceeded ${maxFrameBytes} bytes`,
            );
          }
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:") && !stopped) dispatch(line.slice(5).trim());
            // ": heartbeat" comments and any other field are ignored.
          }
        }
        if (encoder.encode(buffer).byteLength > maxFrameBytes) {
          throw new ApiRequestError(
            "malformed",
            "GET /v1/offers/stream (read)",
            `unterminated SSE frame exceeded ${maxFrameBytes} bytes`,
          );
        }
      }
    } finally {
      signal.removeEventListener("abort", notifyAbort);
      if (!reachedEof) {
        // Cancellation is advisory: a broken stream implementation may ignore
        // it or return a never-settling promise. The read pump has already
        // exited through its owned race, so observe the loser without letting
        // it hold close() or reconnect forever.
        void Promise.resolve(reader.cancel(signal.reason)).catch(() => {});
      }
      try {
        reader.releaseLock();
      } catch {
        // A non-standard reader may retain a pending read after cancellation.
      }
    }
  };

  const waitForBackoff = (delay: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const finish = (): void => {
        if (backoffTimer !== null) clearTimeout(backoffTimer);
        backoffTimer = null;
        if (wakeBackoff === finish) wakeBackoff = null;
        resolve();
      };
      wakeBackoff = finish;
      backoffTimer = setTimeout(finish, delay);
    });

  const cancelBackoff = (): void => {
    wakeBackoff?.();
  };

  const lifecycle = (async () => {
    let attempt = 0;
    while (!stopped) {
      const connection = new AbortController();
      controller = connection;
      let opened = false;
      try {
        const resp = await connect(connection);
        if (stopped) {
          await resp.body?.cancel().catch(() => {});
          return;
        }
        if (!resp.ok || !resp.body) throw new Error(`SSE ${url} -> ${resp.status}`);
        attempt = 0;
        opened = true;
        try {
          opts.onOpen?.();
        } catch (err) {
          reportError(err);
        }
        if (!stopped) await readFrames(resp.body, connection.signal);
      } catch (err) {
        if (!stopped) reportError(err);
      } finally {
        if (opened && !stopped) {
          try {
            opts.onDisconnect?.();
          } catch (err) {
            reportError(err);
          }
        }
        if (controller === connection) controller = null;
      }
      if (stopped) return;
      // Jitter in [0.5, 1.5) so multiple solvers don't reconnect in lockstep.
      const delay = Math.floor(Math.min(max, base * 2 ** attempt) * (0.5 + Math.random()));
      attempt += 1;
      await waitForBackoff(delay);
    }
  })();

  return {
    async close(): Promise<void> {
      if (!stopped) {
        stopped = true;
        controller?.abort(new Error("SSE stream closed"));
        cancelBackoff();
      }
      await lifecycle;
    },
  };
}
