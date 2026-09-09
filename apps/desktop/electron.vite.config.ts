import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * TASK-002: inject a strict CSP meta into the production index.html.
 * Production only (`apply: 'build'`): in dev the vite HMR websocket
 * (connect-src ws:) and the react-refresh inline preamble (inline script)
 * are incompatible with `default-src 'self'`, so the dev server html stays
 * CSP-free and the packaged app stays locked down.
 */
function cspPlugin(): Plugin {
  return {
    name: 'teskra-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content:
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
          },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // TASK-002: sandboxed preload scripts can only require `electron`, so all
    // other dependencies (contracts, zod, ...) must be bundled into the
    // preload output — do NOT externalize them here. `electron` itself stays
    // external regardless.
    plugins: [],
  },
  renderer: {
    plugins: [react(), cspPlugin()],
  },
})
