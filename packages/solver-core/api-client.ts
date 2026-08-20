// Node HTTP API helpers: submit offers and read them back. Reading offers back
// from GET /v1/offers (and reconstructing the tx from the blob the API serves)
// is the faithful path — it exercises the Celestia fetch + validate + index +
// serve primitives, not an in-memory shortcut.

import { Transaction, type FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { createHash } from "node:crypto";

import {
  OFFER_VALIDATION_PROFILE,
  OFFER_VALIDATION_SCHEMA_VERSION,
  parseOfferValidationVerdict,
  type OfferValidationVerdict,
} from "./validation-contract.ts";
import {
  MAX_OFFER_UPDATES_FRAME_BYTES,
  OFFER_UPDATES_PATH,
  OFFER_UPDATES_READY_SEQ,
  decodeOfferUpdatesFrame,
  followsInSequence,
} from "./offer-updates-contract.ts";

const API = process.env["ZSWAP_API"] ?? "http://127.0.0.1:9999";

const resolveApi = (override?: string): string => override ?? API;

/** Every finite REST request must have an absolute deadline.  This is kept
 * here, rather than at individual call sites, so a new API helper cannot
 * accidentally introduce an unbounded fetch. */
export const DEFAULT_API_TIMEOUT_MS = 15_000;

/** The sync-health response is a small control-plane document. Bound its
 * complete decoded body so a faulty endpoint cannot make the solver retain an
 * arbitrarily large response while deciding whether trading is safe. */
export const MAX_SYNC_HEALTH_BODY_BYTES = 1024 * 1024;
export const MAX_OFFER_VALIDATION_RESPONSE_BYTES = 64 * 1024;

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

export interface OfferValidationApiOptions extends ApiRequestOptions {
  /** Existing solver bearer credential. Validation is authenticated even when
   * optional levels publication is disabled. */
  authToken: string;
}

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

async function parseBoundedJson(
  response: Response,
  operation: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const malformed = (message: string, cause?: unknown): ApiRequestError =>
    new ApiRequestError("malformed", operation, message, { cause });
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw malformed("response Content-Length is not a canonical non-negative integer");
    }
    // Compare decimal tokens before converting them: even a hostile, very long
    // header remains bounded work and cannot overflow Number or BigInt parsing.
    const maximum = String(maxBytes);
    if (
      contentLength.length > maximum.length ||
      (contentLength.length === maximum.length && contentLength > maximum)
    ) {
      throw malformed(`response body exceeds the ${maxBytes}-byte limit`);
    }
  }

  const body = response.body;
  if (body === null) throw malformed("response body is not valid JSON");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  const cancelReader = (): void => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (part.done) {
        complete = true;
        break;
      }
      total += part.value.byteLength;
      if (total > maxBytes) {
        cancelReader();
        throw malformed(`response body exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(part.value);
    }
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    if (signal.aborted) throw signal.reason;
    throw malformed("response body could not be read", err);
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!complete) cancelReader();
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (err) {
    throw malformed("response body is not valid JSON", err);
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

// ── Backend projection currentness ────────────────────────────────────────

/** The current `/v1/health/sync` wire contract has no body-level schema
 * version. The `/v1` route is therefore the only version discriminator. Keep
 * this parser strict for every field the solver consumes and return a
 * projected value so diagnostic fields added by the backend cannot silently
 * enter the solver's trusted state. */
export type BackendSyncStatus = "ok" | "syncing" | "error";

export interface BackendNtpSyncPosition {
  current: number;
  tip: number;
  pct: number | null;
  lagBlocks: number;
  lagSeconds: number;
}

export interface BackendChainSyncPosition {
  current: number | null;
  fetched: number | null;
  tip: number | null;
  pct: number | null;
  lagBlocks: number | null;
}

/** Canonical decimal generation token for the latest merged Effectstream/L2
 * block. The backend can serialize its DB integer as a JSON number or string;
 * the client normalizes both without a lossy Number coercion. */
export interface BackendL2Generation {
  height: string;
}

export interface BackendSyncHealth {
  ts: number;
  status: BackendSyncStatus;
  blockL2: BackendL2Generation | null;
  ntp: BackendNtpSyncPosition;
  midnight: BackendChainSyncPosition;
  celestia: BackendChainSyncPosition;
}

export type CurrentBackendSyncHealth = BackendSyncHealth & {
  status: "ok";
  blockL2: BackendL2Generation;
  midnight: BackendChainSyncPosition & {
    current: number;
    tip: number;
    lagBlocks: number;
  };
  celestia: BackendChainSyncPosition & {
    current: number;
    tip: number;
    lagBlocks: number;
  };
};

const malformedField = (operation: string, field: string, expected: string): never => {
  throw new ApiRequestError("malformed", operation, `${field} must be ${expected}`);
};

const assertKnownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  operation: string,
  field: string,
): void => {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    malformedField(operation, `${field}.${unknown}`, "a known contract field");
  }
};

const nonNegativeSafeInteger = (
  value: unknown,
  operation: string,
  field: string,
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return malformedField(operation, field, "a non-negative safe integer");
  }
  return value as number;
};

const nullableNonNegativeSafeInteger = (
  value: unknown,
  operation: string,
  field: string,
): number | null => {
  if (value === null) return null;
  return nonNegativeSafeInteger(value, operation, field);
};

const positiveIntegerToken = (
  value: unknown,
  operation: string,
  field: string,
): string => {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
  } else if (typeof value === "string") {
    // The persisted generation is a SQLite INTEGER/u64 protocol value. Check
    // length before syntax/value so an unbounded digit token never reaches a
    // numeric parser, then compare the only possible 20-digit case directly.
    const maxU64 = "18446744073709551615";
    if (
      value.length > 0 &&
      value.length <= maxU64.length &&
      /^[1-9][0-9]*$/.test(value) &&
      (value.length < maxU64.length || value <= maxU64)
    ) {
      return value;
    }
  }
  return malformedField(operation, field, "a positive canonical decimal u64 integer");
};

const nullableNonNegativeFiniteNumber = (
  value: unknown,
  operation: string,
  field: string,
): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return malformedField(operation, field, "null or a non-negative finite number");
  }
  return value;
};

function parseNtpSyncPosition(value: unknown, operation: string): BackendNtpSyncPosition {
  if (!record(value)) return malformedField(operation, "ntp", "an object");
  assertKnownKeys(
    value,
    new Set(["current", "tip", "pct", "lag_blocks", "lag_seconds"]),
    operation,
    "ntp",
  );
  const current = nonNegativeSafeInteger(value.current, operation, "ntp.current");
  const tip = nonNegativeSafeInteger(value.tip, operation, "ntp.tip");
  const pct = nullableNonNegativeFiniteNumber(value.pct, operation, "ntp.pct");
  const lagBlocks = nonNegativeSafeInteger(value.lag_blocks, operation, "ntp.lag_blocks");
  const lagSeconds = nullableNonNegativeFiniteNumber(
    value.lag_seconds,
    operation,
    "ntp.lag_seconds",
  );
  if (lagSeconds === null) {
    return malformedField(operation, "ntp.lag_seconds", "a non-negative finite number");
  }
  return { current, tip, pct, lagBlocks, lagSeconds };
}

function parseChainSyncPosition(
  value: unknown,
  operation: string,
  field: "midnight" | "celestia",
): BackendChainSyncPosition {
  if (!record(value)) return malformedField(operation, field, "an object");
  assertKnownKeys(
    value,
    new Set(["current", "fetched", "tip", "pct", "lag_blocks"]),
    operation,
    field,
  );
  const current = nullableNonNegativeSafeInteger(value.current, operation, `${field}.current`);
  const fetched = nullableNonNegativeSafeInteger(value.fetched, operation, `${field}.fetched`);
  const tip = nullableNonNegativeSafeInteger(value.tip, operation, `${field}.tip`);
  const pct = nullableNonNegativeFiniteNumber(value.pct, operation, `${field}.pct`);
  const lagBlocks = nullableNonNegativeSafeInteger(
    value.lag_blocks,
    operation,
    `${field}.lag_blocks`,
  );

  return { current, fetched, tip, pct, lagBlocks };
}

function parseBlockL2Generation(
  value: unknown,
  operation: string,
): BackendL2Generation | null {
  if (value === null) return null;
  if (!record(value)) return malformedField(operation, "blockL2", "null or an object");
  assertKnownKeys(
    value,
    new Set([
      "height",
      "timestamp",
      "block_hash",
      "main_chain_block_hash",
      "block_time",
      "lag",
    ]),
    operation,
    "blockL2",
  );
  return { height: positiveIntegerToken(value.height, operation, "blockL2.height") };
}

function parseBackendSyncHealth(body: unknown, operation: string): BackendSyncHealth {
  if (!record(body)) return malformedField(operation, "response", "an object");
  assertKnownKeys(
    body,
    new Set([
      "ts",
      "now",
      "status",
      "blockL2",
      "ntp",
      "midnight",
      "celestia",
      "sets",
      "recent_rejections",
    ]),
    operation,
    "response",
  );
  const ts = nonNegativeSafeInteger(body.ts, operation, "ts");
  if (body.status !== "ok" && body.status !== "syncing" && body.status !== "error") {
    return malformedField(operation, "status", 'one of "ok", "syncing", or "error"');
  }
  const blockL2 = parseBlockL2Generation(body.blockL2, operation);
  const ntp = parseNtpSyncPosition(body.ntp, operation);
  const midnight = parseChainSyncPosition(body.midnight, operation, "midnight");
  const celestia = parseChainSyncPosition(body.celestia, operation, "celestia");

  // `ok` is authority to use the backend's current-offer projection. Refuse an
  // internally incomplete success even if the status token itself parses. Lag
  // thresholds remain server policy; the client validates exact types and
  // presence rather than maintaining a second threshold table.
  if (
    body.status === "ok" &&
    (blockL2 === null || [
      midnight.current, midnight.tip, midnight.lagBlocks,
      celestia.current, celestia.tip, celestia.lagBlocks,
    ].some((part) => part === null))
  ) {
    return malformedField(
      operation,
      "status",
      'a positive blockL2 generation and complete chain positions when "ok"',
    );
  }

  return { ts, status: body.status, blockL2, ntp, midnight, celestia };
}

/** Read the backend's aggregate protocol-currentness verdict. Transport and
 * grammar failures reject as ApiRequestError; `syncing` and `error` remain
 * explicit domain states for the readiness owner to fail closed on. */
export async function getBackendSyncHealth(target?: ApiTarget): Promise<BackendSyncHealth> {
  const operation = "GET /v1/health/sync";
  return withRequestDeadline(operation, target, async (signal, api) => {
    const response = await fetch(`${api}/v1/health/sync`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) throw httpError(operation, response.status);
    return parseBackendSyncHealth(
      await parseBoundedJson(response, operation, MAX_SYNC_HEALTH_BODY_BYTES, signal),
      operation,
    );
  });
}

/** This only reports what one parsed response says. The readiness integration
 * must additionally bind it to the active stream/snapshot generation and its
 * own freshness policy before restoring matching. */
export const reportsBackendProjectionCurrent = (
  health: BackendSyncHealth,
): health is CurrentBackendSyncHealth =>
  health.status === "ok" &&
  health.blockL2 !== null &&
  health.midnight.current !== null &&
  health.midnight.tip !== null &&
  health.midnight.lagBlocks !== null &&
  health.celestia.current !== null &&
  health.celestia.tip !== null &&
  health.celestia.lagBlocks !== null;

/** Ask the Offer Files backend whether these exact content-addressed bytes are
 * usable by the approved solver profile now. Local identity binding happens
 * before authentication or network IO; only a strict HTTP-200 v1 verdict is a
 * domain result. Every other response remains boundary unavailability. */
export async function validateOfferForUse(
  offerId: string,
  offer: string,
  options: OfferValidationApiOptions,
): Promise<OfferValidationVerdict> {
  const operation = "POST /v1/offers/validate";
  const canonical = canonicalOfferHash(offerId, operation);
  assertOfferBlobIdentity(offer, canonical, operation);
  if (
    typeof options.authToken !== "string" ||
    options.authToken.length < 16 ||
    /\s/.test(options.authToken)
  ) {
    throw new ApiRequestError(
      "malformed",
      operation,
      "solver bearer credential must contain at least 16 non-whitespace characters",
    );
  }

  const request = {
    schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
    profile: OFFER_VALIDATION_PROFILE,
    offerId: canonical,
    offer,
  };
  return withRequestDeadline(operation, options, async (signal, api) => {
    const response = await fetch(`${api}/v1/offers/validate`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      try {
        void response.body?.cancel().catch(() => {});
      } catch {
        // The typed HTTP result already fails closed; cancellation only makes
        // connection reuse best-effort for non-conforming response doubles.
      }
      throw httpError(operation, response.status);
    }
    const parsed = parseOfferValidationVerdict(
      await parseBoundedJson(
        response,
        operation,
        MAX_OFFER_VALIDATION_RESPONSE_BYTES,
        signal,
      ),
    );
    if (parsed === null) {
      throw new ApiRequestError(
        "malformed",
        operation,
        "response body is not a canonical validate-for-use v1 verdict",
      );
    }
    if (parsed.profile !== OFFER_VALIDATION_PROFILE) {
      throw new ApiRequestError("malformed", operation, "verdict profile is not bound to request");
    }
    if (parsed.claimedOfferId !== canonical) {
      throw new ApiRequestError(
        "malformed",
        operation,
        "verdict claimedOfferId is not bound to request",
      );
    }
    if (parsed.computedOfferId !== null && parsed.computedOfferId !== canonical) {
      throw new ApiRequestError(
        "malformed",
        operation,
        "verdict computedOfferId is not bound to request bytes",
      );
    }
    return parsed;
  });
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

// ── Offer-updates websocket stream ───────────────────────────────────────────

/** What one `ready` frame told us about the subscription it opened. */
export interface OfferUpdatesSubscription {
  /** Identity of THIS subscription. A different value is a different
   * subscription: nothing carries over, and derived state must be rebuilt. */
  streamId: string;
  /** Committed Effectstream (L2) height observed at or before the moment this
   * subscription was registered, or null when the backend could not read it.
   * A consumer binds its later currentness verdict to this floor: a backend
   * that afterwards reports a LOWER height has rewound, which no snapshot can
   * repair. */
  blockL2Height: string | null;
}

/** The slice of the WHATWG WebSocket surface this client uses. Declared rather
 * than imported so the client can be driven by an explicit test double without
 * a DOM lib dependency. */
export interface WebSocketLike {
  readyState: number;
  onopen: ((event?: any) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: any) => void) | null;
  onclose: ((event?: any) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface OfferUpdatesStreamOpts {
  api?: string;
  /** Fires once per subscription, when the `ready` frame arrives — NOT when
   * the socket opens. The backend attaches its event listener before writing
   * that frame, so this really is the point after which nothing is missed,
   * and it is the correct moment to start an authoritative snapshot. */
  onOpen?: (subscription: OfferUpdatesSubscription) => void;
  /** Fires after a subscription that reached `ready` ends for any reason —
   * peer close, transport failure, or a sequence gap this client refused.
   * Not called by close(). */
  onDisconnect?: () => void;
  onError?: (err: unknown) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Deadline covering the socket open AND the `ready` frame. A socket that
   * opens but never announces a subscription is not a usable stream. */
  connectTimeoutMs?: number;
  /** Largest accepted frame. A peer must not be able to grow the solver heap
   * with one enormous message. */
  maxFrameBytes?: number;
  /** Explicit seam for deterministic tests; production uses global WebSocket. */
  createWebSocket?: (url: string) => WebSocketLike;
}

export interface OfferUpdatesStreamHandle {
  /** Stop reconnecting, close any live subscription, and resolve once the
   * stream lifecycle has ended. Idempotent. */
  close: () => Promise<void>;
}

/** Map an HTTP API base onto the websocket origin for the update stream. */
export function offerUpdatesUrl(api: string): string {
  const base = api.replace(/\/+$/, "");
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}${OFFER_UPDATES_PATH}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}${OFFER_UPDATES_PATH}`;
  if (base.startsWith("ws://") || base.startsWith("wss://")) return `${base}${OFFER_UPDATES_PATH}`;
  throw new ApiRequestError(
    "malformed",
    OFFER_UPDATES_PATH,
    `API base ${api} has no http(s) or ws(s) scheme`,
  );
}

/**
 * Consume the node's websocket update stream, reconnecting with exponential
 * backoff and jitter until close().
 *
 * The whole point of this transport over SSE is that a missed mutation is
 * DETECTABLE. Every frame carries a per-subscription sequence number; this
 * client refuses the first frame that does not follow its predecessor and
 * tears the subscription down, which surfaces to the consumer as an ordinary
 * disconnect — the state it already knows how to recover from with a full
 * snapshot. Nothing here ever skips a frame, repairs one, or reorders.
 */
export function openOfferUpdatesStream(
  onEvent: (ev: SseEvent) => void,
  opts: OfferUpdatesStreamOpts = {},
): OfferUpdatesStreamHandle {
  const base = opts.baseBackoffMs ?? DEFAULT_SSE_BASE_BACKOFF_MS;
  const max = opts.maxBackoffMs ?? DEFAULT_SSE_MAX_BACKOFF_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const maxFrameBytes = opts.maxFrameBytes ?? MAX_OFFER_UPDATES_FRAME_BYTES;
  for (const [name, value] of [
    ["baseBackoffMs", base],
    ["maxBackoffMs", max],
    ["connectTimeoutMs", connectTimeoutMs],
    ["maxFrameBytes", maxFrameBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`offer-updates ${name} must be a positive safe integer, got ${value}`);
    }
  }
  const url = offerUpdatesUrl(resolveApi(opts.api));
  const createWebSocket =
    opts.createWebSocket ??
    ((target: string): WebSocketLike => new WebSocket(target) as unknown as WebSocketLike);

  let stopped = false;
  let active: WebSocketLike | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeBackoff: (() => void) | null = null;

  const reportError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // Diagnostics are never allowed to become a stream-lifecycle failure.
    }
  };

  const protocolError = (message: string, cause?: unknown): ApiRequestError =>
    new ApiRequestError("malformed", OFFER_UPDATES_PATH, message, {
      ...(cause === undefined ? {} : { cause }),
    });

  /** Run one subscription attempt. Resolves when it has ended, whatever the
   * reason; failures are reported, never thrown at the lifecycle loop. */
  const runSubscription = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let socket: WebSocketLike;
      try {
        socket = createWebSocket(url);
      } catch (err) {
        reportError(
          new ApiRequestError("network", OFFER_UPDATES_PATH, "could not open a websocket", {
            cause: err,
          }),
        );
        resolve();
        return;
      }
      active = socket;

      let settled = false;
      let subscribed = false;
      let previous: { streamId: string; seq: number } | null = null;

      const timer = setTimeout(() => {
        reportError(
          new ApiRequestError(
            "timeout",
            OFFER_UPDATES_PATH,
            `no ready frame within ${connectTimeoutMs} ms`,
          ),
        );
        endSubscription();
      }, connectTimeoutMs);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (active === socket) active = null;
        if (subscribed && !stopped) {
          try {
            opts.onDisconnect?.();
          } catch (err) {
            reportError(err);
          }
        }
        resolve();
      };

      function endSubscription(): void {
        try {
          socket.close();
        } catch {
          // A closing/closed socket is exactly the state we are asking for.
        }
        // A test double or a wedged implementation may never call onclose;
        // the subscription is over either way.
        finish();
      }

      const fail = (error: unknown): void => {
        reportError(error);
        endSubscription();
      };

      socket.onopen = (): void => {
        // Deliberately NOT the subscription point: the backend announces the
        // subscription with its `ready` frame, and only that frame proves the
        // event listener is attached.
      };

      socket.onmessage = (event: { data: unknown }): void => {
        if (settled || stopped) return;
        const data = event?.data;
        if (typeof data !== "string") {
          fail(protocolError("update stream sent a non-text frame"));
          return;
        }
        if (data.length > maxFrameBytes) {
          fail(protocolError(`update frame exceeded ${maxFrameBytes} bytes`));
          return;
        }
        const encoded = new TextEncoder().encode(data).byteLength;
        if (encoded > maxFrameBytes) {
          fail(protocolError(`update frame exceeded ${maxFrameBytes} bytes`));
          return;
        }
        const frame = decodeOfferUpdatesFrame(data);
        if (frame === null) {
          fail(protocolError("update stream sent a noncanonical frame"));
          return;
        }

        if (previous === null) {
          if (frame.type !== "ready" || frame.seq !== OFFER_UPDATES_READY_SEQ) {
            fail(protocolError("update stream did not open with a ready frame"));
            return;
          }
          previous = { streamId: frame.streamId, seq: frame.seq };
          subscribed = true;
          clearTimeout(timer);
          try {
            opts.onOpen?.({ streamId: frame.streamId, blockL2Height: frame.blockL2Height });
          } catch (err) {
            reportError(err);
          }
          return;
        }

        if (frame.type === "ready") {
          fail(protocolError("update stream announced a second subscription"));
          return;
        }
        if (!followsInSequence(previous, frame)) {
          // THE failure this transport exists to catch: at least one mutation
          // was not delivered. Never applied partially, never patched over.
          fail(
            protocolError(
              `update stream gap: expected seq ${previous.seq + 1} on stream ` +
                `${previous.streamId}, got seq ${frame.seq} on stream ${frame.streamId}`,
            ),
          );
          return;
        }
        previous = { streamId: frame.streamId, seq: frame.seq };
        try {
          onEvent(frame.event as unknown as SseEvent);
        } catch (err) {
          reportError(err);
        }
      };

      socket.onerror = (event?: any): void => {
        if (settled) return;
        reportError(
          new ApiRequestError("network", OFFER_UPDATES_PATH, "websocket transport error", {
            cause: event,
          }),
        );
        // onclose follows onerror in every conforming implementation; finish
        // there so a transient error event does not end a healthy stream.
      };

      socket.onclose = (): void => {
        finish();
      };
    });

  const waitForBackoff = (delay: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const done = (): void => {
        if (backoffTimer !== null) clearTimeout(backoffTimer);
        backoffTimer = null;
        if (wakeBackoff === done) wakeBackoff = null;
        resolve();
      };
      wakeBackoff = done;
      backoffTimer = setTimeout(done, delay);
    });

  const lifecycle = (async () => {
    let attempt = 0;
    while (!stopped) {
      await runSubscription();
      if (stopped) return;
      // Jitter in [0.5, 1.5) so multiple solvers don't reconnect in lockstep.
      const delay = Math.floor(Math.min(max, base * 2 ** attempt) * (0.5 + Math.random()));
      attempt = attempt + 1 > 30 ? 30 : attempt + 1;
      await waitForBackoff(delay);
    }
  })();

  return {
    async close(): Promise<void> {
      if (!stopped) {
        stopped = true;
        try {
          active?.close();
        } catch {
          // Already closing.
        }
        wakeBackoff?.();
      }
      await lifecycle;
    },
  };
}
