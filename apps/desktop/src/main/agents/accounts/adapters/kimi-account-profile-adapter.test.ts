import { describe, expect, it } from 'vitest'

import type { AgentAccountProfile, IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import { createTeskraPaths } from '../../../paths'
import type { CommandRequest, CommandResult } from '../../../process/command-runner'
import {
  createWorkspaceRuntime,
  resolveSpawnEnv,
  type WorkspaceRuntime,
} from '../../../workspace/runtime'
import { KIMI_AGENT } from '../../definitions/kimi'
import {
  createKimiAccountProfileAdapter,
  KIMI_CODE_HOME_ENV_KEY,
  registerKimiAccountProfileAdapter,
  type KimiAccountProfileAdapterDeps,
} from './kimi-account-profile-adapter'
import { createAccountProfileAdapterRegistry } from '../account-profile-adapter'

/**
 * Kimi account profile adapter tests — mirrors the Codex adapter suite: the
 * §5.3 / §10.1 projection rules, the §10.3 probe-outcome mapping (including
 * the config.toml fallback for API-key users), and the bare-TUI login command.
 */

const WINDOWS_REF: WorkspaceRuntimeRef = { kind: 'windows' }
const UBUNTU_REF: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'Ubuntu-22.04' }

function makeProfile(overrides: Partial<AgentAccountProfile> = {}): AgentAccountProfile {
  return {
    id: 'acct_kimi_personal',
    agentId: KIMI_AGENT.id,
    name: 'Kimi Personal',
    authType: 'subscription',
    runtime: UBUNTU_REF,
    configHome: '/home/u/.teskra/agent-profiles/kimi/personal',
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

describe('KimiAccountProfileAdapter identity', () => {
  it('takes agentId and reservedEnvKeys from the Kimi definition', () => {
    const adapter = createKimiAccountProfileAdapter()
    expect(adapter.agentId).toBe(KIMI_AGENT.id)
    expect(adapter.reservedEnvKeys).toEqual([KIMI_CODE_HOME_ENV_KEY])
  })

  it('registers through the helper and rejects duplicates', () => {
    const registry = requireOk(createAccountProfileAdapterRegistry())
    const registered = registerKimiAccountProfileAdapter(registry)
    expect(registered.ok).toBe(true)
    expect(registry.get(KIMI_AGENT.id)).toBe(registered.ok ? registered.data : undefined)
    expect(registerKimiAccountProfileAdapter(registry).ok).toBe(false)
  })
})

describe('KimiAccountProfileAdapter.buildRuntimeProjection (§10.1)', () => {
  it('projects different profiles into different KIMI_CODE_HOME values', () => {
    const adapter = createKimiAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)

    const personal = requireOk(adapter.buildRuntimeProjection(makeProfile(), runtime))
    const work = requireOk(
      adapter.buildRuntimeProjection(
        makeProfile({
          id: 'acct_kimi_work',
          name: 'Kimi Work',
          configHome: '/home/u/.teskra/agent-profiles/kimi/work',
        }),
        runtime,
      ),
    )

    expect(personal).toEqual({
      env: { [KIMI_CODE_HOME_ENV_KEY]: '/home/u/.teskra/agent-profiles/kimi/personal' },
    })
    expect(work).toEqual({
      env: { [KIMI_CODE_HOME_ENV_KEY]: '/home/u/.teskra/agent-profiles/kimi/work' },
    })
    expect(personal.env[KIMI_CODE_HOME_ENV_KEY]).not.toBe(work.env[KIMI_CODE_HOME_ENV_KEY])
  })

  it('passes a WSL configHome into env verbatim — never rewritten to /mnt/c/...', () => {
    const adapter = createKimiAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)
    const profile = makeProfile()

    const projection = requireOk(adapter.buildRuntimeProjection(profile, runtime))

    expect(projection.env[KIMI_CODE_HOME_ENV_KEY]).toBe(profile.configHome)
    expect(projection.env[KIMI_CODE_HOME_ENV_KEY]).not.toContain('/mnt/')
  })

  it('rejects a profile without configHome instead of projecting an empty env', () => {
    const adapter = createKimiAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)

    const result = adapter.buildRuntimeProjection(makeProfile({ configHome: undefined }), runtime)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a profile belonging to another agent', () => {
    const adapter = createKimiAccountProfileAdapter()
    const runtime = stubRuntime(UBUNTU_REF, false)
    const result = adapter.buildRuntimeProjection(makeProfile({ agentId: 'codex' }), runtime)
    expect(result.ok).toBe(false)
  })

  it('declares KIMI_CODE_HOME in WSLENV without the /p flag', () => {
    const adapter = createKimiAccountProfileAdapter()
    const wslRuntime = requireOk(
      createWorkspaceRuntime(UBUNTU_REF, {
        hostPlatform: 'win32',
        paths: createTeskraPaths({ TESKRA_HOME: 'C:\\teskra-test' }),
        wsl: { available: true, version: '2.4.11.0' },
      }),
    )
    const projection = requireOk(adapter.buildRuntimeProjection(makeProfile(), wslRuntime))

    const spawnEnv = resolveSpawnEnv(wslRuntime, projection.env)

    expect(spawnEnv[KIMI_CODE_HOME_ENV_KEY]).toBe('/home/u/.teskra/agent-profiles/kimi/personal')
    const wslenv = spawnEnv['WSLENV']
    expect(wslenv).toBeDefined()
    expect(wslenv?.split(':')).toContain(KIMI_CODE_HOME_ENV_KEY)
    // Plain passthrough: the value is already runtime-native, so no /p.
    expect(wslenv).not.toContain(`${KIMI_CODE_HOME_ENV_KEY}/p`)
  })
})

