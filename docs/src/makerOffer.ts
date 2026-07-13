import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import { type NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { bech32m } from '@scure/base'

export type OfferLeg = {
  kind: 'shielded' | 'unshielded'
  color: string
  amount: bigint
}

const OFFER_HRP = 'swapoffer'
const NO_LIMIT = false as unknown as number

function encodeOffer(transactionBytes: Uint8Array): string {
  return bech32m.encode(OFFER_HRP, bech32m.toWords(transactionBytes), NO_LIMIT)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function decodeConnectorTx(tx: string): Uint8Array {
  const isHex = /^(0x)?[0-9a-fA-F]+$/.test(tx) && tx.replace(/^0x/, '').length % 2 === 0
  return isHex ? hexToBytes(tx) : base64ToBytes(tx)
}

function pickMakerIntentId(): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return Math.max(2, buf[0]! & 0x7fffffff)
}

/** Build a payFees:false maker offer blob via Lace makeIntent. */
export async function buildMakerOfferBlob(
  connectedApi: ConnectedAPI,
  networkId: string,
  gives: OfferLeg[],
  wants: OfferLeg[],
): Promise<string> {
  if (typeof (connectedApi as any).makeIntent !== 'function') {
    throw new Error(
      'This wallet does not support makeIntent — update Lace to a version with the Midnight swap-intent API.',
    )
  }
  const { shieldedAddress } = await connectedApi.getShieldedAddresses()
  const { unshieldedAddress } = await connectedApi.getUnshieldedAddress()

  const inputs = gives.map((g) => ({ kind: g.kind, type: g.color, value: g.amount }))
  const outputs = wants.map((w) => ({
    kind: w.kind,
    type: w.color,
    value: w.amount,
    recipient: w.kind === 'shielded' ? shieldedAddress : unshieldedAddress,
  }))

  const { tx } = await connectedApi.makeIntent(inputs as any, outputs as any, {
    intentId: pickMakerIntentId(),
    payFees: false,
  } as any)

  setNetworkId(networkId as NetworkId)
  return encodeOffer(decodeConnectorTx(tx))
}
