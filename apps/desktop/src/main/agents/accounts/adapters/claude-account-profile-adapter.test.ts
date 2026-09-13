import { describe, expect, it } from 'vitest'

import type { AgentAccountProfile, IpcResult } from '@teskra/contracts'

import type { CommandRequest, CommandResult } from '../../../process/command-runner'
import {
  createWorkspaceRuntime,
  resolveSpawnEnv,
  type WorkspaceRuntime,
} from '../../../workspace/runtime'
import { CLAUDE_AGENT } from '../../definitions/claude'
import {
  CLAUDE_CONFIG_DIR_ENV,
  createClaudeAccountProfileAdapter,
} from './claude-account-profile-adapter'

/**
 * TASK-099 / §56.2 — Claude account profile adapter.
 *
 * The WSL assertions mirror §56.1 item-by-item: configHome enters the env
 * verbatim (never resolveRuntimePath-translated), and CLAUDE_CONFIG_DIR is
 * declared in WSLENV without /p. Missing either fails SILENTLY as "the CLI
 * fell back to the default ~/.claude" with no error, so both are pinned here.
 */

const UBUNTU = { kind: 'wsl', distro: 'Ubuntu-22.04' } as const

function profile(overrides: Partial<AgentAccountProfile> = {}): AgentAccountProfile {
  return {
    id: 'prof-personal',
    agentId: 'claude',
    name: 'Claude Personal',
    authType: 'subscription',
    runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    configHome: '/home/u/.teskra/agent-profiles/claude/personal',
    status: 'unknown',
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    enabled: true,
    ...overrides,
  }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function fakeWslOnWindowsRuntime(): WorkspaceRuntime {
  return {
    ref: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    hostNative: false,
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
    validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: false } }),
  }
}

function fakeCommands(
  exitCode: number,
  calls: { command: string; args: readonly string[]; hasRuntime: boolean }[],
) {
  return {
    run(request: CommandRequest): Promise<IpcResult<CommandResult>> {
      calls.push({
        command: request.command,
        args: request.args ?? [],
        hasRuntime: request.runtime !== undefined,
      })
      return Promise.resolve({ ok: true, data: { stdout: '', stderr: '', exitCode } })
    },
  }
}

/**
 * Host-native parameterization (same as the TASK-097 manager tests): a wsl
 * ref on a linux host resolves to the NativePosixRuntime, so the node:fs
 * branch behaves identically on Windows and Linux dev hosts.
 */
const createHostNativeRuntime = (ref: Parameters<typeof createWorkspaceRuntime>[0]) =>
  createWorkspaceRuntime(ref, { hostPlatform: 'linux' })

