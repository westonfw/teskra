import { describe, expect, it } from 'vitest'

import { ERROR_CODES } from '@teskra/contracts'

import { suggestionFor } from './app-error-alert'

describe('AppError suggestions', () => {
  it('provides a safe action for every public error code', () => {
    for (const code of ERROR_CODES) expect(suggestionFor(code).length).toBeGreaterThan(10)
  })
})
