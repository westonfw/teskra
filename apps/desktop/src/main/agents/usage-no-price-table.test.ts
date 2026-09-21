import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK-124 acceptance: cost is recorded ONLY when the provider reports it —
 * Teskra never estimates cost from a price table. This guard scans the whole
 * usage code path (contracts schema, repository, tracker) for per-token /
 * per-million price constants, so a future "helpful" estimation helper trips
 * a failing test instead of silently landing.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const scanned = [
  join(here, 'usage-tracker.ts'),
  join(here, '../db/repositories/usage-repository.ts'),
  join(here, '../../../../../packages/contracts/src/usage.ts'),
]

// A price table looks like a named rate mapped to a number/object literal.
const priceTablePattern =
  /(?:price|pricing|per[-_]?million|per[-_]?token|usd[-_]?per|token[-_]?rate)\w*\s*[:=]\s*[\d{[]/i

describe('no price-table constants (TASK-124)', () => {
  it('finds the usage source files to scan', () => {
    for (const file of scanned) {
      expect(() => readFileSync(file, 'utf8'), file).not.toThrow()
    }
  })

  for (const file of scanned) {
    it(`${file.split(/[\\/]/).pop()} contains no price-table constant`, () => {
      const code = readFileSync(file, 'utf8')
      const offenders = code.split('\n').filter((line) => priceTablePattern.test(line))
      expect(offenders).toEqual([])
    })
  }
})
