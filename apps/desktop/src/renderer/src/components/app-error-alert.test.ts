import { describe, expect, it } from 'vitest'

import { ERROR_CODES } from '@teskra/contracts'

import { enUS, type TranslationKey } from '../i18n/en-US'
import { suggestionFor } from './app-error-alert'

const translate = (key: TranslationKey): string => enUS[key]

describe('AppError suggestions', () => {
  it('provides a safe action for every public error code', () => {
    for (const code of ERROR_CODES)
      expect(suggestionFor(code, translate).length).toBeGreaterThan(10)
  })
})
