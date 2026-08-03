import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

export function EventsPanel() {
  const [log, setLog] = useState('')
  const sse = useRef<EventSource | null>(null)
  useEffect(() => () => { sse.current?.close() }, [])
  return (
    <div className="panel">
      <h2>Live events</h2>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/offers/stream</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => {
            sse.current?.close()
            const url = api.eventsUrl()
            setLog(`connecting ${url}\n`)
            const es = new EventSource(url)
            sse.current = es
            es.onmessage = (ev) => setLog((l) => l + ev.data + '\n')
            es.onerror = () => setLog((l) => l + '[error / reconnecting]\n')
          }}>Connect</button>
          <button className="btn danger" type="button" onClick={() => {
            sse.current?.close(); sse.current = null
            setLog((l) => l + '[disconnected]\n')
          }}>Disconnect</button>
        </div>
        <pre style={{ marginTop: 12, minHeight: 200, maxHeight: 420, background: 'var(--bg)', padding: 10, borderRadius: 'var(--radius)', border: '1px solid var(--stroke)' }}>{log}</pre>
      </div>
    </div>
  )
}
