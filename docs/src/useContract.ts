import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format'
import { api, type MidnightConfig } from './api'
import { connectBrowserContract, type ConnectedContract } from './browserContract'
import { PROOF_SERVER_URL } from './config'
import { indexersMatch } from './wallet'

export type MintResult = { color: string; txHash: string }

export function useContract(connectedApi: ConnectedAPI | null) {
  const [config, setConfig] = useState<MidnightConfig | null>(null)
  const [connected, setConnected] = useState<ConnectedContract | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef<Promise<ConnectedContract> | null>(null)

  useEffect(() => {
    if (!connectedApi) {
      setConnected(null)
      setConfig(null)
      inflight.current = null
    }
  }, [connectedApi])

  const ensure = useCallback(async (): Promise<ConnectedContract> => {
    if (!connectedApi) throw new Error('Connect Lace (browser wallet) to mint')
    if (connected) return connected
    if (inflight.current) return inflight.current
    setLoading(true)
    setError(null)
    const promise = (async () => {
      console.debug('[mint] ensure: fetching midnight config')
      const cfg = await api.midnightConfig()
      // Override proof server from VITE_PROOF_SERVER_URL.
      const merged: MidnightConfig = {
        ...cfg,
        proofServerUri: PROOF_SERVER_URL || cfg.proofServerUri,
      }
      console.debug('[mint] ensure: config', merged)
      setConfig(merged)
      const status = await connectedApi.getConnectionStatus()
      console.debug('[mint] ensure: wallet connection status', status)
      if (status.status !== 'connected') throw new Error('Browser wallet is not connected')
      if (status.networkId !== cfg.networkId) {
        throw new Error(`Network mismatch: wallet="${status.networkId}" backend="${cfg.networkId}"`)
      }
      const laceCfg = await connectedApi.getConfiguration().catch(() => null)
      console.debug('[mint] ensure: lace config', laceCfg)
      if (laceCfg?.indexerUri && cfg.indexerUri && !indexersMatch(laceCfg.indexerUri, cfg.indexerUri)) {
        throw new Error(
          `Lace indexer mismatch: wallet="${laceCfg.indexerUri}" backend="${cfg.indexerUri}". ` +
          `Mint would land on this node via the batcher, but Lace balances/UI sync elsewhere — ` +
          `point Lace undeployed indexer at the backend URI, reconnect, then retry.`,
        )
      }
      console.debug('[mint] ensure: connecting browser contract')
      const result = await connectBrowserContract(connectedApi, merged)
      console.debug('[mint] ensure: contract connected')
      setConnected(result)
      return result
    })()
    inflight.current = promise
    try {
      return await promise
    } catch (e: any) {
      console.debug('[mint] ensure: failed', e?.message ?? String(e))
      setError(e?.message ?? String(e))
      throw e
    } finally {
      setLoading(false)
      inflight.current = null
    }
  }, [connectedApi, connected])

  const mintShielded = useCallback(async (
    domainSep: Uint8Array,
    amount: bigint,
    nonce: bigint,
    name: string,
  ): Promise<MintResult> => {
    const { contract } = await ensure()
    console.debug('[mint] mintShielded: calling callTx.mint_shielded', { amount, nonce })
    const txData: any = await (contract as any).callTx.mint_shielded(domainSep, amount, nonce)
    console.debug('[mint] mintShielded: callTx returned', { public: txData.public })
    const colorBytes = txData.private?.result?.color as Uint8Array | undefined
    if (!colorBytes) throw new Error('mint_shielded: missing color')
    const color = Array.from(colorBytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const txHash: string = txData.public?.txHash ?? ''
    try { await api.registerToken(color, name, 'shielded') } catch { /* already registered */ }
    return { color, txHash }
  }, [ensure])

  const mintUnshielded = useCallback(async (
    domainSep: Uint8Array,
    amount: bigint,
    name: string,
  ): Promise<MintResult> => {
    if (!connectedApi) throw new Error('Wallet not connected')
    const { contract, config: cfg } = await ensure()
    const { unshieldedAddress } = await connectedApi.getUnshieldedAddress()
    const parsed = MidnightBech32m.parse(unshieldedAddress)
    const decoded = parsed.decode(UnshieldedAddress, (cfg ?? config)!.networkId as any)
    const recipientBytes = new Uint8Array(decoded.data)
    console.debug('[mint] mintUnshielded: calling callTx.mint_unshielded', { amount, unshieldedAddress })
    const txData: any = await (contract as any).callTx.mint_unshielded(
      domainSep,
      amount,
      { bytes: recipientBytes },
    )
    console.debug('[mint] mintUnshielded: callTx returned', { public: txData.public })
    const colorBytes = txData.private?.result as Uint8Array | undefined
    if (!colorBytes) throw new Error('mint_unshielded: missing color')
    const color = Array.from(colorBytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const txHash: string = txData.public?.txHash ?? ''
    try { await api.registerToken(color, name, 'unshielded') } catch { /* already registered */ }
    return { color, txHash }
  }, [connectedApi, ensure, config])

  return { config, loading, error, mintShielded, mintUnshielded }
}
