import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { ApiRequest } from './api'

type HistoryEntry = { method: string; url: string; status: number | null; ok: boolean; ms: number }

type CallResult<T> = {
  status: number | null
  ok: boolean
  responseText: string
  parsed: T | null
}

type DebuggerState = {
  reqMeta: string
  reqBody: string
  resMeta: string
  resBody: string
  history: HistoryEntry[]
  setLast: (args: {
    method: string
    url: string
    body?: unknown
    status: number | null
    ms: number
    ok: boolean
    responseText: string
  }) => void
  clear: () => void
  /** Debugger transport: takes an `api.*` request descriptor, logs it in the aside. */
  call: <T>(req: ApiRequest<T>) => Promise<CallResult<T>>
}

const Ctx = createContext<DebuggerState | null>(null)

export function DebuggerProvider({ children }: { children: ReactNode }) {
  const [reqMeta, setReqMeta] = useState('—')
  const [reqBody, setReqBody] = useState('')
  const [resMeta, setResMeta] = useState('—')
  const [resBody, setResBody] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])

  const setLast = useCallback((args: {
    method: string; url: string; body?: unknown; status: number | null; ms: number; ok: boolean; responseText: string
  }) => {
    setReqMeta(`${args.method} ${args.url}`)
    setReqBody(args.body != null ? (typeof args.body === 'string' ? args.body : JSON.stringify(args.body, null, 2)) : '')
    setResMeta(`${args.status ?? 'ERR'} · ${args.ms} ms`)
    setResBody(args.responseText)
    setHistory((h) => [{ method: args.method, url: args.url, status: args.status, ok: args.ok, ms: args.ms }, ...h].slice(0, 40))
  }, [])

  const clear = useCallback(() => {
    setReqMeta('—'); setReqBody(''); setResMeta('—'); setResBody(''); setHistory([])
  }, [])

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
    setLast({ method, url, body, status, ms, ok, responseText })
    let parsed: T | null = null
    try { parsed = JSON.parse(responseText) } catch { /* */ }
    return { status, ok, responseText, parsed }
  }, [setLast])

  const value = useMemo(
    () => ({ reqMeta, reqBody, resMeta, resBody, history, setLast, clear, call }),
    [reqMeta, reqBody, resMeta, resBody, history, setLast, clear, call],
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
      <div className="req-block">
        <h3>Last request</h3>
        <div className="meta">{dbg.reqMeta}</div>
        <pre>{dbg.reqBody}</pre>
      </div>
      <div className="res-block">
        <h3>Response</h3>
        <div className="meta">{dbg.resMeta}</div>
        <pre>{dbg.resBody}</pre>
      </div>
      <div className="history">
        {dbg.history.map((h, i) => {
          const path = h.url.replace(/^https?:\/\/[^/]+/, '')
          return (
            <button key={i} type="button">
              <span className={h.ok ? 'ok' : 'bad'}>{h.status ?? 'ERR'}</span>
              {' '}{h.method} {path} · {h.ms}ms
            </button>
          )
        })}
      </div>
    </aside>
  )
}
