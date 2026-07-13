/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_BATCHER_URL?: string
  readonly VITE_PROOF_SERVER_URL?: string
  readonly VITE_MIDNIGHT_NETWORK_ID?: string
  readonly VITE_BATCHER_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  midnight?: Record<string, {
    name: string
    rdns: string
    icon?: string
    apiVersion: string
    connect: (networkId: string) => Promise<unknown>
  }>
}
