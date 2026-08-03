// Direct Celestia light-node RPC — the adversary's (and path-B's) publishing
// tool. Blobs carry RAW MIP-0005 transaction bytes (no wrapper), matching the
// batcher's ZswapCelestiaAdapter.buildBatchData wire format.

import { mip6NamespaceBytes } from "@zswap-da/offer-guard";
import { CELESTIA_AUTH_TOKEN, CELESTIA_RPC_URL } from "../config.ts";
import { b64 } from "./util.ts";

const NS_B64 = b64(mip6NamespaceBytes());

async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(CELESTIA_RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(CELESTIA_AUTH_TOKEN ? { Authorization: `Bearer ${CELESTIA_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    signal: AbortSignal.timeout(90_000),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`celestia ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Publish raw bytes to the shared namespace. Returns the inclusion height. */
export async function submitBlobRaw(rawBytes: Uint8Array): Promise<number> {
  const result = await rpc("blob.Submit", [
    [{ namespace: NS_B64, data: b64(rawBytes), share_version: 0 }],
    { gas_price: 0.002 },
  ]);
  return Number(result);
}

/** All namespace blobs at a height, as raw byte arrays (null-safe). */
export async function getBlobsAt(height: number): Promise<Uint8Array[]> {
  const result = await rpc("blob.GetAll", [height, [NS_B64]]);
  if (!result) return [];
  return (result as any[]).map((blob) => Uint8Array.from(Buffer.from(blob.data, "base64")));
}

export async function networkHeadHeight(): Promise<number> {
  const result = await rpc("header.NetworkHead", []);
  return Number(result?.header?.height ?? 0);
}

/** Count namespace blobs in [from, to] — used by the batcher-restart chaos
 *  check (no double publish). */
export async function countBlobsInRange(from: number, to: number): Promise<number> {
  let n = 0;
  for (let h = from; h <= to; h++) {
    try {
      n += (await getBlobsAt(h)).length;
    } catch {
      /* height pruned or not yet available — count what we can */
    }
  }
  return n;
}
