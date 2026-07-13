import { useEffect, useRef, useState } from 'react'
import { API_BASE, BATCHER_URL, PROOF_SERVER_URL } from './config'
import { useDebugger } from './Debugger'
import { api, type Offer } from './api'
import { buildMakerOfferBlob } from './makerOffer'
import { buildSettlementTxHex } from './takerSettle'
import { indexersMatch } from './wallet'
import type { WalletApp } from './useWalletApp'

const NIGHT = '0000000000000000000000000000000000000000000000000000000000000000'
const MIP_NPM = 'https://www.npmjs.com/package/@effectstream/mip-zswap-offer'

function MipNpmLink({ note }: { note: string }) {
  return (
    <p className="mip-ref">
      {note}{' '}
      <a href={MIP_NPM} target="_blank" rel="noreferrer">@effectstream/mip-zswap-offer</a>
    </p>
  )
}

function short(s: string, n = 24) {
  return !s ? '' : s.length <= n ? s : s.slice(0, n) + '…'
}
function legs(arr?: { token: string; amount: string }[]) {
  if (!arr?.length) return '—'
  return arr.map((x) => `${x.amount} @ ${short(x.token, 8)}`).join(', ')
}

export function OverviewPanel() {
  return (
    <div className="panel">
      <h2>Developer API playground</h2>
      <p className="lead">
        Live debugger for the sync node and batcher, plus a wallet stage for balances and minting.
        Proof server: <code>{PROOF_SERVER_URL}</code>.
      </p>
      <div className="flow">
        <div className="box"><strong>1. Upload</strong>POST /api/zswap/submit</div>
        <div className="arrow">→</div>
        <div className="box"><strong>2. Index</strong>Celestia → offer_file</div>
        <div className="arrow">→</div>
        <div className="box"><strong>3. Accept</strong>balanced tx → midnight-balancer</div>
      </div>
      <div className="callout ok">
        Prefer node submit over the batcher for publishing — structure, proofs, and liveness are checked before any Celestia fee.
      </div>
      <div className="callout warn">
        Accepting is not a REST call with a raw <code>swapoffer1…</code> blob. Build a token-balanced finalized Midnight tx, then POST it to <code>midnight-balancer</code>.
      </div>
      <MipNpmLink note="Offer blobs (MIP-0005) and swap semantics (MIP-0006) are implemented in" />
    </div>
  )
}

export function HealthPanel() {
  const dbg = useDebugger()
  return (
    <div className="panel">
      <h2>Health</h2>
      <p className="lead"><code>ROOT_UNKNOWN</code> often means Midnight sync is still catching up.</p>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/health</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call('GET', `${API_BASE}/health`)}>Send</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/api/health/sync</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call('GET', `${API_BASE}/api/health/sync`)}>Send</button>
        </div>
      </div>
    </div>
  )
}

