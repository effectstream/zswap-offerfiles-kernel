import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format'
import { api, run, type MidnightConfig } from '../api'
import { connectBrowserContract, type ConnectedContract } from './browserContract'
import { PROOF_SERVER_URL } from '../config'
import { preflightLaceIndexer } from './wallet'
import { toHex } from '../hex'
import {
  shieldedUserRecipient,
  unshieldedUserRecipient,
} from '@zswap-da/contract-offer-files/mint-recipient'

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
      const { cfg, laceIndexerUri, mismatch } = await preflightLaceIndexer(connectedApi)
      // Override proof server from VITE_PROOF_SERVER_URL.
      const merged: MidnightConfig = {
        ...cfg,
        proofServerUri: PROOF_SERVER_URL || cfg.proofServerUri,
      }
      setConfig(merged)
      const status = await connectedApi.getConnectionStatus()
      if (status.status !== 'connected') throw new Error('Browser wallet is not connected')
      if (status.networkId !== cfg.networkId) {
        throw new Error(`Network mismatch: wallet="${status.networkId}" backend="${cfg.networkId}"`)
      }
      if (mismatch) {
        throw new Error(
          `Lace indexer mismatch: wallet="${laceIndexerUri}" backend="${cfg.indexerUri}". ` +
          `Mint would land on this node via the batcher, but Lace balances/UI sync elsewhere — ` +
          `point Lace undeployed indexer at the backend URI, reconnect, then retry.`,
        )
      }
      const result = await connectBrowserContract(connectedApi, merged)
      setConnected(result)
      return result
    })()
    inflight.current = promise
    try {
      return await promise
    } catch (e: any) {
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
    const { contract, coinPublicKey } = await ensure()
    const txData: any = await (contract as any).callTx.mint_shielded(
      domainSep,
      amount,
      nonce,
      shieldedUserRecipient(coinPublicKey),
    )
    const colorBytes = txData.private?.result?.color as Uint8Array | undefined
    if (!colorBytes) throw new Error('mint_shielded: missing color')
    const color = toHex(colorBytes)
    const txHash: string = txData.public?.txHash ?? ''
    try { await run(api.registerToken(color, name, 'shielded')) } catch { /* already registered */ }
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
    const txData: any = await (contract as any).callTx.mint_unshielded(
      domainSep,
      amount,
      unshieldedUserRecipient(toHex(recipientBytes)),
    )
    const colorBytes = txData.private?.result as Uint8Array | undefined
    if (!colorBytes) throw new Error('mint_unshielded: missing color')
    const color = toHex(colorBytes)
    const txHash: string = txData.public?.txHash ?? ''
    try { await run(api.registerToken(color, name, 'unshielded')) } catch { /* already registered */ }
    return { color, txHash }
  }, [connectedApi, ensure, config])

  return { config, loading, error, mintShielded, mintUnshielded }
}
