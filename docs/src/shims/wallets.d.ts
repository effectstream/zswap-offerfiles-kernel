// Loose type shim — package ships raw .ts that strict tsc rejects.
export interface WalletLoginSuccess {
  success: true
  result: { provider: any; walletAddress: any; metadata: { name: string; displayName?: string; icon?: string } }
}
export interface WalletLoginFailure {
  success: false
  errorMessage?: string
  message?: string
}
export function walletLogin(info: any): Promise<WalletLoginSuccess | WalletLoginFailure>

export interface InjectedOption {
  metadata: { name: string; displayName?: string; icon?: string }
  api: () => Promise<any>
}
export function allInjectedWallets(config?: {
  signatureSupport: boolean
  transactionSupport: boolean
}): Promise<Record<number, InjectedOption[]>>
