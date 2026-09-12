import type { IpcResult, WslDistribution } from '@teskra/contracts'

import type { TranslationKey } from '../i18n'

export type Translate = (key: TranslationKey) => string

export interface WslDetectionBridge {
  listWslDistributions(): Promise<IpcResult<WslDistribution[]>>
}

export type WslDetectionOutcome =
  | { readonly ok: true; readonly distributions: readonly WslDistribution[] }
  | { readonly ok: false; readonly message: string }

/**
 * WSL detection for the workspace dialog. Failures come back as an explicit
 * message so the dialog can say why the distribution list is empty, instead
 * of silently showing a dropdown with no options (or leaking an unhandled
 * rejection when the invoke itself fails).
 */
export async function detectWslDistributions(
  bridge: WslDetectionBridge,
  t: Translate,
): Promise<WslDetectionOutcome> {
  try {
    const result = await bridge.listWslDistributions()
    return result.ok
      ? { ok: true, distributions: result.data }
      : { ok: false, message: result.error.message }
  } catch {
    return { ok: false, message: t('wsl.unreachable') }
  }
}
