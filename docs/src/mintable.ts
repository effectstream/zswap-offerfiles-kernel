/** Fixed domain separators used by packages/contracts-midnight/mint-test-tokens.ts.
 *  Same separators → same token colors across runs. */
export const MINT_AMOUNT = 1000n

export type MintableKind = 'shielded' | 'unshielded'

export type MintableToken = {
  id: string
  name: string
  kind: MintableKind
  /** Registered name variants the node may already have. */
  aliases: string[]
  domainSep: Uint8Array
}

function fill(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte)
}

export const MINTABLE_TOKENS: MintableToken[] = [
  {
    id: 'shieldedA',
    name: 'TestTokenA',
    kind: 'shielded',
    aliases: ['TestTokenA', 'TESTA', 'TESTTOKENA'],
    domainSep: fill(0xa1),
  },
  {
    id: 'shieldedB',
    name: 'TestTokenB',
    kind: 'shielded',
    aliases: ['TestTokenB', 'TESTB', 'TESTTOKENB'],
    domainSep: fill(0xb2),
  },
  {
    id: 'unshielded',
    name: 'TestTokenU',
    kind: 'unshielded',
    aliases: ['TestTokenU', 'TESTU', 'TESTTOKENU'],
    domainSep: fill(0xc3),
  },
]

export const NIGHT_COLOR = '0000000000000000000000000000000000000000000000000000000000000000'
