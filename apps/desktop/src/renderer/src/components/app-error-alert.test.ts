import { describe, expect, it } from 'vitest'

import { ERROR_CODES } from '@teskra/contracts'

import { enUS, type TranslationKey, type TranslationParams } from '../i18n/en-US'
import { zhCN } from '../i18n/zh-CN'
import { resolveErrorMessage, suggestionFor } from './app-error-alert'

const translate = (key: TranslationKey, params?: TranslationParams): string => {
  let text: string = enUS[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

const translateZh = (key: TranslationKey, params?: TranslationParams): string => {
  let text: string = zhCN[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

describe('AppError suggestions', () => {
  it('provides a safe action for every public error code', () => {
    for (const code of ERROR_CODES)
      expect(suggestionFor(code, translate).length).toBeGreaterThan(10)
  })
})

describe('resolveErrorMessage', () => {
  const base = { code: 'WORKSPACE_NOT_FOUND' as const, retryable: false }

  it('prefers the localized messageKey entry and interpolates params', () => {
    const resolved = resolveErrorMessage(
      {
        ...base,
        message: 'Workspace "ws-1" was not found.',
        messageKey: 'errorMessage.workspaceNotFound',
        params: { id: 'ws-1' },
      },
      translate,
    )
    expect(resolved).toBe('Workspace "ws-1" was not found.')
  })

  it('resolves zh-CN entries through the same key', () => {
    const resolved = resolveErrorMessage(
      {
        ...base,
        message: 'Workspace "ws-1" was not found.',
        messageKey: 'errorMessage.workspaceNotFound',
        params: { id: 'ws-1' },
      },
      translateZh,
    )
    expect(resolved).toBe('找不到工作区“ws-1”。')
  })

  it('falls back to message when messageKey is absent', () => {
    expect(resolveErrorMessage({ ...base, message: 'plain fallback' }, translate)).toBe(
      'plain fallback',
    )
  })

  it('falls back to message when messageKey is not in the dictionary', () => {
    expect(
      resolveErrorMessage(
        { ...base, message: 'plain fallback', messageKey: 'errorMessage.doesNotExist' },
        translate,
      ),
    ).toBe('plain fallback')
  })

  it('falls back to message when params leave an unresolved placeholder', () => {
    expect(
      resolveErrorMessage(
        {
          ...base,
          message: 'plain fallback',
          messageKey: 'errorMessage.workspaceNotFound',
          // {id} stays unresolved.
        },
        translate,
      ),
    ).toBe('plain fallback')
  })

  it('falls back to message when translation throws', () => {
    const throwing = (): string => {
      throw new Error('dictionary unavailable')
    }
    expect(
      resolveErrorMessage(
        { ...base, message: 'plain fallback', messageKey: 'errorMessage.workspaceNotFound' },
        throwing,
      ),
    ).toBe('plain fallback')
  })
})
