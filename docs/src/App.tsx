import { useEffect, useState } from 'react'
import { API_BASE, BATCHER_URL, PROOF_SERVER_URL } from './config'
import { DebuggerAside, DebuggerProvider, useDebugger } from './Debugger'
import { WalletStage } from './WalletStage'
import { useWalletApp } from './useWalletApp'
import {
  AcceptPanel,
  BatcherPanel,
  EventsPanel,
  HealthPanel,
  OverviewPanel,
  ReadPanel,
  StatusPanel,
  UploadPanel,
} from './Panels'

type PanelId =
  | 'overview'
  | 'wallet'
  | 'health'
  | 'upload'
  | 'accept'
  | 'status'
  | 'events'
  | 'read'
  | 'batcher'

const NAV: { group: string; items: { id: PanelId; label: string; hint: string }[] }[] = [
  {
    group: 'Start',
    items: [
      { id: 'overview', label: 'Overview', hint: 'Lifecycle & ports' },
      { id: 'wallet', label: 'Wallet', hint: 'Connect · balances · mint' },
      { id: 'health', label: 'Health', hint: '/health · sync' },
    ],
  },
  {
    group: 'Offers',
    items: [
      { id: 'upload', label: 'Upload offer', hint: 'POST /api/zswap/submit' },
      { id: 'accept', label: 'Accept / settle', hint: 'Book + batcher' },
      { id: 'status', label: 'Offer status', hint: 'GET /api/zswap/status' },
      { id: 'events', label: 'Live events', hint: 'SSE /api/events' },
    ],
  },
  {
    group: 'API',
    items: [
      { id: 'read', label: 'Read APIs', hint: 'zswaps · tokens · market' },
      { id: 'batcher', label: 'Batcher debug', hint: ':3334 send-input' },
    ],
  },
]

function AppInner() {
  const [panel, setPanel] = useState<PanelId>('wallet')
  const [blob, setBlob] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [health, setHealth] = useState<{ label: string; cls: string }>({ label: 'unknown', cls: '' })
  const dbg = useDebugger()
  const wallet = useWalletApp()
  const call = dbg.call

  // Mount-only probe — do NOT depend on `dbg` (its value changes every request
  // and would re-fire this into a /api/health/sync storm → RATE_LIMITED).
  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/api/health/sync`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.status) return
        const s = data.status as string
        setHealth({
          label: s,
          cls: s === 'ok' ? 'ok' : s === 'syncing' ? 'syncing' : 'err',
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>ZSwap-DA <span>API Playground</span></h1>
        <div className="hosts">
          <label>Node <code>{API_BASE}</code></label>
          <label>Batcher <code>{BATCHER_URL}</code></label>
          <label>Proof <code>{PROOF_SERVER_URL}</code></label>
          <button className="btn" type="button" onClick={async () => {
            await call('GET', `${API_BASE}/health`)
            const r = await call('GET', `${API_BASE}/api/health/sync`)
            if (r.parsed?.status) {
              const s = r.parsed.status
              setHealth({ label: s, cls: s === 'ok' ? 'ok' : s === 'syncing' ? 'syncing' : 'err' })
            }
          }}>Check health</button>
          <span className={`badge ${health.cls}`}><span className="dot" />{health.label}</span>
          {wallet.status === 'connected' && (
            <span className="badge ok"><span className="dot" />wallet {wallet.connected?.name}</span>
          )}
        </div>
      </header>

      <nav className="side">
        {NAV.map((g) => (
          <div className="group" key={g.group}>
            <div className="group-title">{g.group}</div>
            {g.items.map((it) => (
              <button
                key={it.id}
                type="button"
                className={`nav-item${panel === it.id ? ' active' : ''}`}
                onClick={() => setPanel(it.id)}
              >
                {it.label}
                <span className="hint">{it.hint}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <main>
        {panel === 'overview' && <OverviewPanel />}
        {panel === 'wallet' && <WalletStage wallet={wallet} />}
        {panel === 'health' && <HealthPanel />}
        {panel === 'upload' && <UploadPanel blob={blob} setBlob={setBlob} wallet={wallet} />}
        {panel === 'accept' && (
          <AcceptPanel blob={blob} setBlob={setBlob} selectedId={selectedId} setSelectedId={setSelectedId} wallet={wallet} />
        )}
        {panel === 'status' && <StatusPanel blob={blob} setBlob={setBlob} />}
        {panel === 'events' && <EventsPanel />}
        {panel === 'read' && <ReadPanel />}
        {panel === 'batcher' && <BatcherPanel />}
      </main>

      <DebuggerAside />
    </div>
  )
}

export default function App() {
  return (
    <DebuggerProvider>
      <AppInner />
    </DebuggerProvider>
  )
}
