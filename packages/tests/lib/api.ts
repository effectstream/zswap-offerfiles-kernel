// Node HTTP API helpers: submit offers and read them back. Reading offers back
// from GET /api/zswaps (and reconstructing the tx from the blob the API serves)
// is the faithful path — it exercises the Celestia fetch + validate + index +
// serve primitives, not an in-memory shortcut.

import { Transaction, type FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

const API = process.env["ZSWAP_API"] ?? "http://127.0.0.1:9999";

export interface SubmitResult {
  status: number;
  body: any;
}

export async function submitOffer(blob: string): Promise<SubmitResult> {
  const r = await fetch(`${API}/api/zswap/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob }),
  });
  let body: any;
  try {
    body = await r.json();
  } catch {
    body = await r.text();
  }
  return { status: r.status, body };
}

export interface ApiZswap {
  id: number;
  celestia_height: string;
  offer_hash: string | null;
  blob_chars: number;
  gives: { token: string; amount: string }[];
  wants: { token: string; amount: string }[];
}

export interface ApiZswapDetail {
  offer_hash: string;
  status: string;
  blob: string;
  gives: { token: string; amount: string }[];
  wants: { token: string; amount: string }[];
}

export interface ApiZswapsPage {
  offers: ApiZswap[];
  next_cursor: string | null;
}

/** One page; pass after_hash (= previous next_cursor) to continue. */
export async function getZswapsPage(
  params: { token?: string; limit?: number; after_hash?: string } = {},
): Promise<ApiZswapsPage> {
  const q = new URLSearchParams();
  if (params.token) q.set("token", params.token);
  if (params.after_hash) q.set("after_hash", params.after_hash);
  q.set("limit", String(params.limit ?? 100));
  const r = await fetch(`${API}/api/zswaps?${q.toString()}`);
  return (await r.json()) as ApiZswapsPage;
}

/** Convenience: first page's offers (enough for e2e books of < limit). */
export async function getZswaps(params: { token?: string; limit?: number } = {}): Promise<ApiZswap[]> {
  return (await getZswapsPage(params)).offers;
}

/** The list is blob-free; the blob is served per-offer by content hash. */
export async function getZswapByHash(hash: string): Promise<ApiZswapDetail> {
  const r = await fetch(`${API}/api/zswaps/${hash}`);
  if (!r.ok) throw new Error(`GET /api/zswaps/${hash} -> ${r.status}`);
  return (await r.json()) as ApiZswapDetail;
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
