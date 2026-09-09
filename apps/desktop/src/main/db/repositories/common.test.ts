import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  ISO_UTC_PATTERN,
  decodeJson,
  encodeJson,
  execute,
  isoTimestampSchema,
  mapRows,
  nowIso,
  requireFound,
  validateRow,
} from './common'

describe('repository common helpers', () => {
  it('nowIso() produces ISO-8601 UTC with millisecond precision', () => {
    expect(nowIso()).toMatch(ISO_UTC_PATTERN)
    expect(isoTimestampSchema.safeParse(nowIso()).success).toBe(true)
  })

  it('isoTimestampSchema rejects non-UTC / non-ISO formats', () => {
    for (const bad of [
      '2026-09-09 10:00:00',
      '2026-09-09T10:00:00+08:00',
      '2026-09-09T10:00:00Z',
      'yesterday',
      '',
    ]) {
      expect(isoTimestampSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('encodeJson maps undefined to NULL and objects to text', () => {
    expect(encodeJson(undefined)).toBeNull()
    expect(encodeJson({ a: 1 })).toBe('{"a":1}')
  })

  it('decodeJson maps NULL to undefined and validates with Zod', () => {
    const schema = z.strictObject({ a: z.number() })
    expect(decodeJson(schema, 'entity', 'col', null)).toEqual({ ok: true, data: undefined })
    expect(decodeJson(schema, 'entity', 'col', '{"a":1}')).toEqual({ ok: true, data: { a: 1 } })
  })

  it('decodeJson returns VALIDATION_FAILED for broken JSON text', () => {
    const result = decodeJson(z.record(z.string(), z.unknown()), 'entity', 'col', '{')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(result.error).not.toHaveProperty('detail')
    expect(result.error).not.toHaveProperty('cause')
  })

  it('decodeJson returns VALIDATION_FAILED for schema mismatches', () => {
    const result = decodeJson(z.strictObject({ a: z.number() }), 'entity', 'col', '{"a":"x"}')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('validateRow passes through parsed data and fails structurally', () => {
    const schema = z.strictObject({ s: z.string() })
    expect(validateRow(schema, 'entity', { s: 'ok' })).toEqual({ ok: true, data: { s: 'ok' } })
    const bad = validateRow(schema, 'entity', { s: 1 })
    expect(bad.ok).toBe(false)
  })

  it('execute converts thrown driver errors into structured UNKNOWN errors', () => {
    const result = execute('entity', 'explode', () => {
      throw new Error('disk on fire')
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN')
    expect(result.error).not.toHaveProperty('cause')
  })

  it('requireFound unwraps present rows and fails on null', () => {
    expect(requireFound('entity', { ok: true, data: 1 })).toEqual({ ok: true, data: 1 })
    const missing = requireFound('entity', { ok: true, data: null })
    expect(missing.ok).toBe(false)
  })

  it('mapRows fails the whole list on the first corrupted row', () => {
    const mapped = mapRows([1, 2, 3], (n) =>
      n === 2 ? validateRow(z.literal(2), 'entity', 'not-2') : { ok: true as const, data: n * 10 },
    )
    expect(mapped.ok).toBe(false)
  })
})
