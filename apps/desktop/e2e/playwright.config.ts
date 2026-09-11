import { defineConfig } from '@playwright/test'

// TASK-076: Electron E2E via Playwright's _electron API. The app under test is
// the electron-vite build in apps/desktop/out — run `npm run build` first (the
// root `npm run test:e2e` script does this for you). Electron is driven
// directly; no browser binaries are needed (`playwright install` is never
// required for this suite).
export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  // One Electron instance per test; PTY + SQLite state make parallelism unsafe.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
})
