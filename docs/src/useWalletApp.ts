import { useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  domainSepFromName,
  MINT_AMOUNT,
  NIGHT_COLOR,
  PRESET_TOKENS,
  type MintableKind,
  type MintableToken,
} from './mintable'
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
      for (const t of tokens) map[t.name] = t.token_color.toLowerCase()
      setColorById((prev) => ({ ...prev, ...map }))
    } catch { /* node down */ }
  }, [])

  // Preset shortcuts ∪ whatever this network's node already knows about (minus
  // NIGHT) — same-named tokens dedupe, so a preset already minted here just
  // shows its real color instead of a second placeholder entry.
  const mintable = useMemo<MintableToken[]>(() => {
    const byName = new Map(PRESET_TOKENS.map((t) => [t.name, t]))
    for (const k of known) {
      if (k.token_color.toLowerCase() === NIGHT_COLOR) continue
      if (!byName.has(k.name)) {
        byName.set(k.name, { name: k.name, kind: k.kind as MintableKind, domainSep: domainSepFromName(k.name) })
      }
    }
    return Array.from(byName.values())
  }, [known])

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
    const color = colorById[token.name]
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
    setMintingId(token.name)
    setMintMsg(null)
    setError(null)
    console.debug('[mint] start', { kind: token.kind, name: token.name })
    try {
      const res = token.kind === 'shielded'
        ? await contract.mintShielded(token.domainSep, MINT_AMOUNT, BigInt(Date.now()), token.name)
        : await contract.mintUnshielded(token.domainSep, MINT_AMOUNT, token.name)
      console.debug('[mint] done', { name: token.name, color: res.color, txHash: res.txHash })
      setColorById((prev) => ({ ...prev, [token.name]: res.color.toLowerCase() }))
      setMintMsg(`Minted +${MINT_AMOUNT} ${token.name} · color ${res.color.slice(0, 12)}…`)
      await refreshKnown()
      // Give Lace a moment to index, then refresh.
      setTimeout(() => { refreshBalances() }, 2000)
    } catch (e: any) {
      console.debug('[mint] failed', { name: token.name, error: e?.message ?? String(e) })
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
    mintable,
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
