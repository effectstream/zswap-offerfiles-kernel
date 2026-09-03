import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import { walletLogin, allInjectedWallets } from '@effectstream/wallets'
import { api, run, type MidnightConfig } from '../api'
import { NETWORK_ID, PROOF_SERVER_URL } from '../config'

const MODE_MIDNIGHT = 3

export type WalletKind = 'injected' | 'local'

export type Connected = {
  kind: WalletKind
  name: string
  connectedApi: ConnectedAPI | null
  localApi: any | null
}

/** Lace `getConfiguration()` — the indexer Lace actually syncs/proves against. */
export type LaceConfig = {
  indexerUri: string
  indexerWsUri: string
  substrateNodeUri: string
  networkId: string
  proverServerUri?: string
}

export type WalletState = {
  shieldedAddress: string | null
  unshieldedAddress: string | null
  shieldedBalances: Record<string, string>
  unshieldedBalances: Record<string, string>
  laceConfig: LaceConfig | null
}

/** Normalize indexer URLs so localhost vs 127.0.0.1 / trailing slash / v3↔v4 still match.
 *  Indexer 4.x serves `/api/v4` as canonical and `/api/v3` as a compatibility alias. */
export function normalizeIndexerUri(uri: string): string {
  try {
    const u = new URL(uri)
    const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname
    let path = u.pathname.replace(/\/+$/, '') || ''
    path = path.replace(/\/api\/v3(\/|$)/, '/api/v4$1')
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${path}`.toLowerCase()
  } catch {
    return uri.trim().replace(/\/+$/, '').replace(/\/api\/v3(\/|$)/, '/api/v4$1').toLowerCase()
  }
}

export function indexersMatch(a: string, b: string): boolean {
  return normalizeIndexerUri(a) === normalizeIndexerUri(b)
}

/** Shared preflight for anything that proves via Lace (makeIntent, mint):
 *  fetch the node's midnight config and compare Lace's indexer against it.
 *  A mismatch means Lace proves against a foreign merkle root → ROOT_UNKNOWN. */
export async function preflightLaceIndexer(connectedApi: ConnectedAPI): Promise<{
  cfg: MidnightConfig
  laceIndexerUri: string | null
  mismatch: boolean
}> {
  const cfg = await run(api.midnightConfig())
  const laceCfg = await connectedApi.getConfiguration?.().catch(() => null)
  const laceIndexerUri = laceCfg?.indexerUri ?? null
  const mismatch = Boolean(laceIndexerUri && cfg.indexerUri && !indexersMatch(laceIndexerUri, cfg.indexerUri))
  return { cfg, laceIndexerUri, mismatch }
}

const stringify = (m: Record<string, bigint> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [t, a] of Object.entries(m ?? {})) out[t] = String(a)
  return out
}

export async function discoverInjected(): Promise<{ name: string; displayName: string; icon?: string }[]> {
  const all = await allInjectedWallets({ signatureSupport: true, transactionSupport: true })
  const opts = all[MODE_MIDNIGHT] ?? []
  return opts.map((o) => ({
    name: o.metadata.name,
    displayName: o.metadata.displayName ?? o.metadata.name,
    icon: o.metadata.icon,
  }))
}

export async function connectInjected(name?: string): Promise<Connected> {
  const res = await walletLogin({
    mode: MODE_MIDNIGHT,
    preference: name ? { name } : undefined,
    networkId: NETWORK_ID,
  })
  if (!res.success) throw new Error(res.errorMessage ?? res.message ?? 'wallet connect failed')
  const provider = res.result.provider
  const connectedApi = provider.getConnection().api as ConnectedAPI
  return {
    kind: 'injected',
    name: res.result.metadata?.name ?? name ?? 'midnight',
    connectedApi,
    localApi: null,
  }
}

/** Built-in JS wallet (undeployed). Good for balance inspection; mint needs Lace. */
export async function connectLocal(seed?: string): Promise<Connected> {
  const { MidnightLocalConnector } = await import('@effectstream/wallets/midnight-local')
  const cfg = await run(api.midnightConfig()).catch(() => null)
  const host = typeof location !== 'undefined' ? location.hostname : '127.0.0.1'
  // Match the page's scheme: on an https page the browser hard-blocks
  // http/ws (mixed content), so the localhost fallbacks must upgrade too.
  const secure = typeof location !== 'undefined' && location.protocol === 'https:'
  const httpScheme = secure ? 'https' : 'http'
  const wsScheme = secure ? 'wss' : 'ws'
  const networkUrls = {
    indexer: cfg?.indexerUri ?? `${httpScheme}://${host}:8088/api/v3/graphql`,
    indexerWS: cfg?.indexerWsUri ?? `${wsScheme}://${host}:8088/api/v3/graphql/ws`,
    node: (cfg as any)?.nodeUri ?? `${httpScheme}://${host}:9944`,
    proofServer: PROOF_SERVER_URL || cfg?.proofServerUri || `${httpScheme}://${host}:6300`,
  }
  const provider = await MidnightLocalConnector.instance().connectFromSeed({
    seed,
    networkId: NETWORK_ID,
    networkUrls,
    syncMode: 'all',
  })
  const localApi = (provider as any).getConnection().api
  return { kind: 'local', name: 'midnight-local', connectedApi: null, localApi }
}

export async function readState(c: Connected): Promise<WalletState> {
  if (c.kind === 'injected' && c.connectedApi) {
    const a = c.connectedApi as any
    const [sh, unsh, shB, unshB, cfg] = await Promise.all([
      a.getShieldedAddresses(),
      a.getUnshieldedAddress(),
      a.getShieldedBalances(),
      a.getUnshieldedBalances(),
      typeof a.getConfiguration === 'function'
        ? a.getConfiguration().catch(() => null)
        : Promise.resolve(null),
    ])
    const laceConfig: LaceConfig | null = cfg
      ? {
          indexerUri: String(cfg.indexerUri ?? ''),
          indexerWsUri: String(cfg.indexerWsUri ?? ''),
          substrateNodeUri: String(cfg.substrateNodeUri ?? ''),
          networkId: String(cfg.networkId ?? ''),
          proverServerUri: cfg.proverServerUri ? String(cfg.proverServerUri) : undefined,
        }
      : null
    return {
      shieldedAddress: sh.shieldedAddress ?? null,
      unshieldedAddress: unsh.unshieldedAddress ?? null,
      shieldedBalances: stringify(shB),
      unshieldedBalances: stringify(unshB),
      laceConfig,
    }
  }
  const facade = c.localApi?.walletFacade as any
  let shieldedBalances: Record<string, string> = {}
  let unshieldedBalances: Record<string, string> = {}
  try {
    const shState = await facade.shielded.waitForSyncedState()
    shieldedBalances = stringify(shState?.balances)
  } catch { /* still syncing */ }
  try {
    const unState = await facade.unshielded.waitForSyncedState()
    unshieldedBalances = stringify(unState?.balances)
  } catch { /* still syncing */ }
  return {
    shieldedAddress: c.localApi?.shieldedAddress ?? null,
    unshieldedAddress: c.localApi?.unshieldedAddress ?? null,
    shieldedBalances,
    unshieldedBalances,
    laceConfig: null,
  }
}
