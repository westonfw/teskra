import type { PublicAppError, WslDistribution } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { detectWslDistributions, type WslDetectionBridge } from './wsl-distributions'
import { enUS, type TranslationKey } from '../i18n/en-US'

const translate = (key: TranslationKey): string => enUS[key]

const UBUNTU: WslDistribution = {
  name: 'Ubuntu',
  isSystemDefault: true,
  isConfiguredDefault: false,
}

const failure: PublicAppError = {
  code: 'WSL_NOT_AVAILABLE',
  message: 'WSL is not installed or not running.',
  retryable: true,
}

function bridge(overrides: Partial<WslDetectionBridge> = {}): WslDetectionBridge {
  return {
    listWslDistributions: vi.fn(async () => ({ ok: true as const, data: [UBUNTU] })),
    ...overrides,
  }
}

describe('detectWslDistributions', () => {
  it('returns the detected distributions', async () => {
    const outcome = await detectWslDistributions(bridge(), translate)
    expect(outcome).toEqual({ ok: true, distributions: [UBUNTU] })
  })

  it('turns a failed detection into an explicit message instead of silence', async () => {
    // Regression: the workspace dialog ignored a non-ok detection result, so
    // choosing WSL left an empty distribution dropdown with no explanation.
    const outcome = await detectWslDistributions(
      bridge({
        listWslDistributions: vi.fn(async () => ({ ok: false as const, error: failure })),
      }),
      translate,
    )
    expect(outcome).toEqual({ ok: false, message: failure.message })
  })

  it('turns a transport rejection into an explicit message', async () => {
    // Regression: the dialog's promise chain had no catch, so a rejected
    // invoke became an unhandled rejection.
    const outcome = await detectWslDistributions(
      bridge({ listWslDistributions: vi.fn(() => Promise.reject(new Error('ipc down'))) }),
      translate,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.message.length > 0).toBe(true)
  })
})
