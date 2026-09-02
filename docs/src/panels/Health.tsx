import { useDebugger } from '../Debugger'
import { api } from '../api'

export function HealthPanel() {
  const dbg = useDebugger()
  return (
    <div className="panel">
      <h2>Health</h2>
      <p className="lead"><code>ROOT_UNKNOWN</code> often means Midnight sync is still catching up.</p>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/health</span></h3>
        <div className="actions">
          <button className="btn" type="button" onClick={() => dbg.call(api.processHealth())}>Process liveness</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/health</span></h3>
        <p className="lead">Aggregate NTP, Midnight, and Celestia readiness. Gate current-book UI on <code>synced</code>.</p>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call(api.health())}>Protocol readiness</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/health/sync</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call(api.sync())}>Send</button>
        </div>
      </div>
    </div>
  )
}
