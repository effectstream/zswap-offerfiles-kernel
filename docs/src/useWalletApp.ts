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
import { useContract } from './useContract'
import { MINT_AMOUNT, MINTABLE_TOKENS, NIGHT_COLOR, type MintableToken } from './mintable'
import { api, type KnownToken, type MidnightConfig } from './api'

export type WalletStatus = 'disconnected' | 'connecting' | 'connected'

export function useWalletApp() {
  const [status, setStatus] = useState<WalletStatus>('disconnected')
  const [connected, setConnected] = useState<Connected | null>(null)
  const [wstate, setWstate] = useState<WalletState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [injected, setInjected] = useState<{ name: string; displayName: string; icon?: string }[]>([])
  const [known, setKnown] = useState<KnownToken[]>([])
  const [colorById, setColorById] = useState<Record<string, string>>({})
  const [mintingId, setMintingId] = useState<string | null>(null)
  const [mintMsg, setMintMsg] = useState<string | null>(null)
  const [nodeMidnight, setNodeMidnight] = useState<MidnightConfig | null>(null)

  const contract = useContract(connected?.connectedApi ?? null)

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
      const tokens = await api.knownTokens()
      setKnown(tokens)
      const map: Record<string, string> = {}
      for (const t of MINTABLE_TOKENS) {
        const hit = tokens.find((k) => t.aliases.includes(k.name) || t.aliases.includes(k.name.toUpperCase()))
        if (hit) map[t.id] = hit.token_color.toLowerCase()
      }
      setColorById((prev) => ({ ...prev, ...map }))
    } catch { /* node down */ }
  }, [])

  const refreshBalances = useCallback(async () => {
    if (!connected) return
    try {
      setWstate(await readState(connected))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [connected])

  useEffect(() => {
    discoverInjected().then(setInjected).catch(() => setInjected([]))
    refreshKnown()
    api.midnightConfig().then(setNodeMidnight).catch(() => setNodeMidnight(null))
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
      setStatus('connected')
    } catch (e: any) {
      setStatus('disconnected')
      setError(e?.message ?? String(e))
    }
  }, [])

  const connectSeed = useCallback(async (seed?: string) => {
    setStatus('connecting')
    setError(null)
    try {
      const c = await connectLocal(seed)
      setConnected(c)
      setWstate(await readState(c))
      setStatus('connected')
    } catch (e: any) {
      setStatus('disconnected')
      setError(e?.message ?? String(e))
    }
  }, [])

  const disconnect = useCallback(() => {
    setConnected(null)
    setWstate(null)
    setStatus('disconnected')
    setError(null)
    setMintMsg(null)
  }, [])

  const balanceFor = useCallback((token: MintableToken): string => {
    const color = colorById[token.id]
    if (!color || !wstate) return '0'
    const bag = token.kind === 'shielded' ? wstate.shieldedBalances : wstate.unshieldedBalances
    return bag[color] ?? bag[color.toLowerCase()] ?? '0'
  }, [colorById, wstate])

  const nightBalance = useCallback((): { shielded: string; unshielded: string } => {
    if (!wstate) return { shielded: '0', unshielded: '0' }
    return {
      shielded: wstate.shieldedBalances[NIGHT_COLOR] ?? '0',
      unshielded: wstate.unshieldedBalances[NIGHT_COLOR] ?? '0',
    }
  }, [wstate])

  const mint = useCallback(async (token: MintableToken) => {
    if (!connected?.connectedApi) {
      setError('Minting requires Lace (browser wallet). Connect Lace, not the local seed wallet.')
      return
    }
    setMintingId(token.id)
    setMintMsg(null)
    setError(null)
    try {
      const res = token.kind === 'shielded'
        ? await contract.mintShielded(token.domainSep, MINT_AMOUNT, BigInt(Date.now()), token.name)
        : await contract.mintUnshielded(token.domainSep, MINT_AMOUNT, token.name)
      setColorById((prev) => ({ ...prev, [token.id]: res.color.toLowerCase() }))
      setMintMsg(`Minted +${MINT_AMOUNT} ${token.name} · color ${res.color.slice(0, 12)}…`)
      await refreshKnown()
      // Give Lace a moment to index, then refresh.
      setTimeout(() => { refreshBalances() }, 2000)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setMintingId(null)
    }
  }, [connected, contract, refreshBalances, refreshKnown])

  return {
    status,
    connected,
    wstate,
    error,
    injected,
    known,
    colorById,
    mintingId,
    mintMsg,
    contractLoading: contract.loading,
    contractError: contract.error,
    proofServer: contract.config?.proofServerUri,
    nodeMidnight,
    laceIndexerOk,
    laceNetworkOk,
    connectLace,
    connectSeed,
    disconnect,
    refreshBalances,
    balanceFor,
    nightBalance,
    mint,
    canMint: connected?.kind === 'injected',
  }
}

export type WalletApp = ReturnType<typeof useWalletApp>
