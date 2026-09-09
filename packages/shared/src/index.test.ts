import { describe, expect, it } from 'vitest'

import { isNonEmptyString } from './index'

describe('isNonEmptyString', () => {
  it('accepts a non-empty string', () => {
    expect(isNonEmptyString('teskra')).toBe(true)
  })

  it('rejects empty strings and non-strings', () => {
    expect(isNonEmptyString('')).toBe(false)
    expect(isNonEmptyString(undefined)).toBe(false)
    expect(isNonEmptyString(42)).toBe(false)
  })
})
