export const DEFAULT_FAUCET_URL = 'https://mint-test-tokens.pages.dev/'

/** Preserve an operator's path/query while setting only the selected network. */
export function buildFaucetUrl(baseUrl: string, network: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('network', network)
  return url.toString()
}
