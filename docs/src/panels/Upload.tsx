import { useEffect, useState } from 'react'
import { useDebugger } from '../Debugger'
import { api, run } from '../api'
import { buildMakerOfferBlob } from '../wallet/makerOffer'
import { preflightLaceIndexer } from '../wallet/wallet'
import type { WalletApp } from '../wallet/useWalletApp'
import { BusyButton, MipNpmLink } from './shared'
import { baseUnitsToCoins } from '../../../packages/solver-core/amount'

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
  const [giveId, setGiveId] = useState('TWBTC')
  const [wantId, setWantId] = useState('TWETH')
  const [giveAmt, setGiveAmt] = useState('100')
  const [wantAmt, setWantAmt] = useState('100')
  const [building, setBuilding] = useState(false)
  const [buildErr, setBuildErr] = useState<string | null>(null)
  const [buildOk, setBuildOk] = useState<string | null>(null)

  const giveTok = wallet.registeredTokens.find((t) => t.name === giveId)
  const wantTok = wallet.registeredTokens.find((t) => t.name === wantId)
  const giveBal = wallet.balanceFor(giveTok)
  const wantBal = wallet.balanceFor(wantTok)
  const giveColor = giveTok?.token_color
  const wantColor = wantTok?.token_color

  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)

  // Prefill give amount from balance when give token / balance changes.
  useEffect(() => {
    const bal = BigInt(giveBal || '0')
    if (bal <= 0n) return
    const half = bal / 2n
    setGiveAmt(String(half > 0n ? half : bal))
  }, [giveId, giveBal])

  // A fresh database may have only NIGHT/SNIGHT until the optional canonical
  // registry import succeeds. Keep both selectors on rows the API actually
  // returned instead of inventing a local faucet preset/color.
  useEffect(() => {
    const tokens = wallet.registeredTokens
    if (tokens.length === 0) return
    if (!tokens.some((token) => token.name === giveId)) setGiveId(tokens[0]!.name)
    if (!tokens.some((token) => token.name === wantId)) setWantId((tokens[1] ?? tokens[0])!.name)
  }, [wallet.registeredTokens, giveId, wantId])

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
      const r = await dbg.call(api.submitOffer(b))
      if (r.ok) return r
      const code = (r.parsed as any)?.error
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
        const sync = await run(api.sync())
        if (sync?.status && sync.status !== 'ok') {
          setSubmitMsg(`Node sync status is "${sync.status}" — ROOT_UNKNOWN retries may take a while.`)
        }
      } catch { /* ignore */ }

      const r = await submitWithRootRetry(b)
      if (!r.ok) {
        const p = r.parsed as any
        const code = p?.error ?? 'ERROR'
        const reason = p?.reason ?? r.responseText
        const hint = p?.hint as string | undefined
        const diag = p?.diagnostics
        if (code === 'ROOT_UNKNOWN') {
          setBuildErr(
            [
              `${code}: ${reason}`,
              hint ?? '',
              diag
                ? `diagnostics: offerRoot=${String(diag.offerRoot).slice(0, 18)}… knownRoots=${diag.knownRootsTotal}@h${diag.knownRootsLatestHeight} midnightTip=${diag.midnightTip} networkId=${diag.nodeNetworkId}`
                : '',
              'This is NOT fixed by waiting — rebuild the offer with Lace on the same network as /v1/midnight/config (undeployed → local indexer :8088).',
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
        const s = await dbg.call(api.zswapStatus(b))
        if (['live', 'consumed', 'cancelled', 'expired', 'unknown'].includes(s.parsed?.status ?? '')) {
          setSubmitMsg(`Indexed status: ${s.parsed!.status}`)
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
    if (!wallet.canBuildOffers || !wallet.connected.connectedApi) {
      setBuildErr('Building offers requires Lace (browser wallet), not the local seed wallet.')
      return
    }
    if (!giveTok || !wantTok || !giveColor || !wantColor) {
      setBuildErr('Select two tokens registered by this node. The optional canonical registry import may have been skipped.')
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
      const { cfg, laceIndexerUri, mismatch } = await preflightLaceIndexer(wallet.connected.connectedApi)
      if (mismatch) {
        setBuildErr(
          `Lace indexer mismatch — makeIntent will prove against a foreign merkle root (ROOT_UNKNOWN).\n` +
          `Lace: ${laceIndexerUri}\n` +
          `node: ${cfg.indexerUri}\n` +
          `Point Lace at the node indexer, reconnect, refresh balances, then rebuild.`,
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
      <p className="lead">Build a maker offer from registered token balances, then submit the <code>swapoffer1…</code> blob.</p>
      <MipNpmLink note="MIP-0005 bech32m encoding + MIP-0006 two-sided give/want legs — see" />

      <div className="card">
        <h3>Build from wallet balances</h3>
        <p>
          Uses Lace <code>makeIntent</code> with <code>payFees: false</code> (same path as the example frontend).
          Tokens listed come from <code>/v1/known-tokens</code>, including canonical tokens
          imported after initialization when the external registry is available.
        </p>

        {wallet.status !== 'connected' ? (
          <div className="callout warn">Connect a wallet on the Wallet tab first.</div>
        ) : !wallet.canBuildOffers ? (
          <div className="callout warn">Offer building needs Lace. Local seed wallet can only show balances.</div>
        ) : (
          <>
            <div className="row">
              <div className="field">
                <label>Give (you spend)</label>
                <select value={giveId} onChange={(e) => setGiveId(e.target.value)}>
                  {wallet.registeredTokens.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} ({t.kind}) · bal {baseUnitsToCoins(BigInt(wallet.balanceFor(t)), t.decimals)}
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
                  {wallet.registeredTokens.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} ({t.kind}) · bal {baseUnitsToCoins(BigInt(wallet.balanceFor(t)), t.decimals)}
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
        <h3><span className="method post">POST</span><span className="path">/v1/offers</span></h3>
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
          <BusyButton className="btn" busyLabel="Sending — waiting for receipt…" onClick={() => {
            const b = blob.trim()
            if (!b) return alert('Paste a blob first.')
            return dbg.call(api.batcherSend({
              data: {
                input: b, target: 'celestia', address: 'celestia', addressType: -1,
                signature: '', timestamp: String(Date.now()),
              },
              confirmationLevel: 'wait-receipt',
            }))
          }}>Send to Celestia target</BusyButton>
        </div>
        {submitMsg && <div className="callout">{submitMsg}</div>}
        <div className="callout warn">
          <code>ROOT_UNKNOWN</code> means Lace&apos;s <code>makeIntent</code> proved against a merkle root
          this node has never synced. Check the Wallet tab — Lace indexer must equal{' '}
          <code>/v1/midnight/config</code> (usually <code>http://127.0.0.1:8088/api/v3/graphql</code>).
          <code>networkId=undeployed</code> alone is not enough. Remint + rebuild after fixing Lace.
        </div>
      </div>
    </div>
  )
}
