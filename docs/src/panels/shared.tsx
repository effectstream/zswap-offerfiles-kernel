import { useState, type ReactNode } from 'react'

export const MIP_NPM = 'https://www.npmjs.com/package/@effectstream/mip-zswap-offer'

/** Button that disables itself and spins while its onClick promise is in
 *  flight — batcher `wait-receipt` calls can take a while. */
export function BusyButton({ onClick, busyLabel, className = 'btn primary', children }: {
  onClick: () => unknown | Promise<unknown>
  busyLabel: string
  className?: string
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={className}
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try { await onClick() } finally { setBusy(false) }
      }}
    >
      {busy ? <><span className="spin" />{busyLabel}</> : children}
    </button>
  )
}

export function MipNpmLink({ note }: { note: string }) {
  return (
    <p className="mip-ref">
      {note}{' '}
      <a href={MIP_NPM} target="_blank" rel="noreferrer">@effectstream/mip-zswap-offer</a>
    </p>
  )
}
