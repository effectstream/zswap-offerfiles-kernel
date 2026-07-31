import { PROOF_SERVER_URL } from '../config'
import { MipNpmLink } from './shared'

const REPO = 'https://github.com/effectstream/zswap-offerfiles-kernel'

export function OverviewPanel() {
  return (
    <div className="panel">
      <h2>Developer API playground</h2>
      <p className="lead">
        Live debugger for the sync node and batcher, plus a wallet stage for balances and minting.
        Proof server: <code>{PROOF_SERVER_URL}</code>.
      </p>
      <div className="flow">
        <div className="box"><strong>1. Upload</strong>POST /v1/offers</div>
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
      <p className="mip-ref">
        Full endpoint reference:{' '}
        <a href={`${REPO}/blob/main/API.md`} target="_blank" rel="noreferrer">API.md</a>
        {' · '}runnable scripts per endpoint:{' '}
        <a href={`${REPO}/tree/main/api-examples`} target="_blank" rel="noreferrer">api-examples/</a>
      </p>
      <MipNpmLink note="Offer blobs (MIP-0005) and swap semantics (MIP-0006) are implemented in" />
    </div>
  )
}
