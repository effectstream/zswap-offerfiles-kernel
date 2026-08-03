import { useState } from 'react'
import { useDebugger } from '../Debugger'
import { api, type Offer } from '../api'
import { buildSettlementTxHex } from '../wallet/takerSettle'
import { preflightLaceIndexer } from '../wallet/wallet'
import type { WalletApp } from '../wallet/useWalletApp'
import { BusyButton, MipNpmLink } from './shared'

function short(s: string, n = 24) {
  return !s ? '' : s.length <= n ? s : s.slice(0, n) + '…'
}
function legs(arr?: { token: string; amount: string }[]) {
  if (!arr?.length) return '—'
  return arr.map((x) => `${x.amount} @ ${short(x.token, 8)}`).join(', ')
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
      const { cfg, laceIndexerUri, mismatch } = await preflightLaceIndexer(wallet.connected.connectedApi)
      if (mismatch) {
        setBuildErr(
          `Lace indexer mismatch — the settlement would prove against a foreign merkle root.\n` +
          `Lace: ${laceIndexerUri}\nnode: ${cfg.indexerUri}`,
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
    const r = await dbg.call(api.zswaps({ limit: 50 }))
    if (r.ok && Array.isArray(r.parsed?.offers)) setOffers(r.parsed.offers)
  }

  // The list no longer carries blobs (they're ~24 KB each) — fetch the
  // selected offer's blob by content hash on click.
  const selectOffer = async (o: Offer) => {
    setSelectedId(o.id)
    if (!o.offer_hash) {
      setBlob('')
      setBuildErr('Legacy offer without a content hash — paste its blob manually.')
      return
    }
    const r = await dbg.call(api.zswapByHash(o.offer_hash))
    if (r.ok && r.parsed?.blob) setBlob(r.parsed.blob)
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
            <thead><tr><th>hash</th><th>gives</th><th>wants</th><th>height</th><th>blob</th></tr></thead>
            <tbody>
              {offers.map((o) => (
                <tr
                  key={o.id}
                  className={selectedId === o.id ? 'selected' : ''}
                  onClick={() => selectOffer(o)}
                >
                  <td className="truncate" title={o.offer_hash ?? ''}>{short(o.offer_hash ?? String(o.id), 12)}</td>
                  <td>{legs(o.gives)}</td>
                  <td>{legs(o.wants)}</td>
                  <td>{o.celestia_height ?? ''}</td>
                  <td>{o.blob_chars ? `${o.blob_chars} chars` : '—'}</td>
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
          <BusyButton busyLabel="Settling — waiting for receipt…" onClick={() => {
            const hex = settleHex.trim().replace(/^0x/, '')
            if (!hex) return alert('Paste tx hex first.')
            return dbg.call(api.batcherSend({
              data: {
                address: 'midnight-balancer', addressType: -1,
                input: JSON.stringify({ tx: hex, txStage: 'finalized' }),
                signature: '', timestamp: String(Date.now()), target: 'midnight-balancer',
              },
              confirmationLevel: 'wait-receipt',
            }))
          }}>Settle via batcher</BusyButton>
          <button className="btn" type="button" onClick={() => {
            const b = blob.trim()
            if (!b) return alert('Select an offer or paste a blob.')
            dbg.call(api.zswapStatus(b))
          }}>Check selected offer status</button>
        </div>
      </div>
    </div>
  )
}
