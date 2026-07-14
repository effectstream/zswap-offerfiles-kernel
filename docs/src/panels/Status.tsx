import { useDebugger } from '../Debugger'
import { api } from '../api'
import { MipNpmLink } from './shared'

export function StatusPanel({ blob, setBlob }: { blob: string; setBlob: (v: string) => void }) {
  const dbg = useDebugger()
  return (
    <div className="panel">
      <h2>Offer status</h2>
      <MipNpmLink note="Status lookups take a MIP-0005 swapoffer blob — codec in" />
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/api/zswap/status</span></h3>
        <div className="field">
          <label>blob</label>
          <textarea value={blob} onChange={(e) => setBlob(e.target.value)} spellCheck={false} />
        </div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => {
            const b = blob.trim()
            if (!b) return alert('Paste a blob.')
            dbg.call(api.zswapStatus(b))
          }}>Lookup</button>
        </div>
      </div>
    </div>
  )
}
