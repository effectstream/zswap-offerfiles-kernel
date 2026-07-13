import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import nodePolyfills from 'vite-plugin-node-stdlib-browser'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const cryptoShim = resolve(projectRoot, 'src/shims/crypto.ts')

export default defineConfig({
  base: '/docs/',
  define: {
    Deno: undefined,
    Bun: undefined,
  },
  resolve: {
    alias: [
      { find: /^crypto$/, replacement: cryptoShim },
      { find: /^node:crypto$/, replacement: cryptoShim },
    ],
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 10601,
    proxy: {
      // Same-origin API during `vite` so /docs can call the node without CORS fuss.
      '/api': { target: 'http://127.0.0.1:9999', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:9999', changeOrigin: true },
      '/keys': { target: 'http://127.0.0.1:9999', changeOrigin: true },
      '/zkir': { target: 'http://127.0.0.1:9999', changeOrigin: true },
    },
  },
  optimizeDeps: {
    exclude: ['@midnight-ntwrk/onchain-runtime'],
    esbuildOptions: {
      target: 'esnext',
      plugins: [
        {
          name: 'alias-node-crypto-to-shim',
          setup(build) {
            build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: cryptoShim }))
          },
        },
      ],
    },
  },
  plugins: [react(), wasm(), nodePolyfills()],
})
