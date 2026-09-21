import { win32 } from 'node:path'

/**
 * §49 / P2-2: the windows-runtime external configHome storage contract.
 *
 * Both writers of `agent_account_profiles.config_home` must agree byte-for-byte
 * on this normalization, because the per-runtime config_home unique index is a
 * raw-byte comparison:
 *
 * - AccountProfileManager.normalizeExternalConfigHome (windows branch) applies
 *   it to NEW external profiles at create time;
 * - data migration 016 (db/migrations/016_external_config_home_normalize.ts)
 *   rewrites legacy rows stored before P2-2 to the same form.
 *
 * It lives in Main (not @teskra/shared) because it needs node:path's win32
 * semantics, and shared is bundled into the sandboxed preload where Node
 * builtins are banned (packages/shared/src/no-node-builtins.test.ts).
 */

/** A Windows drive-absolute path starts with `X:\` or `X:/`. */
export const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u

/**
 * win32.normalize, strip trailing separators unless that would break
 * absoluteness (drive root `C:\`), then case-fold — NTFS is case-insensitive,
 * and lowercase keeps the unique index honest
 * (`C:\Users\x` vs `c:\users\x\` must be one home).
 */
export function normalizeWindowsConfigHome(configHome: string): string {
  const normalized = win32.normalize(configHome)
  const trimmed = normalized.replace(/[\\/]+$/u, '')
  const stillAbsolute = WINDOWS_DRIVE_ABSOLUTE.test(trimmed) || trimmed.startsWith('\\\\')
  return (stillAbsolute ? trimmed : normalized).toLowerCase()
}