describe('KimiAccountProfileAdapter.buildLoginCommand (§24)', () => {
  it('launches the bare TUI from the Kimi definition — argv array, never a shell string', () => {
    const adapter = createKimiAccountProfileAdapter()

    const login = requireOk(adapter.buildLoginCommand(makeProfile()))

    // No login subcommand: a fresh KIMI_CODE_HOME runs the CLI's first-run
    // onboarding; an expired profile uses /login inside the same TUI.
    expect(login.command).toBe(KIMI_AGENT.executable.command)
    expect(login.args).toEqual([])
    expect(Array.isArray(login.args)).toBe(true)
    expect(login.command).not.toContain(' ')
    expect(login.args.join(' ')).not.toContain(KIMI_CODE_HOME_ENV_KEY)
  })

  it('uses the resolved executable (detection / override) when available', () => {
    const adapter = createKimiAccountProfileAdapter({
      resolveExecutable: () => 'C:\\Tools\\kimi.cmd',
    })

    const login = requireOk(adapter.buildLoginCommand(makeProfile()))

    expect(login.command).toBe('C:\\Tools\\kimi.cmd')
    expect(login.args).toEqual([])
  })

  it('rejects a profile without configHome', () => {
    const adapter = createKimiAccountProfileAdapter()
    const result = adapter.buildLoginCommand(makeProfile({ configHome: undefined }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('KimiAccountProfileAdapter.detectStatus (§10.3/§10.4)', () => {
  const windowsProfile = makeProfile({
    runtime: WINDOWS_REF,
    configHome: 'C:\\Users\\u\\.teskra\\agent-profiles\\kimi\\personal',
  })
  const windowsCredentials =
    'C:\\Users\\u\\.teskra\\agent-profiles\\kimi\\personal\\credentials\\kimi-code.json'
  const windowsConfig = 'C:\\Users\\u\\.teskra\\agent-profiles\\kimi\\personal\\config.toml'

  function hostNativeDeps(files: ReadonlySet<string>): KimiAccountProfileAdapterDeps {
    return {
      createRuntime: () => ({ ok: true, data: stubRuntime(WINDOWS_REF, true) }),
      hostFileExists: (path) => files.has(path),
    }
  }

  it('reports ready when credentials/kimi-code.json exists in the configHome (Windows profile)', async () => {
    const adapter = createKimiAccountProfileAdapter(hostNativeDeps(new Set([windowsCredentials])))

    const detection = requireOk(await adapter.detectStatus(windowsProfile))

    expect(detection).toEqual({ status: 'ready' })
  })

  it('reports login-required when neither credentials nor config.toml exist (Windows profile)', async () => {
    const adapter = createKimiAccountProfileAdapter(hostNativeDeps(new Set()))

    const detection = requireOk(await adapter.detectStatus(windowsProfile))

    expect(detection).toEqual({ status: 'login-required' })
  })

  it('reports unknown when credentials are missing but config.toml exists (API-key user)', async () => {
    // config.toml can carry standalone API-key credentials; existence proves
    // nothing about validity, so the honest answer is unknown — never ready.
    const adapter = createKimiAccountProfileAdapter(hostNativeDeps(new Set([windowsConfig])))

    const detection = requireOk(await adapter.detectStatus(windowsProfile))

    expect(detection).toEqual({ status: 'unknown' })
  })

  it('reports unknown when the host-native probe cannot answer', async () => {
    const adapter = createKimiAccountProfileAdapter({
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
    const adapter = createKimiAccountProfileAdapter({
      commands,
      createRuntime: () => ({ ok: true, data: stubRuntime(UBUNTU_REF, false) }),
    })

    const detection = requireOk(await adapter.detectStatus(makeProfile()))

    expect(detection).toEqual({ status: 'ready' })
    expect(commands.calls).toHaveLength(1)
    const probe = commands.calls[0]
    // Existence only — argv form, never a shell string, never file contents.
    expect(probe?.command).toBe('test')
    expect(probe?.args).toEqual([
      '-f',
      '/home/u/.teskra/agent-profiles/kimi/personal/credentials/kimi-code.json',
    ])
    expect(probe?.command).not.toBe('cat')
    expect(probe?.command).not.toBe('bash')
  })

  it('reports login-required for a WSL profile whose credentials probe exits non-zero', async () => {
    const commands = new FakeCommands(() => ({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 1 },
    }))
    const adapter = createKimiAccountProfileAdapter({
      commands,
      createRuntime: () => ({ ok: true, data: stubRuntime(UBUNTU_REF, false) }),
    })

    const detection = requireOk(await adapter.detectStatus(makeProfile()))

    expect(detection).toEqual({ status: 'login-required' })
    // Both probes ran: credentials missing, then config.toml missing.
    expect(commands.calls).toHaveLength(2)
    expect(commands.calls[1]?.args).toEqual([
      '-f',
      '/home/u/.teskra/agent-profiles/kimi/personal/config.toml',
    ])
  })

  it('treats any ran-but-non-zero credentials probe exit as login-required, not unknown', async () => {
    // Codex-aligned: the probe RAN and the file was not confirmed — only a
    // probe that could not run at all is inconclusive (unknown).
    const commands = new FakeCommands(() => ({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 2 },
    }))
    const adapter = createKimiAccountProfileAdapter({
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
    const withFailingCommands = createKimiAccountProfileAdapter({
      commands: failing,
      createRuntime: () => ({ ok: true, data: stubRuntime(UBUNTU_REF, false) }),
    })
    const withoutCommands = createKimiAccountProfileAdapter({
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
    const adapter = createKimiAccountProfileAdapter()

    const detection = requireOk(await adapter.detectStatus(makeProfile({ configHome: undefined })))

    expect(detection).toEqual({ status: 'unknown' })
  })
})

describe('KimiAccountProfileAdapter.initializeProfileHome (§10.2/§10.3)', () => {
  it('bootstraps nothing and never touches auth material or the filesystem', async () => {
    const commands = new FakeCommands(() => ({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    }))
    let hostProbes = 0
    const adapter = createKimiAccountProfileAdapter({
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