describe('ClaudeAccountProfileAdapter (TASK-099, §11)', () => {
  it('derives agentId and reserved env keys from the claude definition', () => {
    const adapter = createClaudeAccountProfileAdapter()
    expect(adapter.agentId).toBe(CLAUDE_AGENT.id)
    expect(adapter.reservedEnvKeys).toEqual([CLAUDE_CONFIG_DIR_ENV])
    expect(CLAUDE_CONFIG_DIR_ENV).toBe('CLAUDE_CONFIG_DIR')
  })

  it('projects different profiles into different CLAUDE_CONFIG_DIR values', () => {
    const adapter = createClaudeAccountProfileAdapter()
    const runtime = requireOk(createWorkspaceRuntime(UBUNTU, { hostPlatform: 'linux' }))
    const personal = requireOk(adapter.buildRuntimeProjection(profile(), runtime))
    const work = requireOk(
      adapter.buildRuntimeProjection(
        profile({
          id: 'prof-work',
          name: 'Claude Work',
          configHome: '/home/u/.teskra/agent-profiles/claude/work',
        }),
        runtime,
      ),
    )
    expect(personal.env[CLAUDE_CONFIG_DIR_ENV]).toBe(
      '/home/u/.teskra/agent-profiles/claude/personal',
    )
    expect(work.env[CLAUDE_CONFIG_DIR_ENV]).toBe('/home/u/.teskra/agent-profiles/claude/work')
    expect(Object.keys(personal.env)).toEqual([CLAUDE_CONFIG_DIR_ENV])
  })

  it('writes configHome into the env verbatim for both runtime kinds (§5.3)', () => {
    const adapter = createClaudeAccountProfileAdapter()
    const wslRuntime = requireOk(createWorkspaceRuntime(UBUNTU, { hostPlatform: 'linux' }))
    const windowsRuntime = requireOk(
      createWorkspaceRuntime({ kind: 'windows' }, { hostPlatform: 'win32' }),
    )

    const wslProjection = requireOk(adapter.buildRuntimeProjection(profile(), wslRuntime))
    // A WSL configHome must NOT become /mnt/c/… or win32-normalized.
    expect(wslProjection.env[CLAUDE_CONFIG_DIR_ENV]).toBe(
      '/home/u/.teskra/agent-profiles/claude/personal',
    )

    const windowsHome = 'C:\\Users\\u\\.teskra\\agent-profiles\\claude\\personal'
    const windowsProjection = requireOk(
      adapter.buildRuntimeProjection(
        profile({ runtime: { kind: 'windows' }, configHome: windowsHome }),
        windowsRuntime,
      ),
    )
    expect(windowsProjection.env[CLAUDE_CONFIG_DIR_ENV]).toBe(windowsHome)
  })

  it('declares CLAUDE_CONFIG_DIR in WSLENV without /p for WSL-on-Windows (§10.1)', () => {
    const adapter = createClaudeAccountProfileAdapter()
    const wslOnWindows = requireOk(
      createWorkspaceRuntime(UBUNTU, {
        hostPlatform: 'win32',
        wsl: {
          available: true,
          version: '2.4.11.0',
          homeDirs: { 'Ubuntu-22.04': '/home/u' },
        },
      }),
    )
    const projection = requireOk(adapter.buildRuntimeProjection(profile(), wslOnWindows))

    const spawnEnv = resolveSpawnEnv(wslOnWindows, projection.env, 'USER/p')
    expect(spawnEnv[CLAUDE_CONFIG_DIR_ENV]).toBe('/home/u/.teskra/agent-profiles/claude/personal')
    const wslenv = spawnEnv['WSLENV']
    expect(wslenv).toBeDefined()
    // Plain passthrough: the value is already runtime-native, so no /p flag.
    expect(wslenv?.split(':')).toContain(CLAUDE_CONFIG_DIR_ENV)
    expect(wslenv).not.toContain(`${CLAUDE_CONFIG_DIR_ENV}/p`)
    // Inherited declarations survive the merge.
    expect(wslenv?.split(':')).toContain('USER/p')
  })

  it('leaves the env untouched for host-native runtimes (no WSLENV)', () => {
    const adapter = createClaudeAccountProfileAdapter()
    const nativeRuntime = requireOk(createWorkspaceRuntime(UBUNTU, { hostPlatform: 'linux' }))
    const projection = requireOk(adapter.buildRuntimeProjection(profile(), nativeRuntime))
    const spawnEnv = resolveSpawnEnv(nativeRuntime, projection.env)
    expect(spawnEnv).toEqual({
      [CLAUDE_CONFIG_DIR_ENV]: '/home/u/.teskra/agent-profiles/claude/personal',
    })
  })

  it('rejects projection when the profile has no configHome (legacy fallback contract)', () => {
    // §52: a run with NO profile never reaches the adapter (the resolver
    // returns undefined and nothing is projected); a profile that exists but
    // carries no configHome must fail loudly rather than project a guess.
    const adapter = createClaudeAccountProfileAdapter()
    const runtime = requireOk(createWorkspaceRuntime(UBUNTU, { hostPlatform: 'linux' }))
    const result = adapter.buildRuntimeProjection(
      profile({ authType: 'external', configHome: undefined }),
      runtime,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('builds the official login command as an argv array, never a shell string', () => {
    const adapter = createClaudeAccountProfileAdapter()
    const login = requireOk(adapter.buildLoginCommand(profile()))
    // Interactive `claude` in a fresh CLAUDE_CONFIG_DIR runs the official
    // onboarding/login flow; there is no repo-confirmed non-interactive
    // login subcommand (see the adapter's buildLoginCommand comment).
    expect(login.command).toBe(CLAUDE_AGENT.executable.command)
    expect(login.args).toEqual([])
  })
})

describe('ClaudeAccountProfileAdapter.detectStatus (§16/§18)', () => {
  it('reports ready when the credentials file exists in the profile home', async () => {
    const adapter = createClaudeAccountProfileAdapter({
      createRuntime: createHostNativeRuntime,
      fs: { credentialsExist: () => true },
    })
    const result = requireOk(await adapter.detectStatus(profile()))
    expect(result.status).toBe('ready')
  })

  it('probes the profile configHome verbatim and nothing else', async () => {
    const probed: string[] = []
    const adapter = createClaudeAccountProfileAdapter({
      createRuntime: createHostNativeRuntime,
      fs: {
        credentialsExist: (configHome) => {
          probed.push(configHome)
          return false
        },
      },
    })
    const result = requireOk(await adapter.detectStatus(profile()))
    expect(result.status).toBe('login-required')
    expect(probed).toEqual(['/home/u/.teskra/agent-profiles/claude/personal'])
  })

  it('reports unknown when the probe is inconclusive', async () => {
    // Probe throws (EACCES and friends) → unknown, never a guessed status.
    const throwing = createClaudeAccountProfileAdapter({
      createRuntime: createHostNativeRuntime,
      fs: {
        credentialsExist: () => {
          throw new Error('EACCES')
        },
      },
    })
    expect(requireOk(await throwing.detectStatus(profile())).status).toBe('unknown')

    // External profile without a configHome → nothing profile-scoped to probe.
    const adapter = createClaudeAccountProfileAdapter({
      createRuntime: createHostNativeRuntime,
      fs: { credentialsExist: () => true },
    })
    const external = requireOk(
      await adapter.detectStatus(profile({ authType: 'external', configHome: undefined })),
    )
    expect(external.status).toBe('unknown')

    // WSL-on-Windows without a CommandRunner → unknown.
    const noRunner = createClaudeAccountProfileAdapter({
      createRuntime: () => ({ ok: true, data: fakeWslOnWindowsRuntime() }),
    })
    expect(requireOk(await noRunner.detectStatus(profile())).status).toBe('unknown')
  })

  it('probes inside the WSL distro with an argv-array test -e', async () => {
    const calls: { command: string; args: readonly string[]; hasRuntime: boolean }[] = []
    const adapter = createClaudeAccountProfileAdapter({
      createRuntime: () => ({ ok: true, data: fakeWslOnWindowsRuntime() }),
      commands: fakeCommands(0, calls),
    })
    const result = requireOk(await adapter.detectStatus(profile()))
    expect(result.status).toBe('ready')
    expect(calls).toEqual([
      {
        command: 'test',
        args: ['-e', '/home/u/.teskra/agent-profiles/claude/personal/.credentials.json'],
        hasRuntime: true,
      },
    ])
  })

  it('maps test -e exit codes to login-required / unknown', async () => {
    const runtime = () => ({ ok: true as const, data: fakeWslOnWindowsRuntime() })

    const missing = createClaudeAccountProfileAdapter({
      createRuntime: runtime,
      commands: fakeCommands(1, []),
    })
    expect(requireOk(await missing.detectStatus(profile())).status).toBe('login-required')

    const inconclusive = createClaudeAccountProfileAdapter({
      createRuntime: runtime,
      commands: fakeCommands(2, []),
    })
    expect(requireOk(await inconclusive.detectStatus(profile())).status).toBe('unknown')

    const failing = createClaudeAccountProfileAdapter({
      createRuntime: runtime,
      commands: {
        run: () =>
          Promise.resolve<IpcResult<CommandResult>>({
            ok: false,
            error: {
              code: 'COMMAND_TIMEOUT',
              message: 'timed out',
              retryable: true,
            },
          }),
      },
    })
    expect(requireOk(await failing.detectStatus(profile())).status).toBe('unknown')
  })
})
