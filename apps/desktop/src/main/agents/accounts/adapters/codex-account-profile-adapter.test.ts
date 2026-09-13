import { describe, expect, it } from 'vitest'

import type { AgentAccountProfile, IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import { createTeskraPaths } from '../../../paths'
import type { CommandRequest, CommandResult } from '../../../process/command-runner'
import {
  createWorkspaceRuntime,
  resolveSpawnEnv,
  type WorkspaceRuntime,
} from '../../../workspace/runtime'
import { CODEX_AGENT } from '../../definitions/codex'
import {
  CODEX_HOME_ENV_KEY,
  createCodexAccountProfileAdapter,
  registerCodexAccountProfileAdapter,
  type CodexAccountProfileAdapterDeps,
} from './codex-account-profile-adapter'
import { createAccountProfileAdapterRegistry } from '../account-profile-adapter'

/**
 * TASK-098 / design §56.1 — every assertion maps to one of the four WSL rules
 * (§5.3 / §10.1) plus the login-command and detectStatus contracts. Windows
 * and WSL profile semantics are parameterized through the same fake-runtime
 * style the TASK-097 manager tests use.
 */

const WINDOWS_REF: WorkspaceRuntimeRef = { kind: 'windows' }
const UBUNTU_REF: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'Ubuntu-22.04' }

function makeProfile(overrides: Partial<AgentAccountProfile> = {}): AgentAccountProfile {
  return {
    id: 'acct_codex_personal',
    agentId: CODEX_AGENT.id,
    name: 'Codex Personal',
    authType: 'subscription',
    runtime: UBUNTU_REF,
    configHome: '/home/u/.teskra/agent-profiles/codex/personal',
    status: 'login-required',
    enabled: true,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

/** Minimal WorkspaceRuntime stub — buildRuntimeProjection must not consult it. */
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
    validate: () => ({
      ok: true,
      data: { kind: ref.kind, hostNative },
    }),
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

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

describe('CodexAccountProfileAdapter identity (TASK-098)', () => {
  it('takes agentId and reservedEnvKeys from the Codex definition', () => {
    const adapter = createCodexAccountProfileAdapter()
    expect(adapter.agentId).toBe(CODEX_AGENT.id)
    expect(adapter.reservedEnvKeys).toEqual([CODEX_HOME_ENV_KEY])
  })

  it('registers through the helper and rejects duplicates', () => {
    const registry = requireOk(createAccountProfileAdapterRegistry())
    const registered = registerCodexAccountProfileAdapter(registry)
    expect(registered.ok).toBe(true)
    expect(registry.get(CODEX_AGENT.id)).toBe(registered.ok ? registered.data : undefined)
    expect(registerCodexAccountProfileAdapter(registry).ok).toBe(false)
  })
})

describe('CodexAccountProfileAdapter.buildRuntimeProjection (§56.1 / §10.1)', () => {
  it('projects different profiles into different CODEX_HOME values', () => {
    const adapter = createCodexAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)

    const personal = requireOk(adapter.buildRuntimeProjection(makeProfile(), runtime))
    const work = requireOk(
      adapter.buildRuntimeProjection(
        makeProfile({
          id: 'acct_codex_work',
          name: 'Codex Work',
          configHome: '/home/u/.teskra/agent-profiles/codex/work',
        }),
        runtime,
      ),
    )

    expect(personal).toEqual({
      env: { [CODEX_HOME_ENV_KEY]: '/home/u/.teskra/agent-profiles/codex/personal' },
    })
    expect(work).toEqual({
      env: { [CODEX_HOME_ENV_KEY]: '/home/u/.teskra/agent-profiles/codex/work' },
    })
    expect(personal.env[CODEX_HOME_ENV_KEY]).not.toBe(work.env[CODEX_HOME_ENV_KEY])
  })

  it('passes a WSL configHome into env verbatim — never rewritten to /mnt/c/...', () => {
    const adapter = createCodexAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)
    const profile = makeProfile()

    const projection = requireOk(adapter.buildRuntimeProjection(profile, runtime))

    // §56.1 (1)+(3): the runtime-native absolute path enters env unchanged;
    // resolveRuntimePath is for host-side run artifacts, not configHome.
    expect(projection.env[CODEX_HOME_ENV_KEY]).toBe(profile.configHome)
    expect(projection.env[CODEX_HOME_ENV_KEY]).not.toContain('/mnt/')
  })

  it('passes a Windows configHome into env verbatim', () => {
    const adapter = createCodexAccountProfileAdapter()
    const runtime = stubRuntime(WINDOWS_REF, true)
    const profile = makeProfile({
      runtime: WINDOWS_REF,
      configHome: 'C:\\Users\\u\\.teskra\\agent-profiles\\codex\\personal',
    })

    const projection = requireOk(adapter.buildRuntimeProjection(profile, runtime))

    expect(projection.env[CODEX_HOME_ENV_KEY]).toBe(
      'C:\\Users\\u\\.teskra\\agent-profiles\\codex\\personal',
    )
  })

  it('rejects a profile without configHome instead of projecting an empty env', () => {
    const adapter = createCodexAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)
    // §56.1 (2): ~/relative configHome values are already rejected by the
    // contracts schema at write time; the adapter backstop is refusing a
    // profile that carries no configHome at all.
    const profile = makeProfile({ configHome: undefined })

    const result = adapter.buildRuntimeProjection(profile, runtime)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a profile belonging to another agent', () => {
    const adapter = createCodexAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)
    const result = adapter.buildRuntimeProjection(makeProfile({ agentId: 'claude' }), runtime)
    expect(result.ok).toBe(false)
  })

  it('declares CODEX_HOME in WSLENV without the /p flag (§56.1 (4))', () => {
    const adapter = createCodexAccountProfileAdapter()
    const wslRuntime = requireOk(
      createWorkspaceRuntime(UBUNTU_REF, {
        hostPlatform: 'win32',
        paths: createTeskraPaths({ TESKRA_HOME: 'C:\\teskra-test' }),
        wsl: { available: true, version: '2.4.11.0' },
      }),
    )
    const projection = requireOk(adapter.buildRuntimeProjection(makeProfile(), wslRuntime))

    const spawnEnv = resolveSpawnEnv(wslRuntime, projection.env)

    expect(spawnEnv[CODEX_HOME_ENV_KEY]).toBe('/home/u/.teskra/agent-profiles/codex/personal')
    const wslenv = spawnEnv['WSLENV']
    expect(wslenv).toBeDefined()
    expect(wslenv?.split(':')).toContain(CODEX_HOME_ENV_KEY)
    // Plain passthrough: the value is already runtime-native, so no /p.
    expect(wslenv).not.toContain(`${CODEX_HOME_ENV_KEY}/p`)
  })

  it('leaves host-native runtime env untouched (no WSLENV invented)', () => {
    const adapter = createCodexAccountProfileAdapter()
    const nativeRuntime = stubRuntime(WINDOWS_REF, true)
    const profile = makeProfile({
      runtime: WINDOWS_REF,
      configHome: 'C:\\Users\\u\\.teskra\\agent-profiles\\codex\\personal',
    })
    const projection = requireOk(adapter.buildRuntimeProjection(profile, nativeRuntime))

    const spawnEnv = resolveSpawnEnv(nativeRuntime, projection.env)

    expect(spawnEnv).toEqual(projection.env)
    expect(spawnEnv['WSLENV']).toBeUndefined()
  })
})

