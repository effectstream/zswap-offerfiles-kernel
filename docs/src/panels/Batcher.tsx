import { useState } from 'react'
import { BATCHER_URL } from '../config'
import { useDebugger } from '../Debugger'
import { api } from '../api'
import { BusyButton, MipNpmLink } from './shared'

export function BatcherPanel() {
  const dbg = useDebugger()
  const [raw, setRaw] = useState(`{
  "data": {
    "input": "swapoffer1...",
    "target": "celestia",
    "address": "celestia",
    "addressType": -1,
    "signature": "",
    "timestamp": ""
  },
  "confirmationLevel": "wait-receipt"
}`)
  return (
    <div className="panel">
      <h2>Batcher debug</h2>
      <p className="lead">
        Direct batcher endpoints. Swagger:{' '}
        <a href={`${BATCHER_URL}/documentation`} target="_blank" rel="noreferrer">{BATCHER_URL}/documentation</a>
      </p>
      <MipNpmLink note="Celestia send-input expects a MIP-0005 swapoffer blob — see" />
      <div className="card">
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call(api.batcherHealth())}>Health</button>
          <button className="btn" type="button" onClick={() => dbg.call(api.batcherStatus())}>Status</button>
          <button className="btn" type="button" onClick={() => dbg.call(api.batcherQueueStats())}>Queue stats</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method post">POST</span><span className="path">/send-input (raw)</span></h3>
        <div className="field">
          <label>body</label>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} style={{ minHeight: 180 }} />
        </div>
        <div className="actions">
          <BusyButton busyLabel="Sending — waiting for receipt…" onClick={() => {
            try {
              const body = JSON.parse(raw)
              if (!body?.data?.timestamp) {
                body.data = body.data || {}
                body.data.timestamp = String(Date.now())
              }
              return dbg.call(api.batcherSend(body))
            } catch (e: any) {
              alert('Invalid JSON: ' + e.message)
            }
          }}>Send raw</BusyButton>
        </div>
      </div>
    </div>
  )
}
