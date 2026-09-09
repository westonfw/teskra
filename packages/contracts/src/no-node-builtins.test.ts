import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK-003: the contracts package must not reference any Node builtin (nor
 * `electron`), because the sandboxed preload bundles it and may only require
 * `electron`. This is the runtime counterpart of the ESLint
 * `no-restricted-imports` boundary rule for packages/contracts.
 */
const srcDir = fileURLToPath(new URL('.', import.meta.url))

const banned = new Set(['electron'])
for (const mod of builtinModules) {
  banned.add(mod)
  banned.add(`node:${mod}`)
}

const sourceFiles = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => join(srcDir, f))

const importSpecifierPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g

describe('contracts package boundaries', () => {
  it('ships at least one source module', () => {
    expect(sourceFiles.length).toBeGreaterThan(0)
  })

  for (const file of sourceFiles) {
    it(`${file.split('/').pop()} imports no Node builtin / electron`, () => {
      const code = readFileSync(file, 'utf8')
      const specifiers = [...code.matchAll(importSpecifierPattern)].map((m) => m[1])
      const violations = specifiers.filter(
        (s) => banned.has(s) || (!s.startsWith('.') && s !== 'zod'),
      )
      expect(violations).toEqual([])
    })
  }
})
