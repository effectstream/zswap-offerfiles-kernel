import { MINT_AMOUNT, NIGHT_COLOR } from '../wallet/mintable'
import { PROOF_SERVER_URL } from '../config'
import type { WalletApp } from '../wallet/useWalletApp'

function short(a: string | null | undefined, n = 18) {
  if (!a) return '—'
  return a.length <= n ? a : `${a.slice(0, 10)}…${a.slice(-6)}`
}

export function WalletStage({ wallet }: { wallet: WalletApp }) {
  const night = wallet.nightBalance()

  return (
    <div className="panel">
      <h2>Wallet</h2>
      <p className="lead">
        Connect a Midnight wallet, inspect balances, and mint the fixed test tokens
        (same domain separators as <code>mint-test-tokens</code>). Proof server:{' '}
        <code>{wallet.proofServer ?? PROOF_SERVER_URL}</code> via <code>VITE_PROOF_SERVER_URL</code>.
      </p>

      <div className="card">
        <h3>Connect</h3>
        <p>
          Status: <strong>{wallet.status}</strong>
          {wallet.connected ? ` · ${wallet.connected.kind} · ${wallet.connected.name}` : ''}
        </p>
        {wallet.status !== 'connected' ? (
          <div className="actions">
            <button className="btn primary" type="button" disabled={wallet.status === 'connecting'} onClick={() => wallet.connectLace()}>
              {wallet.status === 'connecting' ? 'Connecting…' : 'Connect Lace'}
            </button>
            {wallet.injected.map((w) => (
              <button key={w.name} className="btn" type="button" onClick={() => wallet.connectLace(w.name)}>
                {w.displayName}
              </button>
            ))}
            <button className="btn" type="button" disabled={wallet.status === 'connecting'} onClick={() => wallet.connectSeed()}>
              Connect local seed (dev)
            </button>
          </div>
        ) : (
          <div className="actions">
            <button className="btn" type="button" onClick={() => wallet.refreshBalances()}>Refresh balances</button>
            <button className="btn danger" type="button" onClick={wallet.disconnect}>Disconnect</button>
          </div>
        )}
        {!wallet.canMint && wallet.status === 'connected' && (
          <div className="callout warn">
            Local seed wallet can show balances. Minting needs Lace (browser ConnectedAPI).
          </div>
        )}
        {(wallet.error || wallet.contractError) && (
          <div className="callout err">{wallet.error || wallet.contractError}</div>
        )}
        {wallet.mintMsg && <div className="callout ok">{wallet.mintMsg}</div>}
      </div>

      {wallet.status === 'connected' && wallet.wstate && (
        <>
          <div className="card">
            <h3>Lace ↔ node network</h3>
            {wallet.wstate.laceConfig ? (
              <>
                <div className="wallet-row">
                  <div>
                    <div className="name">networkId</div>
                    <div className="meta-line">
                      Lace <code>{wallet.wstate.laceConfig.networkId || '—'}</code>
                      {' · '}
                      node <code>{wallet.nodeMidnight?.networkId ?? '—'}</code>
                    </div>
                  </div>
                  <span className={`badge ${wallet.laceNetworkOk ? 'ok' : 'err'}`}>
                    {wallet.laceNetworkOk ? 'match' : 'mismatch'}
                  </span>
                </div>
                <div className="wallet-row">
                  <div>
                    <div className="name">indexer</div>
                    <div className="addr" title={wallet.wstate.laceConfig.indexerUri}>
                      Lace: {wallet.wstate.laceConfig.indexerUri || '—'}
                    </div>
                    <div className="addr" title={wallet.nodeMidnight?.indexerUri}>
                      node: {wallet.nodeMidnight?.indexerUri ?? '—'}
                    </div>
                  </div>
                  <span className={`badge ${wallet.laceIndexerOk ? 'ok' : 'err'}`}>
                    {wallet.laceIndexerOk ? 'match' : 'mismatch'}
                  </span>
                </div>
                {!wallet.laceIndexerOk && (
                  <div className="callout err">
                    Lace is not pointed at this stack&apos;s indexer. In Lace → Midnight
                    undeployed settings, set indexer to{' '}
                    <code>{wallet.nodeMidnight?.indexerUri ?? 'http://127.0.0.1:8088/api/v3/graphql'}</code>
                    {' '}(and matching WS), reconnect, remint, then rebuild offers.
                    <code>networkId=undeployed</code> alone is not enough.
                  </div>
                )}
              </>
            ) : (
              <div className="callout warn">
                Wallet did not expose <code>getConfiguration()</code> — cannot verify Lace indexer.
                Local seed wallet has no Lace config.
              </div>
            )}
          </div>

          <div className="card">
            <h3>Addresses</h3>
            <div className="wallet-row">
              <div>
                <div className="name">Shielded</div>
                <div className="addr">{wallet.wstate.shieldedAddress ?? '—'}</div>
              </div>
            </div>
            <div className="wallet-row">
              <div>
                <div className="name">Unshielded</div>
                <div className="addr">{wallet.wstate.unshieldedAddress ?? '—'}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>NIGHT balances</h3>
            <div className="wallet-row">
              <div>
                <div className="name">Shielded NIGHT</div>
                <div className="meta-line">{NIGHT_COLOR.slice(0, 16)}…</div>
              </div>
              <div className="addr">{night.shielded}</div>
            </div>
            <div className="wallet-row">
              <div>
                <div className="name">Unshielded NIGHT</div>
                <div className="meta-line">{NIGHT_COLOR.slice(0, 16)}…</div>
              </div>
              <div className="addr">{night.unshielded}</div>
            </div>
          </div>

          <div className="card">
            <h3>Mintable tokens</h3>
            <p>
              Preset shortcuts plus whatever <code>/api/known-tokens</code> already has for this
              network. Each mint adds <code>+{String(MINT_AMOUNT)}</code>.
            </p>
            {wallet.mintable.map((t) => {
              const bal = wallet.balanceFor(t)
              const color = wallet.colorById[t.name]
              return (
                <div className="wallet-row" key={t.name}>
                  <div>
                    <div className="name">{t.name} <span className="meta-line">({t.kind})</span></div>
                    <div className="meta-line">
                      balance {bal}
                      {color ? ` · ${short(color, 20)}` : ' · color unknown until first mint / known-tokens'}
                    </div>
                  </div>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!wallet.canMint || wallet.mintingId === t.name || wallet.contractLoading}
                    onClick={() => wallet.mint(t)}
                  >
                    {wallet.mintingId === t.name ? 'Minting…' : `Mint +${String(MINT_AMOUNT)}`}
                  </button>
                </div>
              )
            })}
          </div>

          <div className="card">
            <h3>All wallet balances</h3>
            <h4 style={{ margin: '8px 0 4px', fontSize: 12, color: 'var(--muted)' }}>Shielded</h4>
            {Object.keys(wallet.wstate.shieldedBalances).length === 0 ? (
              <p>None</p>
            ) : (
              <table className="offers">
                <thead><tr><th>color</th><th>amount</th></tr></thead>
                <tbody>
                  {Object.entries(wallet.wstate.shieldedBalances).map(([c, a]) => (
                    <tr key={c}><td className="truncate" title={c}>{c}</td><td>{a}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <h4 style={{ margin: '12px 0 4px', fontSize: 12, color: 'var(--muted)' }}>Unshielded</h4>
            {Object.keys(wallet.wstate.unshieldedBalances).length === 0 ? (
              <p>None</p>
            ) : (
              <table className="offers">
                <thead><tr><th>color</th><th>amount</th></tr></thead>
                <tbody>
                  {Object.entries(wallet.wstate.unshieldedBalances).map(([c, a]) => (
                    <tr key={c}><td className="truncate" title={c}>{c}</td><td>{a}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
