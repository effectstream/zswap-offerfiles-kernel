// Build a taker settlement tx for a maker `swapoffer1…` blob using Lace.
// Trimmed port of paima-engine templates/zswap-da browserContract.proveAndSubmitOffer,
// balancing only — the Accept panel submits the returned hex to the batcher itself.
//
// Two strategies, dispatched on the maker tx shape:
//   - segment-0 deltas, no Intent slots (shielded-only) → mirror the legs via
//     makeIntent and merge (balanceSealedTransaction throws "No segments found"
//     on intent-less txs).
//   - any Intent slot present (unshielded / numbered) → balanceSealedTransaction
//     (mirror+merge would collide on Lace's structural Intent[1]).

import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import { Transaction as LedgerV9Transaction } from '@midnightntwrk/ledger-v9'
import { type NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { OfferFiles } from '@effectstream/mip-zswap-offer/mip5'
import { fromHex, toHex } from '../hex'

/** Pick the single segment carrying the swap's asset imbalances. */
function pickSwapSegment(makerTx: any): { segId: number; imbalances: Map<any, bigint> } {
  const intentIds: number[] = makerTx.intents ? Array.from(makerTx.intents.keys()) : []
  const fallibleIds: number[] = makerTx.fallibleOffer ? Array.from(makerTx.fallibleOffer.keys()) : []
  const candidates = Array.from(new Set<number>([0, ...intentIds, ...fallibleIds]))

  const swaps: Array<{ segId: number; imbalances: Map<any, bigint> }> = []
  for (const segId of candidates) {
    let imb: Map<any, bigint>
    try {
      imb = makerTx.imbalances(segId) as Map<any, bigint>
    } catch {
      continue
    }
    const hasAssets = Array.from(imb.entries()).some(([tt, v]) => {
      const tag = (tt as any).tag
      return (tag === 'shielded' || tag === 'unshielded') && v !== 0n
    })
    if (hasAssets) swaps.push({ segId, imbalances: imb })
  }

  if (swaps.length === 0) throw new Error('Maker offer has no asset imbalances — nothing to settle.')
  if (swaps.length > 1) {
    throw new Error(`Multi-segment offers are not supported (segments ${swaps.map((s) => s.segId).join(', ')}).`)
  }
  return swaps[0]!
}

async function balanceViaMirrorMerge(
  connectedApi: ConnectedAPI,
  makerTx: any,
  swap: { segId: number; imbalances: Map<any, bigint> },
): Promise<string> {
  const { shieldedAddress } = await connectedApi.getShieldedAddresses()
  const { unshieldedAddress } = await connectedApi.getUnshieldedAddress()

  const takerInputs: { kind: 'shielded' | 'unshielded'; type: string; value: bigint }[] = []
  const takerOutputs: (typeof takerInputs[number] & { recipient: string })[] = []

  // +N for token T → maker spent N, taker receives N (output).
  // -N for token T → maker outputs N, taker provides N (input).
  for (const [tt, delta] of swap.imbalances) {
    const tag = (tt as any).tag as string
    if (tag !== 'shielded' && tag !== 'unshielded') continue // dust: batcher pays
    const type = (tt as any).raw as string
    if (delta > 0n) {
      takerOutputs.push({
        kind: tag, type, value: delta,
        recipient: tag === 'shielded' ? shieldedAddress : unshieldedAddress,
      })
    } else if (delta < 0n) {
      takerInputs.push({ kind: tag, type, value: -delta })
    }
  }

  // Shielded makeIntent populates no Intent slot; non-1 id is defensive only.
  const { tx: takerTxHex } = await connectedApi.makeIntent(takerInputs as any, takerOutputs as any, {
    intentId: 1000,
    payFees: false,
  })
  const takerTx = LedgerV9Transaction.deserialize('signature', 'proof', 'binding', fromHex(takerTxHex))
  const merged = makerTx.merge(takerTx)
  return toHex(merged.serialize())
}

/**
 * Balance a maker offer blob as the connected wallet. Returns the serialized
 * finalized settlement tx hex, ready for the batcher's midnight-balancer.
 */
export async function buildSettlementTxHex(
  connectedApi: ConnectedAPI,
  networkId: string,
  offerBech32m: string,
): Promise<string> {
  setNetworkId(networkId as NetworkId)
  const rawBytes = OfferFiles.decode(offerBech32m.trim())
  const makerTx = LedgerV9Transaction.deserialize('signature', 'proof', 'binding', rawBytes)

  const swap = pickSwapSegment(makerTx)
  const makerHasIntents = !!makerTx.intents && Array.from(makerTx.intents.keys() as Iterable<number>).length > 0

  if (swap.segId === 0 && !makerHasIntents) {
    return balanceViaMirrorMerge(connectedApi, makerTx, swap)
  }
  const { tx: balancedHex } = await connectedApi.balanceSealedTransaction(toHex(rawBytes), { payFees: false })
  return balancedHex.replace(/^0x/, '')
}