describe('CodexAccountProfileAdapter.buildLoginCommand (§24)', () => {
  it('produces an argv array from the Codex definition — never a shell string', () => {
    const adapter = createCodexAccountProfileAdapter()

    const login = requireOk(adapter.buildLoginCommand(makeProfile()))

    expect(login.command).toBe(CODEX_AGENT.executable.command)
    expect(login.args).toEqual(['login'])
    expect(Array.isArray(login.args)).toBe(true)
    expect(login.command).not.toContain(' ')
    expect(login.args.join(' ')).not.toContain(CODEX_HOME_ENV_KEY)
  })

  it('uses the resolved executable (detection / override) when available', () => {
    const adapter = createCodexAccountProfileAdapter({
      resolveExecutable: () => 'C:\\Tools\\codex.cmd',
    })

    const login = requireOk(adapter.buildLoginCommand(makeProfile()))

    expect(login.command).toBe('C:\\Tools\\codex.cmd')
    expect(login.args).toEqual(['login'])
  })

  it('rejects a profile without configHome', () => {
    const adapter = createCodexAccountProfileAdapter()
    const result = adapter.buildLoginCommand(makeProfile({ configHome: undefined }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('CodexAccountProfileAdapter.detectStatus (§10.4)', () => {
  const windowsProfile = makeProfile({
    runtime: WINDOWS_REF,
    configHome: 'C:\\Users\\u\\.teskra\\agent-profiles\\codex\\personal',
  })

  function hostNativeDeps(files: ReadonlySet<string>): CodexAccountProfileAdapterDeps {
    return {
      createRuntime: () => ({ ok: true, data: stubRuntime(WINDOWS_REF, true) }),
      hostFileExists: (path) => files.has(path),
    }
  }

  it('reports ready when auth.json exists in the configHome (Windows profile)', async () => {
    const authPath = 'C:\\Users\\u\\.teskra\\agent-profiles\\codex\\personal\\auth.json'
    const adapter = createCodexAccountProfileAdapter(hostNativeDeps(new Set([authPath])))

    const detection = requireOk(await adapter.detectStatus(windowsProfile))

    expect(detection).toEqual({ status: 'ready' })
  })

  it('reports login-required when auth.json is missing (Windows profile)', async () => {
    const adapter = createCodexAccountProfileAdapter(hostNativeDeps(new Set()))

    const detection = requireOk(await adapter.detectStatus(windowsProfile))

    expect(detection).toEqual({ status: 'login-required' })
  })

  it('reports unknown when the host-native probe cannot answer', async () => {
    const adapter = createCodexAccountProfileAdapter({
      createRuntime: () => ({ ok: true, data: stubRuntime(WINDOWS_REF, true) }),
      hostFileExists: () => {
        throw new Error('EACCES')
      },
    })

    const detection = requireOk(await adapter.detectStatus(windowsProfile))

    expect(detection).toEqual({ status: 'unknown' })
  })

  it('probes a WSL profile inside the distro with an argv test -f command', async () => {
    const commands = new FakeCommands(() => ({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    }))
    const adapter = createCodexAccountProfileAdapter({
      commands,
      createRuntime: () => ({ ok: true, data: stubRuntime(UBUNTU_REF, false) }),
    })

    const detection = requireOk(await adapter.detectStatus(makeProfile()))

    expect(detection).toEqual({ status: 'ready' })
    expect(commands.calls).toHaveLength(1)
    const probe = commands.calls[0]
    // Existence only — argv form, never a shell string, never file contents.
    expect(probe?.command).toBe('test')
    expect(probe?.args).toEqual(['-f', '/home/u/.teskra/agent-profiles/codex/personal/auth.json'])
    expect(probe?.command).not.toBe('cat')
    expect(probe?.command).not.toBe('bash')
  })

  it('reports login-required for a WSL profile whose auth probe exits non-zero', async () => {
    const commands = new FakeCommands(() => ({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 1 },
    }))
    const adapter = createCodexAccountProfileAdapter({
      commands,
      createRuntime: () => ({ ok: true, data: stubRuntime(UBUNTU_REF, false) }),
    })

    const detection = requireOk(await adapter.detectStatus(makeProfile()))

    expect(detection).toEqual({ status: 'login-required' })
  })

  it('reports unknown when the WSL probe fails or no command runner exists', async () => {
    const failing = new FakeCommands(() => ({
      ok: false,
      error: {
        code: 'COMMAND_TIMEOUT',
        message: 'timed out',
        retryable: true,
      },
    }))
    const withFailingCommands = createCodexAccountProfileAdapter({
      commands: failing,
      createRuntime: () => ({ ok: true, data: stubRuntime(UBUNTU_REF, false) }),
    })
    const withoutCommands = createCodexAccountProfileAdapter({
      createRuntime: () => ({ ok: true, data: stubRuntime(UBUNTU_REF, false) }),
    })

    expect(requireOk(await withFailingCommands.detectStatus(makeProfile()))).toEqual({
      status: 'unknown',
    })
    expect(requireOk(await withoutCommands.detectStatus(makeProfile()))).toEqual({
      status: 'unknown',
    })
  })

  it('reports unknown for a profile without configHome', async () => {
    const adapter = createCodexAccountProfileAdapter()

    const detection = requireOk(await adapter.detectStatus(makeProfile({ configHome: undefined })))

    expect(detection).toEqual({ status: 'unknown' })
  })
})

describe('CodexAccountProfileAdapter.initializeProfileHome (§10.2/§10.3)', () => {
  it('bootstraps nothing and never touches auth material or the filesystem', async () => {
    const commands = new FakeCommands(() => ({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    }))
    let hostProbes = 0
    const adapter = createCodexAccountProfileAdapter({
      commands,
      hostFileExists: () => {
        hostProbes += 1
        return false
      },
    })

    const result = await adapter.initializeProfileHome?.(makeProfile())

    expect(result?.ok).toBe(true)
    expect(commands.calls).toHaveLength(0)
    expect(hostProbes).toBe(0)
  })
})
