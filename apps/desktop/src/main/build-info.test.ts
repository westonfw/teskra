import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { APP_VERSION } from './build-info'

const nodeRequire = createRequire(import.meta.url)

describe('APP_VERSION (P2-16)', () => {
  it('is injected from apps/desktop/package.json by the electron-vite/vitest define', () => {
    const desktopPackage = nodeRequire('../../package.json') as { version: string }
    expect(APP_VERSION).toBe(desktopPackage.version)
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/)
  })
})