export function UploadPanel({
  blob,
  setBlob,
  wallet,
}: {
  blob: string
  setBlob: (v: string) => void
  wallet: WalletApp
}) {
  const dbg = useDebugger()
  const [giveId, setGiveId] = useState('WBTC')
  const [wantId, setWantId] = useState('WETH')
  const [giveAmt, setGiveAmt] = useState('100')
  const [wantAmt, setWantAmt] = useState('100')
  const [building, setBuilding] = useState(false)
  const [buildErr, setBuildErr] = useState<string | null>(null)
  const [buildOk, setBuildOk] = useState<string | null>(null)

  const giveTok = wallet.mintable.find((t) => t.name === giveId)!
  const wantTok = wallet.mintable.find((t) => t.name === wantId)!
  const giveBal = wallet.balanceFor(giveTok)
  const wantBal = wallet.balanceFor(wantTok)
  const giveColor = wallet.colorById[giveId]
  const wantColor = wallet.colorById[wantId]

  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)

  // Prefill give amount from balance when give token / balance changes.
  useEffect(() => {
    const bal = BigInt(giveBal || '0')
    if (bal <= 0n) return
    const half = bal / 2n
    setGiveAmt(String(half > 0n ? half : bal))
  }, [giveId, giveBal])

  /** ROOT_UNKNOWN is sometimes transient (node lag). If it persists, Lace is usually
   *  on a different Midnight than this node — retries won't help. */
  const submitWithRootRetry = async (b: string) => {
    const tries = 3
    const delayMs = 5000
    for (let i = 0; ; i++) {
      setSubmitMsg(
        i === 0
          ? 'Submitting…'
          : `ROOT_UNKNOWN — brief retry in case of sync lag… (${i}/${tries})`,
      )
      const r = await dbg.call('POST', `${API_BASE}/api/zswap/submit`, { blob: b })
      if (r.ok) return r
      const code = r.parsed?.error
      if (code === 'ROOT_UNKNOWN' && i < tries) {
        await new Promise((res) => setTimeout(res, delayMs))
        continue
      }
      return r
    }
  }

  const submit = async (poll: boolean) => {
    const b = blob.trim()
    if (!b) return alert('Paste a swapoffer1… blob first.')
    setSubmitting(true)
    setSubmitMsg(null)
    setBuildErr(null)
    try {
      // Quick sync hint before first attempt.
      try {
        const sync = await api.sync()
        if (sync?.status && sync.status !== 'ok') {
          setSubmitMsg(`Node sync status is "${sync.status}" — ROOT_UNKNOWN retries may take a while.`)
        }
      } catch { /* ignore */ }

      const r = await submitWithRootRetry(b)
      if (!r.ok) {
        const code = r.parsed?.error ?? 'ERROR'
        const reason = r.parsed?.reason ?? r.responseText
        const hint = r.parsed?.hint as string | undefined
        const diag = r.parsed?.diagnostics
        if (code === 'ROOT_UNKNOWN') {
          setBuildErr(
            [
              `${code}: ${reason}`,
              hint ?? '',
              diag
                ? `diagnostics: offerRoot=${String(diag.offerRoot).slice(0, 18)}… knownRoots=${diag.knownRootsTotal}@h${diag.knownRootsLatestHeight} midnightTip=${diag.midnightTip} networkId=${diag.nodeNetworkId}`
                : '',
              'This is NOT fixed by waiting — rebuild the offer with Lace on the same network as /api/midnight/config (undeployed → local indexer :8088).',
            ].filter(Boolean).join('\n\n'),
          )
        } else {
          setBuildErr(`${code}: ${reason}`)
        }
        setSubmitMsg(null)
        return
      }
      setSubmitMsg('Submit ok.')
      setBuildOk('Offer accepted by node — forwarded to Celestia.')
      if (!poll) return
      for (let i = 0; i < 20; i++) {
        setSubmitMsg(`Waiting for indexer… (${i + 1}/20)`)
        await new Promise((res) => setTimeout(res, 3000))
        const s = await dbg.call('GET', `${API_BASE}/api/zswap/status?blob=${encodeURIComponent(b)}`)
        if (['open', 'completed', 'expired'].includes(s.parsed?.status)) {
          setSubmitMsg(`Indexed status: ${s.parsed.status}`)
          break
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  const buildOffer = async () => {
    setBuildErr(null)
    setBuildOk(null)
    if (wallet.status !== 'connected' || !wallet.connected) {
      setBuildErr('Connect a wallet first (Wallet tab).')
      return
    }
    if (!wallet.canMint || !wallet.connected.connectedApi) {
      setBuildErr('Building offers requires Lace (browser wallet), not the local seed wallet.')
      return
    }
    if (!giveColor || !wantColor) {
      setBuildErr('Token color unknown — mint each test token once (or wait for known-tokens) so we know its color.')
      return
    }
    if (giveId === wantId) {
      setBuildErr('Give and want must be different tokens.')
      return
    }
    let gAmt: bigint
    let wAmt: bigint
    try {
      gAmt = BigInt(giveAmt.trim())
      wAmt = BigInt(wantAmt.trim())
    } catch {
      setBuildErr('Amounts must be integers (base units).')
      return
    }
    if (gAmt <= 0n || wAmt <= 0n) {
      setBuildErr('Amounts must be > 0.')
      return
    }
    if (gAmt > BigInt(giveBal || '0')) {
      setBuildErr(`Insufficient ${giveTok.name} balance (have ${giveBal}).`)
      return
    }

    setBuilding(true)
    try {
      const cfg = await api.midnightConfig()
      const laceCfg = await wallet.connected.connectedApi.getConfiguration?.().catch(() => null)
      if (laceCfg?.indexerUri && cfg.indexerUri && !indexersMatch(laceCfg.indexerUri, cfg.indexerUri)) {
        setBuildErr(
          `Lace indexer mismatch — makeIntent will prove against a foreign merkle root (ROOT_UNKNOWN).\n` +
          `Lace: ${laceCfg.indexerUri}\n` +
          `node: ${cfg.indexerUri}\n` +
          `Point Lace undeployed at the node indexer, reconnect, remint, then rebuild.`,
        )
        return
      }
      const blobOut = await buildMakerOfferBlob(
        wallet.connected.connectedApi,
        cfg.networkId,
        [{ kind: giveTok.kind, color: giveColor, amount: gAmt }],
        [{ kind: wantTok.kind, color: wantColor, amount: wAmt }],
      )
      setBlob(blobOut)
      setBuildOk(`Built offer (${blobOut.length} chars). Review below, then submit.`)
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e))
    } finally {
      setBuilding(false)
    }
  }

  return (
    <div className="panel">
      <h2>Upload offer</h2>
      <p className="lead">Build a maker offer from your mintable test-token balances, then submit the <code>swapoffer1…</code> blob.</p>
      <MipNpmLink note="MIP-0005 bech32m encoding + MIP-0006 two-sided give/want legs — see" />

      <div className="card">
        <h3>Build from wallet balances</h3>
        <p>
          Uses Lace <code>makeIntent</code> with <code>payFees: false</code> (same path as the example frontend).
          Tokens listed are whatever this network already knows about, plus faucet presets.
        </p>

        {wallet.status !== 'connected' ? (
          <div className="callout warn">Connect a wallet on the Wallet tab first.</div>
        ) : !wallet.canMint ? (
          <div className="callout warn">Offer building needs Lace. Local seed wallet can only show balances.</div>
        ) : (
          <>
            <div className="row">
              <div className="field">
                <label>Give (you spend)</label>
                <select value={giveId} onChange={(e) => setGiveId(e.target.value)}>
                  {wallet.mintable.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} ({t.kind}) · bal {wallet.balanceFor(t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Give amount</label>
                <input value={giveAmt} onChange={(e) => setGiveAmt(e.target.value)} inputMode="numeric" />
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  balance {giveBal}
                  {giveColor ? ` · ${giveColor.slice(0, 12)}…` : ' · color unknown'}
                </div>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>Want (you receive)</label>
                <select value={wantId} onChange={(e) => setWantId(e.target.value)}>
                  {wallet.mintable.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} ({t.kind}) · bal {wallet.balanceFor(t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Want amount</label>
                <input value={wantAmt} onChange={(e) => setWantAmt(e.target.value)} inputMode="numeric" />
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  your bal {wantBal} (taker must fund this)
                  {wantColor ? ` · ${wantColor.slice(0, 12)}…` : ' · color unknown'}
                </div>
              </div>
            </div>
            <div className="actions">
              <button
                className="btn primary"
                type="button"
                disabled={building}
                onClick={buildOffer}
              >
                {building ? 'Building (proving)…' : 'Build offer blob'}
              </button>
              <button className="btn" type="button" onClick={() => wallet.refreshBalances()}>
                Refresh balances
              </button>
            </div>
            {buildErr && <div className="callout err">{buildErr}</div>}
            {buildOk && <div className="callout ok">{buildOk}</div>}
            <div className="callout">
              Mixed shielded↔unshielded swaps may fail in the wallet SDK — prefer A↔B shielded for a first try.
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3><span className="method post">POST</span><span className="path">/api/zswap/submit</span></h3>
        <div className="field">
          <label>blob</label>
          <textarea value={blob} onChange={(e) => setBlob(e.target.value)} placeholder="swapoffer1..." spellCheck={false} />
        </div>
        <div className="actions">
          <button className="btn primary" type="button" disabled={submitting} onClick={() => submit(false)}>
            {submitting ? 'Submitting…' : 'Submit via node'}
          </button>
          <button className="btn" type="button" disabled={submitting} onClick={() => submit(true)}>
            Submit + poll status
          </button>
          <button className="btn" type="button" onClick={() => {
            const b = blob.trim()
            if (!b) return alert('Paste a blob first.')
            dbg.call('POST', `${BATCHER_URL}/send-input`, {
              data: {
                input: b, target: 'celestia', address: 'celestia', addressType: -1,
                signature: '', timestamp: String(Date.now()),
              },
              confirmationLevel: 'wait-receipt',
            })
          }}>Send to Celestia target</button>
        </div>
        {submitMsg && <div className="callout">{submitMsg}</div>}
        <div className="callout warn">
          <code>ROOT_UNKNOWN</code> means Lace&apos;s <code>makeIntent</code> proved against a merkle root
          this node has never synced. Check the Wallet tab — Lace indexer must equal{' '}
          <code>/api/midnight/config</code> (usually <code>http://127.0.0.1:8088/api/v3/graphql</code>).
          <code>networkId=undeployed</code> alone is not enough. Remint + rebuild after fixing Lace.
        </div>
      </div>
    </div>
  )
}

export function AcceptPanel({
  blob, setBlob, selectedId, setSelectedId, wallet,
}: {
  blob: string; setBlob: (v: string) => void
  selectedId: number | null; setSelectedId: (n: number | null) => void
  wallet: WalletApp
}) {
  const dbg = useDebugger()
  const [offers, setOffers] = useState<Offer[]>([])
  const [settleHex, setSettleHex] = useState('')
  const [building, setBuilding] = useState(false)
  const [buildErr, setBuildErr] = useState<string | null>(null)
  const [buildOk, setBuildOk] = useState<string | null>(null)

  const buildSettlement = async () => {
    setBuildErr(null)
    setBuildOk(null)
    const b = blob.trim()
    if (!b) {
      setBuildErr('Select an offer from the book (or paste a swapoffer1… blob on the Upload tab) first.')
      return
    }
    if (wallet.status !== 'connected' || !wallet.connected) {
      setBuildErr('Connect a wallet first (Wallet tab).')
      return
    }
    if (!wallet.canMint || !wallet.connected.connectedApi) {
      setBuildErr('Building settlements requires Lace (browser wallet), not the local seed wallet.')
      return
    }
    setBuilding(true)
    try {
      const cfg = await api.midnightConfig()
      const laceCfg = await wallet.connected.connectedApi.getConfiguration?.().catch(() => null)
      if (laceCfg?.indexerUri && cfg.indexerUri && !indexersMatch(laceCfg.indexerUri, cfg.indexerUri)) {
        setBuildErr(
          `Lace indexer mismatch — the settlement would prove against a foreign merkle root.\n` +
          `Lace: ${laceCfg.indexerUri}\nnode: ${cfg.indexerUri}`,
        )
        return
      }
      const hex = await buildSettlementTxHex(wallet.connected.connectedApi, cfg.networkId, b)
      setSettleHex(hex)
      setBuildOk(`Built settlement tx (${hex.length / 2} bytes). Review below, then settle via batcher.`)
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e))
    } finally {
      setBuilding(false)
    }
  }

  const loadBook = async () => {
    const r = await dbg.call('GET', `${API_BASE}/api/zswaps?limit=50`)
    if (r.ok && Array.isArray(r.parsed)) setOffers(r.parsed)
  }

  return (
    <div className="panel">
      <h2>Accept / settle offer</h2>
      <p className="lead">Load the open book, then hand a token-balanced finalized tx to the batcher.</p>
      <MipNpmLink note="MIP-0005 decode of the maker blob + MIP-0006 imbalance-derived legs — see" />
      <div className="card">
        <h3>Open offer book</h3>
        <div className="actions" style={{ marginBottom: 10 }}>
          <button className="btn primary" type="button" onClick={loadBook}>Refresh book</button>
        </div>
        {offers.length === 0 ? <p className="lead" style={{ margin: 0 }}>No offers loaded yet.</p> : (
          <table className="offers">
            <thead><tr><th>id</th><th>gives</th><th>wants</th><th>height</th><th>blob</th></tr></thead>
            <tbody>
              {offers.map((o) => (
                <tr
                  key={o.id}
                  className={selectedId === o.id ? 'selected' : ''}
                  onClick={() => { setSelectedId(o.id); setBlob(o.transaction_hex) }}
                >
                  <td>{o.id}</td>
                  <td>{legs(o.gives)}</td>
                  <td>{legs(o.wants)}</td>
                  <td>{o.celestia_height ?? ''}</td>
                  <td className="truncate" title={o.transaction_hex}>{short(o.transaction_hex)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h3>Build settlement from wallet</h3>
        <p>
          Balances the selected offer as the taker: Lace supplies the <em>wants</em> legs and receives the{' '}
          <em>gives</em> legs (<code>payFees: false</code> — the batcher pays DUST). Fills the tx hex below.
        </p>
        {wallet.status !== 'connected' ? (
          <div className="callout warn">Connect a wallet on the Wallet tab first.</div>
        ) : !wallet.canMint ? (
          <div className="callout warn">Settlement building needs Lace. Local seed wallet can only show balances.</div>
        ) : (
          <>
            <div className="field">
              <label>selected offer blob</label>
              <textarea value={blob} onChange={(e) => setBlob(e.target.value)} placeholder="swapoffer1… (click a book row above)" spellCheck={false} />
            </div>
            <div className="actions">
              <button className="btn primary" type="button" disabled={building} onClick={buildSettlement}>
                {building ? 'Building (proving)…' : 'Build settlement tx'}
              </button>
              <button className="btn" type="button" onClick={() => wallet.refreshBalances()}>
                Refresh balances
              </button>
            </div>
            {buildErr && <div className="callout err">{buildErr}</div>}
            {buildOk && <div className="callout ok">{buildOk}</div>}
            <div className="callout">
              Your wallet must hold the offer&apos;s <em>wants</em> legs — Lace&apos;s <code>makeIntent</code> hangs
              (no error) if it can&apos;t fund them. Check balances on the Wallet tab first.
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h3><span className="method post">POST</span><span className="path">batcher /send-input · midnight-balancer</span></h3>
        <div className="field">
          <label>tx hex (serialized FinalizedTransaction)</label>
          <textarea value={settleHex} onChange={(e) => setSettleHex(e.target.value)} placeholder="deadbeef..." spellCheck={false} />
        </div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => {
            const hex = settleHex.trim().replace(/^0x/, '')
            if (!hex) return alert('Paste tx hex first.')
            dbg.call('POST', `${BATCHER_URL}/send-input`, {
              data: {
                address: 'midnight-balancer', addressType: -1,
                input: JSON.stringify({ tx: hex, txStage: 'finalized' }),
                signature: '', timestamp: String(Date.now()), target: 'midnight-balancer',
              },
              confirmationLevel: 'wait-receipt',
            })
          }}>Settle via batcher</button>
          <button className="btn" type="button" onClick={() => {
            const b = blob.trim()
            if (!b) return alert('Select an offer or paste a blob.')
            dbg.call('GET', `${API_BASE}/api/zswap/status?blob=${encodeURIComponent(b)}`)
          }}>Check selected offer status</button>
        </div>
      </div>
    </div>
  )
}

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
            dbg.call('GET', `${API_BASE}/api/zswap/status?blob=${encodeURIComponent(b)}`)
          }}>Lookup</button>
        </div>
      </div>
    </div>
  )
}

export function EventsPanel() {
  const [log, setLog] = useState('')
  const sse = useRef<EventSource | null>(null)
  useEffect(() => () => { sse.current?.close() }, [])
  return (
    <div className="panel">
      <h2>Live events</h2>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/api/events</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => {
            sse.current?.close()
            const url = `${API_BASE}/api/events`
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

export function ReadPanels() {
  const dbg = useDebugger()
  const [token, setToken] = useState('')
  const [dir, setDir] = useState('')
  const [from, setFrom] = useState(NIGHT)
  const [to, setTo] = useState('')
  const [amt, setAmt] = useState('1000000')
  const [base, setBase] = useState('')
  const [quote, setQuote] = useState(NIGHT)
  const [color, setColor] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('shielded')

  return (
    <>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/api/zswaps</span></h3>
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
          <button className="btn primary" type="button" onClick={() => {
            const q = new URLSearchParams({ limit: '20' })
            if (token) q.set('token', token)
            if (dir) q.set('direction', dir)
            dbg.call('GET', `${API_BASE}/api/zswaps?${q}`)
          }}>Send</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/api/known-tokens · /api/pairs</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call('GET', `${API_BASE}/api/known-tokens`)}>Tokens</button>
          <button className="btn" type="button" onClick={() => dbg.call('GET', `${API_BASE}/api/pairs`)}>Pairs</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method post">POST</span><span className="path">/api/known-tokens</span></h3>
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
          <button className="btn primary" type="button" onClick={() => dbg.call('POST', `${API_BASE}/api/known-tokens`, { color, name, kind })}>Register</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/api/quote · chart</span></h3>
        <div className="row">
          <div className="field"><label>from_token</label><input value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label>to_token</label><input value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="field"><label>from_amount</label><input value={amt} onChange={(e) => setAmt(e.target.value)} /></div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() =>
            dbg.call('GET', `${API_BASE}/api/quote?${new URLSearchParams({ from_token: from, to_token: to, from_amount: amt })}`)
          }>Quote</button>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field"><label>base</label><input value={base} onChange={(e) => setBase(e.target.value)} /></div>
          <div className="field"><label>quote</label><input value={quote} onChange={(e) => setQuote(e.target.value)} /></div>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => dbg.call('GET', `${API_BASE}/api/chart/stats?${new URLSearchParams({ base, quote })}`)}>Stats</button>
          <button className="btn" type="button" onClick={() => dbg.call('GET', `${API_BASE}/api/chart/history?${new URLSearchParams({ base, quote })}`)}>History</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method get">GET</span><span className="path">/api/midnight/config</span></h3>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => dbg.call('GET', `${API_BASE}/api/midnight/config`)}>Send</button>
        </div>
      </div>
    </>
  )
}

export function ReadPanel() {
  return (
    <div className="panel">
      <h2>Read APIs</h2>
      <p className="lead">Offers, tokens, pairs, market data, Midnight config.</p>
      <MipNpmLink note="Indexed offers expose MIP-0006 derived gives/wants — see" />
      <ReadPanels />
    </div>
  )
}

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
          <button className="btn primary" type="button" onClick={() => dbg.call('GET', `${BATCHER_URL}/health`)}>Health</button>
          <button className="btn" type="button" onClick={() => dbg.call('GET', `${BATCHER_URL}/status`)}>Status</button>
          <button className="btn" type="button" onClick={() => dbg.call('GET', `${BATCHER_URL}/queue-stats`)}>Queue stats</button>
        </div>
      </div>
      <div className="card">
        <h3><span className="method post">POST</span><span className="path">/send-input (raw)</span></h3>
        <div className="field">
          <label>body</label>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} style={{ minHeight: 180 }} />
        </div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={() => {
            try {
              const body = JSON.parse(raw)
              if (!body?.data?.timestamp) {
                body.data = body.data || {}
                body.data.timestamp = String(Date.now())
              }
              dbg.call('POST', `${BATCHER_URL}/send-input`, body)
            } catch (e: any) {
              alert('Invalid JSON: ' + e.message)
            }
          }}>Send raw</button>
        </div>
      </div>
    </div>
  )
}
