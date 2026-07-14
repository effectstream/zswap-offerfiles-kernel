export const MINT_AMOUNT = 1000n

export type MintableKind = 'shielded' | 'unshielded'

export type MintableToken = {
  name: string
  kind: MintableKind
  domainSep: Uint8Array
}

const FAUCET_PREFIX = 'zswap-da-faucet:'

/** Deterministic 32-byte domain separator from a token name — same derivation
 *  as the zswap-da frontend's Faucet (packages/frontend-new/src/screens/Faucet.tsx),
 *  so minting a name here lands on the same color as minting it there, and
 *  re-minting the same name accumulates balance instead of forking colors. */
export function domainSepFromName(name: string): Uint8Array {
  const out = new Uint8Array(32)
  const enc = new TextEncoder().encode(FAUCET_PREFIX + name)
  let h = 2166136261 >>> 0
  for (let i = 0; i < 32; i++) {
    h = (h ^ (enc[i % enc.length] ?? i + 7)) >>> 0
    h = Math.imul(h, 16777619) >>> 0
    out[i] = h & 0xff
  }
  return out
}

function preset(name: string, kind: MintableKind): MintableToken {
  return { name, kind, domainSep: domainSepFromName(name) }
}

/** UI shortcuts, not a fixed per-network list — same names as the production
 *  Faucet so presets line up with whatever's already minted on a given network. */
export const PRESET_TOKENS: MintableToken[] = [
  preset('WBTC', 'shielded'),
  preset('WETH', 'shielded'),
  preset('USDC', 'shielded'),
  preset('ZTOKEN', 'shielded'),
  preset('ATOKEN', 'unshielded'),
  preset('BTOKEN', 'unshielded'),
]

export const NIGHT_COLOR = '0000000000000000000000000000000000000000000000000000000000000000'
