import { API_BASE, BATCHER_URL, BATCHER_TARGET } from './config'

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
  transaction_hex: string
  gives?: { token: string; amount: string }[]
  wants?: { token: string; amount: string }[]
}

async function json<T>(res: Response): Promise<T> {
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

export const api = {
  get: <T = unknown>(path: string) => fetch(`${API_BASE}${path}`).then((r) => json<T>(r)),
  post: <T = unknown>(path: string, body: unknown, base = API_BASE) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<T>(r)),

  health: () => api.get<{ status: string }>('/health'),
  sync: () => api.get<any>('/api/health/sync'),
  midnightConfig: () => api.get<MidnightConfig>('/api/midnight/config'),
  knownTokens: () => api.get<KnownToken[]>('/api/known-tokens'),
  registerToken: (color: string, name: string, kind: string) =>
    api.post('/api/known-tokens', { color, name, kind }),
  zswaps: (q = '') => api.get<Offer[]>(`/api/zswaps${q}`),
  zswapStatus: (blob: string) =>
    api.get<{ blob: string; status: string }>(`/api/zswap/status?blob=${encodeURIComponent(blob)}`),
  submitOffer: (blob: string) => api.post('/api/zswap/submit', { blob }),
  pairs: () => api.get('/api/pairs'),
  quote: (from_token: string, to_token: string, from_amount: string) =>
    api.get(`/api/quote?${new URLSearchParams({ from_token, to_token, from_amount })}`),
  chartStats: (base: string, quote: string) =>
    api.get(`/api/chart/stats?${new URLSearchParams({ base, quote })}`),
  chartHistory: (base: string, quote: string) =>
    api.get(`/api/chart/history?${new URLSearchParams({ base, quote })}`),
  eventsUrl: () => `${API_BASE}/api/events`,

  batcherGet: (path: string) => fetch(`${BATCHER_URL}${path}`).then((r) => json(r)),
  batcherSend: (body: unknown) =>
    fetch(`${BATCHER_URL}/send-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json(r)),
}

export { BATCHER_TARGET, BATCHER_URL }
