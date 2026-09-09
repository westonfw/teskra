import { describe, expect, it } from 'vitest'

import { uncPathToWsl, windowsPathToWsl, wslPathToUnc, wslPathToWindows } from './wsl-paths'

describe('windowsPathToWsl', () => {
  it('maps drive-letter paths onto /mnt/<drive>', () => {
    expect(windowsPathToWsl('C:\\dev\\demo')).toBe('/mnt/c/dev/demo')
    expect(windowsPathToWsl('C:/dev/demo')).toBe('/mnt/c/dev/demo')
    expect(windowsPathToWsl('D:\\')).toBe('/mnt/d')
    expect(windowsPathToWsl('e:\\x')).toBe('/mnt/e/x')
  })

  it('maps WSL UNC paths back to the WSL-side path', () => {
    expect(windowsPathToWsl('\\\\wsl$\\Ubuntu\\home\\u\\demo')).toBe('/home/u/demo')
    expect(windowsPathToWsl('\\\\wsl.localhost\\Ubuntu\\home\\u\\demo')).toBe('/home/u/demo')
  })

  it('returns null for non-drive, non-WSL paths', () => {
    expect(windowsPathToWsl('\\\\server\\share\\x')).toBeNull()
    expect(windowsPathToWsl('/already/posix')).toBeNull()
    expect(windowsPathToWsl('relative\\path')).toBeNull()
  })
})

describe('wslPathToWindows', () => {
  it('maps /mnt/<drive> back to drive-letter paths', () => {
    expect(wslPathToWindows('/mnt/c/dev/demo')).toBe('C:\\dev\\demo')
    expect(wslPathToWindows('/mnt/c')).toBe('C:\\')
    expect(wslPathToWindows('/mnt/d/')).toBe('D:\\')
  })

  it('returns null for native WSL paths (they need a distro UNC instead)', () => {
    expect(wslPathToWindows('/home/u/demo')).toBeNull()
    expect(wslPathToWindows('/')).toBeNull()
  })
})

describe('wslPathToUnc', () => {
  it('builds \\wsl$ and \\wsl.localhost prefixes', () => {
    expect(wslPathToUnc('Ubuntu', '/home/u/demo')).toBe('\\\\wsl$\\Ubuntu\\home\\u\\demo')
    expect(wslPathToUnc('Ubuntu', '/home/u/demo', { localhost: true })).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\demo',
    )
    expect(wslPathToUnc('Ubuntu', '/')).toBe('\\\\wsl$\\Ubuntu')
  })
})

describe('uncPathToWsl', () => {
  it('parses both prefix spellings, case-insensitively', () => {
    expect(uncPathToWsl('\\\\wsl$\\Ubuntu\\home\\u\\demo')).toEqual({
      distro: 'Ubuntu',
      path: '/home/u/demo',
    })
    expect(uncPathToWsl('\\\\wsl.localhost\\Debian\\srv\\repo')).toEqual({
      distro: 'Debian',
      path: '/srv/repo',
    })
    expect(uncPathToWsl('\\\\WSL$\\Ubuntu')).toEqual({ distro: 'Ubuntu', path: '/' })
  })

  it('round-trips with wslPathToUnc', () => {
    const unc = wslPathToUnc('Ubuntu-24.04', '/home/u/a b/c')
    expect(uncPathToWsl(unc)).toEqual({ distro: 'Ubuntu-24.04', path: '/home/u/a b/c' })
  })

  it('returns null for non-WSL UNC paths and empty distros', () => {
    expect(uncPathToWsl('\\\\server\\share')).toBeNull()
    expect(uncPathToWsl('C:\\dev\\demo')).toBeNull()
    expect(uncPathToWsl('\\\\wsl$\\\\home\\u')).toBeNull()
  })
})
