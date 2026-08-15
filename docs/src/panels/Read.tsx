import { useState } from 'react'
import { useDebugger } from '../Debugger'
import { api } from '../api'
import { NIGHT_COLOR } from '../wallet/mintable'
import { MipNpmLink } from './shared'

export function ReadPanel() {
  const dbg = useDebugger()
  const [token, setToken] = useState('')
  const [dir, setDir] = useState('')
  const [from, setFrom] = useState(NIGHT_COLOR)
  const [to, setTo] = useState('')
  const [amt, setAmt] = useState('1000000')
  const [base, setBase] = useState('')
  const [quote, setQuote] = useState(NIGHT_COLOR)
  const [color, setColor] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('shielded')

  return (
    <div className="panel">
      <h2>Read APIs</h2>
      <p className="lead">Offers, tokens, pairs, market data, Midnight config.</p>
      <MipNpmLink note="Indexed offers expose MIP-0006 derived gives/wants — see" />
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/offers</span></h3>
        <div className="row">
          <div className="field"><label>token</label><input value={token} onChange={(e) => setToken(e.target.value)} /></div>
          <div className="field">
            <label>direction</label>
            <select value={dir} onChange={(e) => setDir(e.target.value)}>
              <option value="">any</option>
              <option value="GIVING">GIVING</option>
              <option value="WANTING">WANTING</option>
            </select>
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() =>
            dbg.call(api.zswaps({ limit: 20, token: token || undefined, direction: dir || undefined }))
          }>Send</button>
        </div>
        <p className="lead" style={{ marginBottom: 0 }}>
          List rows carry <code>offerId</code> instead of the ~24 KB blob —
          fetch a single offer (with blob) below.
        </p>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/offers/:hash</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => {
            const h = prompt('offerId (64 hex chars):')?.trim().toLowerCase()
            if (!h) return
            dbg.call(api.zswapByHash(h))
          }}>Fetch offer by hash</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/known-tokens · /v1/pairs</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call(api.knownTokens())}>Tokens</button>
          <button className="btn" type="button" onClick={() => dbg.call(api.pairs())}>Pairs</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method post">POST</span><span className="path">/v1/known-tokens</span></h3>
        <div className="row">
          <div className="field"><label>color</label><input value={color} onChange={(e) => setColor(e.target.value)} /></div>
          <div className="field"><label>name</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} /></div>
        </div>
        <div className="field">
          <label>kind</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option>shielded</option>
            <option>unshielded</option>
          </select>
        </div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call(api.registerToken(color, name, kind))}>Register</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/quote · chart</span></h3>
        <div className="row">
          <div className="field"><label>from_token</label><input value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label>to_token</label><input value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="field"><label>from_amount</label><input value={amt} onChange={(e) => setAmt(e.target.value)} /></div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call(api.quote(from, to, amt))}>Quote</button>
          <button className="btn" type="button" onClick={() => dbg.call(api.solverLevels())}>Indicative solver levels</button>
        </div>
        <p className="lead" style={{ marginBottom: 0 }}>
          Solver-backed quotes are explicit opt-in market data. <code>quote_semantics: indicative</code> is not a fill reservation.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field"><label>base</label><input value={base} onChange={(e) => setBase(e.target.value)} /></div>
          <div className="field"><label>quote</label><input value={quote} onChange={(e) => setQuote(e.target.value)} /></div>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => dbg.call(api.chartStats(base, quote))}>Stats</button>
          <button className="btn" type="button" onClick={() => dbg.call(api.chartHistory(base, quote))}>History</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/v1/midnight/config</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call(api.midnightConfig())}>Send</button>
        </div>
      </div>
    </div>
  )
}
