import { describe, expect, it } from 'vitest'

import type { IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import type { CommandRequest, CommandResult } from '../../../process/command-runner'
import type { WorkspaceRuntime } from '../../../workspace/runtime'
import {
  defaultRuntimeFactory,
  joinRuntimePath,
  probeRuntimeFileExists,
} from './runtime-file-probe'

/**
 * P2-14 — the single §10.3 "existence only, never contents" implementation
 * shared by the Codex and Claude account profile adapters.
 */

const WINDOWS_REF: WorkspaceRuntimeRef = { kind: 'windows' }
const UBUNTU_REF: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'Ubuntu-22.04' }

function stubRuntime(ref: WorkspaceRuntimeRef, hostNative: boolean): WorkspaceRuntime {
  return {
    ref,
    hostNative,
    resolveCommand: (command, args = [], cwd) => ({
      executable: command,
      args,
      ...(cwd !== undefined ? { cwd } : {}),
    }),
    resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: ['-l'] } }),
    resolveCwd: (path) => path,
    resolveHostPath: (path) => ({ ok: true, data: path }),
    resolveDataRoot: () => '/home/u/.teskra',
    resolveAgentProfilesRoot: () => '/home/u/.teskra/agent-profiles',
    resolveAgentProfileHome: (agentId, slug) => ({
      ok: true,
      data: `/home/u/.teskra/agent-profiles/${agentId}/${slug}`,
    }),
    validate: () => ({ ok: true, data: { kind: ref.kind, hostNative } }),
  }
}

class FakeCommands {
  readonly calls: CommandRequest[] = []

  constructor(private readonly reply: (request: CommandRequest) => IpcResult<CommandResult>) {}

  run(request: CommandRequest): Promise<IpcResult<CommandResult>> {
    this.calls.push(request)
    return Promise.resolve(this.reply(request))
  }
}

const exitWith = (exitCode: number) => () => ({
  ok: true as const,
  data: { stdout: '', stderr: '', exitCode },
})

describe('joinRuntimePath', () => {
  it('joins in the runtime flavor, never the dev host flavor', () => {
    expect(
      joinRuntimePath(stubRuntime(WINDOWS_REF, true), 'C:\\Users\\u\\.codex', 'auth.json'),
    ).toBe('C:\\Users\\u\\.codex\\auth.json')
    expect(joinRuntimePath(stubRuntime(UBUNTU_REF, false), '/home/u/.codex', 'auth.json')).toBe(
      '/home/u/.codex/auth.json',
    )
  })
})

describe('probeRuntimeFileExists (§10.3)', () => {
  const windows = stubRuntime(WINDOWS_REF, true)
  const wsl = stubRuntime(UBUNTU_REF, false)

  it('answers directly on host-native runtimes through the injected seam', async () => {
    const probed: string[] = []
    const hostFileExists = (path: string): boolean => {
      probed.push(path)
      return true
    }

    const outcome = await probeRuntimeFileExists({
      runtime: windows,
      directory: 'C:\\Users\\u\\.codex',
      fileName: 'auth.json',
      testFlag: '-f',
      timeoutMs: 1_000,
      hostFileExists,
    })

    expect(outcome).toBe('exists')
    expect(probed).toEqual(['C:\\Users\\u\\.codex\\auth.json'])

    const missing = await probeRuntimeFileExists({
      runtime: windows,
      directory: 'C:\\Users\\u\\.codex',
      fileName: 'auth.json',
      testFlag: '-f',
      timeoutMs: 1_000,
      hostFileExists: () => false,
    })
    expect(missing).toBe('missing')
  })

  it('reports unknown when the host-native probe throws', async () => {
    const outcome = await probeRuntimeFileExists({
      runtime: windows,
      directory: 'C:\\Users\\u\\.codex',
      fileName: 'auth.json',
      testFlag: '-f',
      timeoutMs: 1_000,
      hostFileExists: () => {
        throw new Error('EACCES')
      },
    })
    expect(outcome).toBe('unknown')
  })

  it('probes a WSL runtime with an argv-array test command, never a shell string', async () => {
    const commands = new FakeCommands(exitWith(0))

    const outcome = await probeRuntimeFileExists({
      runtime: wsl,
      directory: '/home/u/.codex',
      fileName: 'auth.json',
      testFlag: '-f',
      timeoutMs: 1_000,
      commands,
    })

    expect(outcome).toBe('exists')
    expect(commands.calls).toHaveLength(1)
    const probe = commands.calls[0]
    expect(probe?.command).toBe('test')
    expect(probe?.args).toEqual(['-f', '/home/u/.codex/auth.json'])
    expect(probe?.timeoutMs).toBe(1_000)
    expect(probe?.runtime).toBe(wsl)
  })

  it('maps WSL exit codes to missing / unexpected', async () => {
    const missing = await probeRuntimeFileExists({
      runtime: wsl,
      directory: '/home/u/.claude',
      fileName: '.credentials.json',
      testFlag: '-e',
      timeoutMs: 1_000,
      commands: new FakeCommands(exitWith(1)),
    })
    expect(missing).toBe('missing')

    const calls: CommandRequest[] = []
    const unexpected = await probeRuntimeFileExists({
      runtime: wsl,
      directory: '/home/u/.claude',
      fileName: '.credentials.json',
      testFlag: '-e',
      timeoutMs: 1_000,
      commands: new FakeCommands((request) => {
        calls.push(request)
        return { ok: true, data: { stdout: '', stderr: '', exitCode: 2 } }
      }),
    })
    expect(unexpected).toBe('unexpected')
    expect(calls[0]?.args).toEqual(['-e', '/home/u/.claude/.credentials.json'])
  })

  it('reports unknown when the WSL probe cannot run', async () => {
    const failing = new FakeCommands(() => ({
      ok: false,
      error: { code: 'COMMAND_TIMEOUT', message: 'timed out', retryable: true },
    }))
    const withFailing = await probeRuntimeFileExists({
      runtime: wsl,
      directory: '/home/u/.codex',
      fileName: 'auth.json',
      testFlag: '-f',
      timeoutMs: 1_000,
      commands: failing,
    })
    const withoutRunner = await probeRuntimeFileExists({
      runtime: wsl,
      directory: '/home/u/.codex',
      fileName: 'auth.json',
      testFlag: '-f',
      timeoutMs: 1_000,
    })
    expect(withFailing).toBe('unknown')
    expect(withoutRunner).toBe('unknown')
  })
})

describe('defaultRuntimeFactory', () => {
  it('resolves runtimes through createWorkspaceRuntime', () => {
    const resolved = defaultRuntimeFactory({ kind: 'windows' })
    expect(resolved.ok).toBe(true)
  })
})
