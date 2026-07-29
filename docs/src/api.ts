// Typed request descriptors mirroring API.md 1:1 — each endpoint is defined
// exactly once here. Two transports consume them:
//   dbg.call(api.zswaps({ limit: 20 }))  — panels; logs request/response in the debugger aside
//   run(api.midnightConfig())            — plain fetch + parse + throw, the client shape
//                                          you'd copy into your own app
// See also `api-examples/` at the repo root for runnable scripts per endpoint.
import { API_BASE, BATCHER_URL } from './config'

export type MidnightConfig = {
  contractAddress: string
  indexerUri: string
  indexerWsUri: string
  proofServerUri: string
  networkId: string
}

export type KnownToken = {
  id: number
  token_color: string
  name: string
  kind: string
}

export type Offer = {
  id: number
  celestia_height?: string
  /** Content hash (sha256 of the raw offer bytes) — the cross-node offer id. */
  offer_hash: string | null
  /** bech32m length of the blob; fetch the blob itself via zswapByHash(). */
  blob_chars?: number
  gives?: { token: string; amount: string }[]
  wants?: { token: string; amount: string }[]
}

export type OfferDetail = {
  offer_hash: string
  status: 'open' | 'completed' | 'expired'
  blob: string
  celestia_height?: string
  gives?: { token: string; amount: string }[]
  wants?: { token: string; amount: string }[]
}

export type SyncStatus = { status: string; [k: string]: unknown }

/** Phantom-typed request: T is the expected response body. */
export type ApiRequest<T = any> = {
  method: 'GET' | 'POST'
  url: string
  body?: unknown
  /** phantom — never set at runtime */
  __t?: T
}

const req = <T = any>(method: 'GET' | 'POST', url: string, body?: unknown): ApiRequest<T> =>
  ({ method, url, body })

const qs = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v))
  return p.toString()
}

export const api = {
  // ── Node (:9999) ──────────────────────────────────────────────────────────
  health: () => req<{ status: string }>('GET', `${API_BASE}/health`),
  sync: () => req<SyncStatus>('GET', `${API_BASE}/api/health/sync`),
  zswaps: (q: { token?: string; direction?: string; limit?: number } = {}) =>
    req<Offer[]>('GET', `${API_BASE}/api/zswaps?${qs(q)}`),
  /** Full offer (including its blob) by content hash. */
  zswapByHash: (hash: string) =>
    req<OfferDetail>('GET', `${API_BASE}/api/zswaps/${hash}`),
  zswapStatusByHash: (hash: string) =>
    req<{ offer_hash: string; status: string }>('GET', `${API_BASE}/api/zswaps/${hash}/status`),
  /** POST: a real blob is 16–25 KB — far beyond what a query string survives. */
  zswapStatus: (blob: string) =>
    req<{ blob: string; offer_hash?: string; status: string }>('POST', `${API_BASE}/api/zswap/status`, { blob }),
  submitOffer: (blob: string) => req('POST', `${API_BASE}/api/zswap/submit`, { blob }),
  knownTokens: () => req<KnownToken[]>('GET', `${API_BASE}/api/known-tokens`),
  registerToken: (color: string, name: string, kind: string) =>
    req('POST', `${API_BASE}/api/known-tokens`, { color, name, kind }),
  pairs: () => req('GET', `${API_BASE}/api/pairs`),
  quote: (from_token: string, to_token: string, from_amount: string) =>
    req('GET', `${API_BASE}/api/quote?${qs({ from_token, to_token, from_amount })}`),
  chartStats: (base: string, quote: string) =>
    req('GET', `${API_BASE}/api/chart/stats?${qs({ base, quote })}`),
  chartHistory: (base: string, quote: string) =>
    req('GET', `${API_BASE}/api/chart/history?${qs({ base, quote })}`),
  midnightConfig: () => req<MidnightConfig>('GET', `${API_BASE}/api/midnight/config`),
  /** SSE endpoint — connect with `new EventSource(...)`, not fetch. */
  eventsUrl: () => `${API_BASE}/api/events`,

  // ── Batcher (:3334) ───────────────────────────────────────────────────────
  batcherHealth: () => req('GET', `${BATCHER_URL}/health`),
  batcherStatus: () => req('GET', `${BATCHER_URL}/status`),
  batcherQueueStats: () => req('GET', `${BATCHER_URL}/queue-stats`),
  /** Raw-body passthrough — send-input shapes differ per target; see the call sites. */
  batcherSend: (body: unknown) => req('POST', `${BATCHER_URL}/send-input`, body),
}

/** Plain transport: fetch + parse + throw on HTTP error. */
export async function run<T>(r: ApiRequest<T>): Promise<T> {
  const res = await fetch(r.url, {
    method: r.method,
    ...(r.body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }
      : {}),
  })
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) {
    const msg = typeof data === 'object' ? (data.reason ?? data.error ?? data.message ?? JSON.stringify(data)) : String(data)
    const err = new Error(msg) as Error & { status: number; body: unknown }
    err.status = res.status
    err.body = data
    throw err
  }
  return data as T
}
