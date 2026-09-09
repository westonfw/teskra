import { describe, expect, it } from 'vitest'

import type { TeskraPaths } from '../paths'
import {
  createWorkspaceRuntime,
  quoteShellArg,
  supportsCdFlag,
  type WorkspaceRuntimeDeps,
} from './runtime'

const HOST_HOME = '/host-home/.teskra'

/** Host-side paths stub: only home() matters for the runtime. */
function stubPaths(): TeskraPaths {
  return {
    home: () => HOST_HOME,
    db: () => ({ ok: true, data: `${HOST_HOME}/db/teskra.sqlite` }),
    logs: () => ({ ok: true, data: `${HOST_HOME}/logs` }),
    runDir: (runId) => ({ ok: true, data: `${HOST_HOME}/runs/${runId}` }),
    worktreeRoot: (wsId) => ({ ok: true, data: `${HOST_HOME}/worktrees/${wsId}` }),
    config: () => `${HOST_HOME}/config.json`,
    repoConfig: (repoRoot) => `${repoRoot}/.teskra/config.json`,
  }
}

function deps(overrides: Partial<WorkspaceRuntimeDeps> = {}): WorkspaceRuntimeDeps {
  return { hostPlatform: 'win32', paths: stubPaths(), ...overrides }
}

describe('supportsCdFlag', () => {
  it('accepts WSL 0.51 and newer, including 1.x/2.x store versions', () => {
    expect(supportsCdFlag('0.51.0')).toBe(true)
    expect(supportsCdFlag('0.72.0')).toBe(true)
    expect(supportsCdFlag('1.0.0')).toBe(true)
    expect(supportsCdFlag('2.4.11.0')).toBe(true)
  })

  it('rejects older and unknown versions (conservative fallback)', () => {
    expect(supportsCdFlag('0.50.2')).toBe(false)
    expect(supportsCdFlag(undefined)).toBe(false)
    expect(supportsCdFlag('not-a-version')).toBe(false)
  })
})

describe('WindowsRuntime', () => {
  it('generates a plain Windows command context', () => {
    const result = createWorkspaceRuntime({ kind: 'windows' }, deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const runtime = result.data
    expect(runtime.hostNative).toBe(true)
    expect(runtime.resolveCommand('codex', ['--full-auto'], 'C:\\dev\\demo')).toEqual({
      executable: 'codex',
      args: ['--full-auto'],
      cwd: 'C:\\dev\\demo',
    })
    expect(runtime.resolveCwd('C:/dev/demo/')).toBe('C:\\dev\\demo\\')
    expect(runtime.resolveDataRoot()).toBe(HOST_HOME)
    expect(runtime.validate()).toEqual({
      ok: true,
      data: { kind: 'windows', hostNative: true },
    })
  })

  it('validates with CAPABILITY_NOT_AVAILABLE off Windows but stays constructible', () => {
    const result = createWorkspaceRuntime({ kind: 'windows' }, deps({ hostPlatform: 'linux' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.hostNative).toBe(false)
    const status = result.data.validate()
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
  })
})

describe('WslRuntime (Windows host)', () => {
  const ref = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const

  it('wraps commands with wsl.exe -d <distro> --cd when WSL supports it', () => {
    const result = createWorkspaceRuntime(
      ref,
      deps({ wsl: { available: true, version: '2.4.11.0' } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const runtime = result.data
    expect(runtime.hostNative).toBe(false)
    expect(runtime.resolveCommand('git', ['status'], '/home/u/demo')).toEqual({
      executable: 'wsl.exe',
      args: ['-d', 'Ubuntu-24.04', '--cd', '/home/u/demo', 'git', 'status'],
    })
    expect(runtime.validate()).toEqual({
      ok: true,
      data: { kind: 'wsl', hostNative: false, wslCommandStrategy: 'cd-flag' },
    })
  })

  it("falls back to bash -lc 'cd … && exec …' when --cd is unavailable", () => {
    const result = createWorkspaceRuntime(
      ref,
      deps({ wsl: { available: true, version: '0.50.2' } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.resolveCommand('codex', ['--ask'], '/home/u/demo')).toEqual({
      executable: 'wsl.exe',
      args: ['-d', 'Ubuntu-24.04', 'bash', '-lc', "cd '/home/u/demo' && exec 'codex' '--ask'"],
    })
    const status = result.data.validate()
    expect(status.ok && status.data.wslCommandStrategy).toBe('bash-lc')
  })

  it('conservatively uses bash -lc when no WSL capability info was injected', () => {
    const result = createWorkspaceRuntime(ref, deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.resolveCommand('bash', [], '/home/u/demo').args).toEqual([
      '-d',
      'Ubuntu-24.04',
      'bash',
      '-lc',
      "cd '/home/u/demo' && exec 'bash'",
    ])
  })

  it('shell-quotes single quotes in bash -lc scripts', () => {
    expect(quoteShellArg("it's")).toBe(`'it'\\''s'`)
    const result = createWorkspaceRuntime(ref, deps({ wsl: { available: true } }))
    if (!result.ok) throw new Error('expected runtime')
    const ctx = result.data.resolveCommand('bash', ['-c', "echo 'hi'"], `/home/u/o'hara`)
    expect(ctx.args[4]).toBe(`cd '/home/u/o'\\''hara' && exec 'bash' '-c' 'echo '\\''hi'\\'''`)
  })

  it('returns WSL_NOT_AVAILABLE (structured, not a crash) when WSL is missing', () => {
    const result = createWorkspaceRuntime(ref, deps({ wsl: { available: false } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = result.data.validate()
    expect(status.ok).toBe(false)
    if (!status.ok) {
      expect(status.error.code).toBe('WSL_NOT_AVAILABLE')
      // PublicAppError must not carry internal details across IPC.
      expect(status.error).not.toHaveProperty('detail')
    }
  })

  it('resolves the data root on the WSL side, never as a C:\\ path', () => {
    const detected = createWorkspaceRuntime(
      ref,
      deps({ wsl: { available: true, version: '2.4.11.0', homeDir: '/home/u' } }),
    )
    expect(detected.ok && detected.data.resolveDataRoot()).toBe('/home/u/.teskra')

    const unknown = createWorkspaceRuntime(ref, deps())
    expect(unknown.ok && unknown.data.resolveDataRoot()).toBe('~/.teskra')
  })
})

describe('NativePosixRuntime (wsl workspace on a Linux/WSL2 dev host)', () => {
  it('runs commands natively and probes the filesystem directly', () => {
    const result = createWorkspaceRuntime(
      { kind: 'wsl', distro: 'Ubuntu' },
      deps({ hostPlatform: 'linux' }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const runtime = result.data
    expect(runtime.hostNative).toBe(true)
    expect(runtime.resolveCommand('git', ['status'], '/home/u/demo')).toEqual({
      executable: 'git',
      args: ['status'],
      cwd: '/home/u/demo',
    })
    expect(runtime.resolveDataRoot()).toBe(HOST_HOME)
    expect(runtime.validate().ok).toBe(true)
  })
})

describe('createWorkspaceRuntime', () => {
  it('rejects unimplemented kinds with CAPABILITY_NOT_AVAILABLE', () => {
    const result = createWorkspaceRuntime({ kind: 'ssh', host: 'builder.example.com' }, deps())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
  })
})
