import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { enUS } from './renderer/src/i18n/en-US'
import { zhCN } from './renderer/src/i18n/zh-CN'

/**
 * Sustainable i18n pattern for PublicAppError (code-review P1-9): any
 * `messageKey` literal used in src/main must exist in BOTH dictionaries, so a
 * new keyed error without dictionary entries fails this test instead of
 * silently rendering the English fallback in every locale.
 */
const mainDir = fileURLToPath(new URL('./main', import.meta.url))

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path)
    }
  }
  return files
}

function collectMessageKeys(): Map<string, string[]> {
  const pattern = /messageKey:\s*'([^']+)'/g
  const keys = new Map<string, string[]>()
  for (const file of collectSourceFiles(mainDir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) {
      const key = match[1] as string
      keys.set(key, [...(keys.get(key) ?? []), file])
    }
  }
  return keys
}

describe('PublicAppError messageKey ↔ dictionary contract', () => {
  it('every messageKey used in src/main exists in en-US and zh-CN', () => {
    const keys = collectMessageKeys()
    expect(keys.size).toBeGreaterThan(0)
    for (const [key, files] of keys) {
      expect(key in enUS, `${key} (used in ${files.join(', ')}) missing from en-US`).toBe(true)
      expect(key in zhCN, `${key} (used in ${files.join(', ')}) missing from zh-CN`).toBe(true)
    }
  })

  it('all keyed error messages live under the errorMessage.* namespace', () => {
    for (const key of collectMessageKeys().keys()) {
      expect(key.startsWith('errorMessage.'), `${key} should use the errorMessage.* prefix`).toBe(
        true,
      )
    }
  })

  it('en-US and zh-CN dictionaries have exactly the same keys', () => {
    const enKeys = Object.keys(enUS).sort()
    const zhKeys = Object.keys(zhCN).sort()
    expect(zhKeys).toEqual(enKeys)
  })
})
