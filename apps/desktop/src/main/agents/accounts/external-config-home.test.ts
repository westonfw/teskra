import { describe, expect, it } from 'vitest'

import { normalizeWindowsConfigHome, WINDOWS_DRIVE_ABSOLUTE } from './external-config-home'

/**
 * Direct unit tests for the shared §49 / P2-2 windows configHome storage
 * contract (single source for AccountProfileManager's windows branch and data
 * migration 016). Behavior here is byte-exact: the per-runtime config_home
 * unique index is a raw-byte comparison.
 */
describe('normalizeWindowsConfigHome', () => {
  it('case-folds and strips a trailing backslash', () => {
    expect(normalizeWindowsConfigHome('C:\\Users\\Alice\\.Codex\\')).toBe(
      'c:\\users\\alice\\.codex',
    )
  })

  it('converts forward slashes and strips the trailing one', () => {
    expect(normalizeWindowsConfigHome('D:/Tools/Codex/')).toBe('d:\\tools\\codex')
  })

  it('returns an already-normalized path byte-identically', () => {
    expect(normalizeWindowsConfigHome('e:\\already\\clean')).toBe('e:\\already\\clean')
  })

  it('resolves dot segments via win32 semantics', () => {
    expect(normalizeWindowsConfigHome('C:\\Users\\x\\..\\y')).toBe('c:\\users\\y')
  })

  it('keeps the drive-root trailing separator — stripping it would break absoluteness', () => {
    expect(normalizeWindowsConfigHome('C:\\')).toBe('c:\\')
    expect(normalizeWindowsConfigHome('C:/')).toBe('c:\\')
    expect(normalizeWindowsConfigHome('C:\\\\')).toBe('c:\\')
  })

  it('normalizes UNC paths and keeps the leading double backslash', () => {
    expect(normalizeWindowsConfigHome('\\\\SERVER\\Share\\.Codex\\')).toBe(
      '\\\\server\\share\\.codex',
    )
  })

  it('strips multiple trailing separators from an absolute path', () => {
    expect(normalizeWindowsConfigHome('C:\\Users\\x\\\\')).toBe('c:\\users\\x')
  })
})

describe('WINDOWS_DRIVE_ABSOLUTE', () => {
  it('matches drive-absolute paths with either separator', () => {
    expect(WINDOWS_DRIVE_ABSOLUTE.test('C:\\Users')).toBe(true)
    expect(WINDOWS_DRIVE_ABSOLUTE.test('d:/tools')).toBe(true)
  })

  it('rejects drive-relative, POSIX, and bare-UNC-prefix shapes', () => {
    expect(WINDOWS_DRIVE_ABSOLUTE.test('C:Users')).toBe(false)
    expect(WINDOWS_DRIVE_ABSOLUTE.test('/home/u')).toBe(false)
    expect(WINDOWS_DRIVE_ABSOLUTE.test('\\\\server\\share')).toBe(false)
  })
})
