import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK-080: ConfigService is the ONLY module that reads config files;
 * Managers receive resolved config by injection. paths.ts may resolve the
 * config.json path (ADR-0003 path authority) but never reads it. This is
 * the runtime counterpart of the module-boundary ESLint rules.
 */
const mainDir = fileURLToPath(new URL('..', import.meta.url))

const ALLOWED = new Set(['config/config-service.ts', 'paths.ts'])

function collectSources(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectSources(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

const sourceFiles = collectSources(mainDir)

describe('config file reads are centralized in ConfigService (TASK-080)', () => {
  it('ships main-process sources to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(0)
  })

  for (const file of sourceFiles) {
    const rel = relative(mainDir, file)
    if (ALLOWED.has(rel)) {
      continue
    }
    it(`${rel} does not touch config.json`, () => {
      const code = readFileSync(file, 'utf8')
      expect(code.includes('config.json')).toBe(false)
    })
  }
})
