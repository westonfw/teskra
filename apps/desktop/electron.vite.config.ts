import { readFileSync } from 'node:fs'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// P2-16: single version source for the bundles. scripts/release.mjs sets
// TESKRA_APP_VERSION to the resolved release version so the value baked into
// the main/preload bundles matches -c.extraMetadata.version; otherwise fall
// back to the desktop package.json (also what `app.getVersion()` reports in
// dev). Consumed as APP_VERSION from src/main/build-info.ts.
const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version
const appVersion = process.env['TESKRA_APP_VERSION'] ?? packageVersion
const appVersionDefine: Record<string, string> = {
  __TESKRA_APP_VERSION__: JSON.stringify(appVersion),
}

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
    // TASK-003: @teskra/contracts ships TypeScript sources (exports point at
    // ./src/*.ts), so it cannot stay an external runtime require — bundle it
    // (and its zod dependency) into the main-process output.
    plugins: [externalizeDepsPlugin({ exclude: ['@teskra/contracts', '@teskra/shared', 'zod'] })],
    define: appVersionDefine,
  },
  preload: {
    // TASK-002: sandboxed preload scripts can only require `electron`, so all
    // other dependencies (contracts, zod, ...) must be bundled into the
    // preload output. electron-vite auto-injects dependency externalization
    // unless disabled, so turn it off explicitly — `electron` itself stays
    // external regardless (preset rollupOptions.external).
    plugins: [],
    define: appVersionDefine,
    build: {
      externalizeDeps: false,
    },
  },
  renderer: {
    plugins: [react(), cspPlugin()],
  },
})
