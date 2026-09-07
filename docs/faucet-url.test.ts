import { describe, expect, test } from 'bun:test'
import { buildFaucetUrl, DEFAULT_FAUCET_URL } from './src/faucet-url'

describe('external faucet URL', () => {
  test('defaults to the final host and Preprod selection', () => {
    expect(buildFaucetUrl(DEFAULT_FAUCET_URL, 'preprod'))
      .toBe('https://mint-test-tokens.pages.dev/?network=preprod')
  })

  test('preserves a configured base path/query and explicit network', () => {
    expect(buildFaucetUrl('https://78001abb.mint-test-tokens.pages.dev/mint?campaign=dev&network=preprod', 'preview'))
      .toBe('https://78001abb.mint-test-tokens.pages.dev/mint?campaign=dev&network=preview')
    expect(buildFaucetUrl('http://localhost:12345/?x=1', 'undeployed'))
      .toBe('http://localhost:12345/?x=1&network=undeployed')
  })
})
