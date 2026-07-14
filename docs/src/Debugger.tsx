import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiRequest } from './api'

type HistoryEntry = {
  id: number
  method: string
  url: string
  body: string
  status: number | null
  ok: boolean
  ms: number
  responseText: string
}

type CallResult<T> = {
  status: number | null
  ok: boolean
  responseText: string
  parsed: T | null
}

type DebuggerState = {
  history: HistoryEntry[]
  openId: number | null
  setOpenId: (id: number | null) => void
  clear: () => void
  /** Debugger transport: takes an `api.*` request descriptor, logs it in the aside. */
  call: <T>(req: ApiRequest<T>) => Promise<CallResult<T>>
}

const Ctx = createContext<DebuggerState | null>(null)

export function DebuggerProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const nextId = useRef(1)

  const clear = useCallback(() => { setHistory([]); setOpenId(null) }, [])

  const call = useCallback(async <T,>({ method, url, body }: ApiRequest<T>) => {
    const t0 = performance.now()
    let status: number | null = null
    let ok = false
    let responseText = ''
    try {
      const opts: RequestInit = { method, headers: {} }
      if (body !== undefined) {
        ;(opts.headers as Record<string, string>)['Content-Type'] = 'application/json'
        opts.body = typeof body === 'string' ? body : JSON.stringify(body)
      }
      const res = await fetch(url, opts)
      status = res.status
      ok = res.ok
      const text = await res.text()
      try { responseText = JSON.stringify(JSON.parse(text), null, 2) } catch { responseText = text }
    } catch (e: any) {
      responseText = String(e?.message ?? e)
    }
    const ms = Math.round(performance.now() - t0)
    const id = nextId.current++
    const bodyText = body != null ? (typeof body === 'string' ? body : JSON.stringify(body, null, 2)) : ''
    setHistory((h) => [{ id, method, url, body: bodyText, status, ok, ms, responseText }, ...h].slice(0, 40))
    setOpenId(id) // newest auto-expands; accordion keeps a single item open
    let parsed: T | null = null
    try { parsed = JSON.parse(responseText) } catch { /* */ }
    return { status, ok, responseText, parsed }
  }, [])

  const value = useMemo(
    () => ({ history, openId, setOpenId, clear, call }),
    [history, openId, clear, call],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDebugger() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDebugger outside provider')
  return ctx
}

export function DebuggerAside() {
  const dbg = useDebugger()
  return (
    <aside className="aside">
      <div className="aside-head">
        <h2>Request debugger</h2>
        <button className="btn" type="button" onClick={dbg.clear}>Clear</button>
      </div>
      <div className="req-list">
        {dbg.history.length === 0 && <p className="meta" style={{ padding: 12, margin: 0 }}>No requests yet.</p>}
        {dbg.history.map((h) => {
          const open = dbg.openId === h.id
          const path = h.url.replace(/^https?:\/\/[^/]+/, '')
          return (
            <div key={h.id} className={`req-item${open ? ' open' : ''}`}>
              <button type="button" className="req-head" onClick={() => dbg.setOpenId(open ? null : h.id)}>
                <span className={h.ok ? 'ok' : 'bad'}>{h.status ?? 'ERR'}</span>
                <span className="req-path">{h.method} {path}</span>
                <span className="req-ms">{h.ms}ms</span>
                <span className="chev">{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="req-detail">
                  <h3>Request</h3>
                  <div className="meta">{h.method} {h.url}</div>
                  {h.body && <pre>{h.body}</pre>}
                  <h3>Response</h3>
                  <div className="meta">{h.status ?? 'ERR'} · {h.ms} ms</div>
                  <pre>{h.responseText}</pre>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
