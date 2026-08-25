import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import { findDeployedContract, type FoundContract } from '@midnight-ntwrk/midnight-js-contracts'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider'
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider'
import {
  type CoinPublicKey,
  type EncPublicKey,
  type FinalizedTransaction,
  Transaction as LedgerV9Transaction,
  type TransactionId,
} from '@midnightntwrk/ledger-v9'
import {
  type MidnightProvider,
  type MidnightProviders,
  type UnboundTransaction,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { type NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { parseCoinPublicKeyToHex, parseEncPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils'
import { OfferFilesContract, witnesses } from '@zswap-da/contract-offer-files'
import { API_BASE, BATCHER_TARGET, BATCHER_URL, PROOF_SERVER_URL } from '../config'
import type { MidnightConfig } from '../api'
import { fromHex, toHex } from '../hex'

export type OfferFilesCircuits = 'mint_shielded' | 'mint_unshielded' | 'incrementNoun'
const PRIVATE_STATE_ID = 'offerFilesPrivateState'
type Providers = MidnightProviders<OfferFilesCircuits, typeof PRIVATE_STATE_ID, {}>
type Found = FoundContract<OfferFilesContract.Contract>

export type ConnectedContract = {
  contract: Found
  config: MidnightConfig
}

async function submitToBatcher(serializedTxHex: string, address: string) {
  const res = await fetch(`${BATCHER_URL}/send-input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        address,
        addressType: 5,
        input: JSON.stringify({ tx: serializedTxHex, txStage: 'finalized' }),
        timestamp: new Date().toISOString(),
        target: BATCHER_TARGET,
      },
      confirmationLevel: 'wait-receipt',
      timeoutMs: 600_000,
    }),
  })
  const body = await res.json()
  if (!res.ok || !body.success) throw new Error(`Batcher error: ${body.message ?? res.statusText}`)
  return body
}

function createWalletProvider(
  connectedApi: ConnectedAPI,
  coinPublicKey: CoinPublicKey,
  encryptionPublicKey: EncPublicKey,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,
    async balanceTx(tx: UnboundTransaction): Promise<FinalizedTransaction> {
      const serialized = toHex(tx.serialize())
      const { tx: balancedHex } = await connectedApi.balanceUnsealedTransaction(serialized, { payFees: false })
      return LedgerV9Transaction.deserialize('signature', 'proof', 'binding', fromHex(balancedHex)) as FinalizedTransaction
    },
    async submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
      const serializedHex = toHex(tx.serialize())
      const identifiers = (tx as any).identifiers?.() as string[] | undefined
      await submitToBatcher(serializedHex, coinPublicKey as unknown as string)
      const identifier = identifiers?.[0]
      if (!identifier) throw new Error('ledger tx returned no identifiers')
      return identifier as TransactionId
    },
  }
}

async function buildProviders(connectedApi: ConnectedAPI, config: MidnightConfig): Promise<Providers> {
  const [shieldedAddresses] = await Promise.all([connectedApi.getShieldedAddresses()])
  const coinPublicKeyHex = parseCoinPublicKeyToHex(
    shieldedAddresses.shieldedCoinPublicKey,
    config.networkId as NetworkId,
  )
  const encPublicKeyHex = parseEncPublicKeyToHex(
    shieldedAddresses.shieldedEncryptionPublicKey,
    config.networkId as NetworkId,
  )
  const walletProvider = createWalletProvider(
    connectedApi,
    coinPublicKeyHex as unknown as CoinPublicKey,
    encPublicKeyHex as unknown as EncPublicKey,
  )

  const safeFetch = (async (input, init) => {
    const res = await fetch(input as any, { ...(init ?? {}), cache: 'no-store' })
    const ct = res.headers.get('content-type') ?? ''
    if (res.ok && ct.toLowerCase().startsWith('text/html')) {
      return new Response(null, { status: 404, statusText: 'Not Found (HTML fallback)' })
    }
    return res
  }) as typeof fetch

  const zkConfigProvider = new FetchZkConfigProvider<OfferFilesCircuits>(API_BASE, safeFetch.bind(window))
  // VITE_PROOF_SERVER_URL wins over whatever /v1/midnight/config reports.
  const proofServerUri = PROOF_SERVER_URL || config.proofServerUri

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStoragePasswordProvider: async () => 'ZSWAP_DA_DOCS_STORAGE_16+',
      accountId: coinPublicKeyHex,
    } as any),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(proofServerUri, zkConfigProvider),
    publicDataProvider: indexerPublicDataProvider(config.indexerUri, config.indexerWsUri),
    walletProvider,
    midnightProvider: walletProvider,
  } as Providers
}

export async function connectBrowserContract(
  connectedApi: ConnectedAPI,
  config: MidnightConfig,
): Promise<ConnectedContract> {
  setNetworkId(config.networkId as any)
  const providers = await buildProviders(connectedApi, config)
  const compiledContract = CompiledContract.make(
    'contract-offer-files',
    OfferFilesContract.Contract as any,
  ).pipe(
    CompiledContract.withWitnesses(witnesses as unknown as never),
    CompiledContract.withCompiledFileAssets('./'),
  )
  const contract = await findDeployedContract(providers, {
    contractAddress: config.contractAddress,
    compiledContract: compiledContract as any,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {},
  })
  return { contract: contract as Found, config }
}
