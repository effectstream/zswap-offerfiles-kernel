import { useCallback, useEffect, useState } from 'react'
import {
  connectInjected,
  connectLocal,
  discoverInjected,
  indexersMatch,
  readState,
  type Connected,
  type WalletState,
} from './wallet'
import { NIGHT_COLOR } from './token-colors'
import { api, run, type KnownToken, type MidnightConfig } from '../api'

export type WalletStatus = 'disconnected' | 'connecting' | 'connected'

export function useWalletApp() {
  const [status, setStatus] = useState<WalletStatus>('disconnected')
  const [connected, setConnected] = useState<Connected | null>(null)
  const [wstate, setWstate] = useState<WalletState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [injected, setInjected] = useState<{ name: string; displayName: string; icon?: string }[]>([])
  const [known, setKnown] = useState<KnownToken[]>([])
  const [nodeMidnight, setNodeMidnight] = useState<MidnightConfig | null>(null)

  const laceIndexerOk = Boolean(
    wstate?.laceConfig?.indexerUri
    && nodeMidnight?.indexerUri
    && indexersMatch(wstate.laceConfig.indexerUri, nodeMidnight.indexerUri),
  )
  const laceNetworkOk = Boolean(
    wstate?.laceConfig?.networkId
    && nodeMidnight?.networkId
    && wstate.laceConfig.networkId === nodeMidnight.networkId,
  )

  const refreshKnown = useCallback(async () => {
    try {
      const tokens = await run(api.knownTokens())
      setKnown(tokens)
    } catch { /* node down */ }
  }, [])

  const registeredTokens = known

  const refreshBalances = useCallback(async () => {
    if (!connected) return
    try {
      setWstate(await readState(connected))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [connected])

  // User-triggered refresh reloads registry metadata too. The 15-second
  // balance poll below stays balance-only, so an optional startup import can
  // become visible without a page reload or a new metadata polling loop.
  const refreshWallet = useCallback(async () => {
    await Promise.all([refreshBalances(), refreshKnown()])
  }, [refreshBalances, refreshKnown])

  useEffect(() => {
    discoverInjected().then(setInjected).catch(() => setInjected([]))
    refreshKnown()
    run(api.midnightConfig()).then(setNodeMidnight).catch(() => setNodeMidnight(null))
  }, [refreshKnown])

  useEffect(() => {
    if (status !== 'connected') return
    refreshBalances()
    const id = setInterval(refreshBalances, 15_000)
    return () => clearInterval(id)
  }, [status, refreshBalances])

  const connectLace = useCallback(async (name?: string) => {
    setStatus('connecting')
    setError(null)
    try {
      const c = await connectInjected(name)
      setConnected(c)
      setWstate(await readState(c))
      await refreshKnown()
      setStatus('connected')
    } catch (e: any) {
      setStatus('disconnected')
      setError(e?.message ?? String(e))
    }
  }, [refreshKnown])

  const connectSeed = useCallback(async (seed?: string) => {
    setStatus('connecting')
    setError(null)
    try {
      const c = await connectLocal(seed)
      setConnected(c)
      setWstate(await readState(c))
      await refreshKnown()
      setStatus('connected')
    } catch (e: any) {
      setStatus('disconnected')
      setError(e?.message ?? String(e))
    }
  }, [refreshKnown])

  const disconnect = useCallback(() => {
    setConnected(null)
    setWstate(null)
    setStatus('disconnected')
    setError(null)
  }, [])

  const balanceFor = useCallback((token: KnownToken | undefined): string => {
    if (!token || !wstate) return '0'
    const color = token.token_color.toLowerCase()
    const bag = token.kind === 'shielded' ? wstate.shieldedBalances : wstate.unshieldedBalances
    return bag[color] ?? bag[color.toLowerCase()] ?? '0'
  }, [wstate])

  const nightBalance = useCallback((): { shielded: string; unshielded: string } => {
    if (!wstate) return { shielded: '0', unshielded: '0' }
    return {
      shielded: wstate.shieldedBalances[NIGHT_COLOR] ?? '0',
      unshielded: wstate.unshieldedBalances[NIGHT_COLOR] ?? '0',
    }
  }, [wstate])

  return {
    status,
    connected,
    wstate,
    error,
    injected,
    registeredTokens,
    nodeMidnight,
    laceIndexerOk,
    laceNetworkOk,
    connectLace,
    connectSeed,
    disconnect,
    refreshBalances: refreshWallet,
    balanceFor,
    nightBalance,
    canBuildOffers: connected?.kind === 'injected',
  }
}

export type WalletApp = ReturnType<typeof useWalletApp>
