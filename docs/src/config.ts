import { buildFaucetUrl, DEFAULT_FAUCET_URL } from './faucet-url'

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

// With no public-network choice, Preprod is the canonical default. An explicit
// Preview, Stagenet or local network remains visible instead of being relabelled.
export const FAUCET_NETWORK =
  (import.meta.env.VITE_FAUCET_NETWORK as string | undefined)
  ?? (import.meta.env.VITE_MIDNIGHT_NETWORK_ID as string | undefined)
  ?? 'preprod'

export const FAUCET_URL = buildFaucetUrl(
  (import.meta.env.VITE_FAUCET_URL as string | undefined) ?? DEFAULT_FAUCET_URL,
  FAUCET_NETWORK,
)

export const BATCHER_TARGET =
  (import.meta.env.VITE_BATCHER_TARGET as string | undefined) ?? 'midnight-balancer'
