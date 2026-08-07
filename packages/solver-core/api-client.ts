// Node HTTP API helpers: submit offers and read them back. Reading offers back
// from GET /v1/offers (and reconstructing the tx from the blob the API serves)
// is the faithful path — it exercises the Celestia fetch + validate + index +
// serve primitives, not an in-memory shortcut.

import { Transaction, type FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

const API = process.env["ZSWAP_API"] ?? "http://127.0.0.1:9999";

const resolveApi = (override?: string): string => override ?? API;

export interface SubmitResult {
  status: number;
  body: any;
}

export async function submitOffer(blob: string): Promise<SubmitResult> {
  const r = await fetch(`${API}/v1/offers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer: blob }),
  });
  let body: any;
  try {
    body = await r.json();
  } catch {
    body = await r.text();
  }
  return { status: r.status, body };
}

export interface ApiTokenLeg { token: string; amount: string; type: string }
export interface ApiZswap {
  version: 1;
  offerId: string | null;
  offerBech32?: string;
  blobChars?: number;
  blockHeight?: string;  // effectstream L2 block, not a Celestia height
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
  params: { token?: string; limit?: number; after_hash?: string; api?: string } = {},
): Promise<ApiZswapsPage> {
  const q = new URLSearchParams();
  if (params.token) q.set("token", params.token);
  if (params.after_hash) q.set("after_hash", params.after_hash);
  q.set("limit", String(params.limit ?? 100));
  const r = await fetch(`${resolveApi(params.api)}/v1/offers?${q.toString()}`);
  return (await r.json()) as ApiZswapsPage;
}

/** Convenience: first page's offers (enough for e2e books of < limit). */
export async function getZswaps(params: { token?: string; limit?: number } = {}): Promise<ApiZswap[]> {
  return (await getZswapsPage(params)).offers;
}

/** The list is blob-free; the blob is served per-offer by content hash. */
export async function getZswapByHash(hash: string, api?: string): Promise<ApiZswapDetail> {
  const r = await fetch(`${resolveApi(api)}/v1/offers/${hash}`);
  if (!r.ok) throw new Error(`GET /v1/offers/${hash} -> ${r.status}`);
  return (await r.json()) as ApiZswapDetail;
}

/** Read-time classification: live | consumed | cancelled | expired | not_found. */
export type OfferStatus = "live" | "consumed" | "cancelled" | "expired" | "not_found";

export interface OfferStatusResult {
  offerId: string;
  status: OfferStatus;
}

export async function getOfferStatus(hash: string, api?: string): Promise<OfferStatusResult> {
  const r = await fetch(`${resolveApi(api)}/v1/offers/${hash}/status`);
  if (!r.ok) throw new Error(`GET /v1/offers/${hash}/status -> ${r.status}`);
  return (await r.json()) as OfferStatusResult;
}

/** Bulk status by blob. The endpoint caps a batch at 50, so longer inputs are
 *  chunked here and the results concatenated in input order. */
export async function postOffersStatus(
  blobs: string[],
  api?: string,
): Promise<OfferStatusResult[]> {
  const out: OfferStatusResult[] = [];
  for (let i = 0; i < blobs.length; i += 50) {
    const chunk = blobs.slice(i, i + 50);
    const r = await fetch(`${resolveApi(api)}/v1/offers/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chunk.length === 1 ? { offer: chunk[0] } : { offers: chunk }),
    });
    if (!r.ok) throw new Error(`POST /v1/offers/status -> ${r.status}`);
    const body: any = await r.json();
    out.push(...(body.statuses ?? [body]));
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
  onError?: (err: unknown) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface SseStreamHandle {
  close: () => void;
}

const DEFAULT_SSE_BASE_BACKOFF_MS = 500;
const DEFAULT_SSE_MAX_BACKOFF_MS = 30_000;

/** Consume the node's SSE offer stream, reconnecting with exponential backoff
 *  and jitter until close(). */
export function openSseStream(
  onEvent: (ev: SseEvent) => void,
  opts: SseStreamOpts = {},
): SseStreamHandle {
  const base = opts.baseBackoffMs ?? DEFAULT_SSE_BASE_BACKOFF_MS;
  const max = opts.maxBackoffMs ?? DEFAULT_SSE_MAX_BACKOFF_MS;
  const url = `${resolveApi(opts.api)}/v1/offers/stream`;

  let stopped = false;
  let controller: AbortController | null = null;

  const dispatch = (payload: string): void => {
    let parsed: SseEvent;
    try {
      parsed = JSON.parse(payload) as SseEvent;
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    try {
      onEvent(parsed);
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const readFrames = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; a chunk may split one, so only
      // consume up to the last complete separator and keep the remainder.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) dispatch(line.slice(5).trim());
          // ": heartbeat" comments and any other field are ignored.
        }
      }
    }
  };

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      controller = new AbortController();
      try {
        const resp = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`SSE ${url} -> ${resp.status}`);
        attempt = 0;
        opts.onOpen?.();
        await readFrames(resp.body);
      } catch (err) {
        if (!stopped) opts.onError?.(err);
      }
      if (stopped) return;
      // Jitter in [0.5, 1.5) so multiple solvers don't reconnect in lockstep.
      const delay = Math.floor(Math.min(max, base * 2 ** attempt) * (0.5 + Math.random()));
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  })();

  return {
    close(): void {
      stopped = true;
      controller?.abort();
    },
  };
}
