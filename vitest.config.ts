import { createRequire } from 'node:module'

import { defineConfig } from 'vitest/config'

// Mirror the electron-vite `define` (apps/desktop/electron.vite.config.ts) so
// modules reading the build-time version constant (src/main/build-info.ts)
// resolve the same value under unit tests.
const nodeRequire = createRequire(import.meta.url)
const desktopPackage = nodeRequire('./apps/desktop/package.json') as { version: string }

export default defineConfig({
  define: {
    __TESKRA_APP_VERSION__: JSON.stringify(desktopPackage.version),
  },
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      'scripts/*.test.mjs',
    ],
    // Git/DB integration tests chain many real subprocesses; each git spawn
    // costs ~0.5–1s on the Windows CI runner, breaching the 5s default. The
    // budget only bounds hanging tests — it does not slow passing suites down.
    testTimeout: 30_000,
  },
})
