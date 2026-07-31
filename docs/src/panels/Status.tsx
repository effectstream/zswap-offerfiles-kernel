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
        <h3><span className="method post">POST</span><span className="path">/v1/offers/status</span></h3>
        <p className="lead">
          POST body, not query string — a real offer blob is 16–25 KB, beyond
          any practical URL length.
        </p>
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
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/offers/:hash/status</span></h3>
        <p className="lead">
          Status by content hash (sha256 of the raw offer bytes) — stable across
          nodes, unlike local row ids. Get it from the book or a submit response.
        </p>
        <div className="actions">
          <button className="btn" type="button" onClick={() => {
            const h = prompt('offerId (64 hex chars):')?.trim().toLowerCase()
            if (!h) return
            dbg.call(api.zswapStatusByHash(h))
          }}>Lookup by hash</button>
        </div>
      </div>
    </div>
  )
}
