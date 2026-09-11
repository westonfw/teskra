import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/src/**/*.test.{ts,tsx}'],
    // Git/DB integration tests chain many real subprocesses; each git spawn
    // costs ~0.5–1s on the Windows CI runner, breaching the 5s default. The
    // budget only bounds hanging tests — it does not slow passing suites down.
    testTimeout: 30_000,
  },
})
