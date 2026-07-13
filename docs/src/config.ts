const host = typeof location !== 'undefined' ? location.hostname : '127.0.0.1'

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? `http://${host}:9999`

export const BATCHER_URL =
  (import.meta.env.VITE_BATCHER_URL as string | undefined) ?? `http://${host}:3334`

/** Proof server for midnight-js HTTP prover. Local stack: :6300 */
export const PROOF_SERVER_URL =
  (import.meta.env.VITE_PROOF_SERVER_URL as string | undefined) ?? `http://${host}:6300`

export const NETWORK_ID =
  (import.meta.env.VITE_MIDNIGHT_NETWORK_ID as string | undefined) ?? 'undeployed'

export const BATCHER_TARGET =
  (import.meta.env.VITE_BATCHER_TARGET as string | undefined) ?? 'midnight-balancer'
