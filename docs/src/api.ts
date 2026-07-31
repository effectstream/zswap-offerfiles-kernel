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

/** MIP-0006 TokenLeg. */
export type TokenLeg = { token: string; amount: string; type: 'SHIELDED' | 'UNSHIELDED' }

export type OfferComputed = {
  gives: TokenLeg[]
  wants: TokenLeg[]
  expiresAt?: string | null
  inputNullifiers: string[]
  firstSeenAt?: string | null
  status: 'live' | 'consumed' | 'cancelled' | 'expired'
}

/** MIP-0006 OffchainOfferPayload. In LIST responses `offerBech32` is omitted
 *  (16–25 KB per offer); fetch it per offer via zswapByHash(). */
export type Offer = {
  version: 1
  offerId: string | null
  offerBech32?: string
  blobChars?: number
  celestiaHeight?: string
  computed: OfferComputed
}

/** Single-offer response — the MIP requires `offerBech32` here. */
export type OfferDetail = Offer & { offerBech32: string }

export type OffersPage = { offers: Offer[]; nextCursor: string | null }

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
  sync: () => req<SyncStatus>('GET', `${API_BASE}/v1/health/sync`),
  /** Keyset pagination: pass the previous page's next_cursor as after_hash. */
  zswaps: (q: { token?: string; direction?: string; limit?: number; after_hash?: string } = {}) =>
    req<OffersPage>('GET', `${API_BASE}/v1/offers?${qs(q)}`),
  /** Full offer (including its blob) by content hash. */
  zswapByHash: (hash: string) =>
    req<OfferDetail>('GET', `${API_BASE}/v1/offers/${hash}`),
  zswapStatusByHash: (hash: string) =>
    req<{ offerId: string; status: string }>('GET', `${API_BASE}/v1/offers/${hash}/status`),
  /** POST: a real blob is 16–25 KB — far beyond what a query string survives. */
  zswapStatus: (blob: string) =>
    req<{ offerId?: string; status: string }>('POST', `${API_BASE}/v1/offers/status`, { offer: blob }),
  submitOffer: (blob: string) => req('POST', `${API_BASE}/v1/offers`, { offer: blob }),
  knownTokens: () => req<KnownToken[]>('GET', `${API_BASE}/v1/known-tokens`),
  registerToken: (color: string, name: string, kind: string) =>
    req('POST', `${API_BASE}/v1/known-tokens`, { color, name, kind }),
  pairs: () => req('GET', `${API_BASE}/v1/pairs`),
  quote: (from_token: string, to_token: string, from_amount: string) =>
    req('GET', `${API_BASE}/v1/quote?${qs({ from_token, to_token, from_amount })}`),
  chartStats: (base: string, quote: string) =>
    req('GET', `${API_BASE}/v1/chart/stats?${qs({ base, quote })}`),
  chartHistory: (base: string, quote: string) =>
    req('GET', `${API_BASE}/v1/chart/history?${qs({ base, quote })}`),
  midnightConfig: () => req<MidnightConfig>('GET', `${API_BASE}/v1/midnight/config`),
  /** SSE endpoint — connect with `new EventSource(...)`, not fetch. */
  eventsUrl: () => `${API_BASE}/v1/offers/stream`,

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
