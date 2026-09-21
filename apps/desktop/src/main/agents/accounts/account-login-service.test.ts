import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentAccountProfile,
  IpcResult,
  WorkbenchEvents,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createEventBus, type EventBus } from '../../events/event-bus'
import type { CommandRequest, CommandResult } from '../../process/command-runner'
import type {
  ManagedProcess,
  ProcessStartRequest,
  ProcessStopResult,
} from '../../process/process-manager'
import { createWorkspaceRuntime } from '../../workspace/runtime'
import type {
  AccountProfileLoginCommand,
  AccountProfileRuntimeProjection,
  AccountProfileStatusDetection,
  AgentAccountProfileAdapter,
} from './account-profile-adapter'
import {
  ACCOUNT_LOGIN_SESSION_TIMEOUT_MS,
  createAccountLoginService,
  type AccountLoginServiceDeps,
} from './account-login-service'

const AT = '2026-09-13T00:00:00.000Z'

const PROFILE: AgentAccountProfile = {
  id: 'acct-1',
  agentId: 'codex',
  name: 'Codex Personal',
  authType: 'subscription',
  runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
  configHome: '/home/dev/.teskra/agent-profiles/codex/personal',
  maxConcurrentRuns: 1,
  status: 'login-required',
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
}

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `generated-${String(index)}`
}

function fakeProfiles(
  initial: readonly AgentAccountProfile[],
): AccountLoginServiceDeps['profiles'] & {
  statuses: Array<{ id: string; status: string }>
} {
  const rows = new Map(initial.map((profile) => [profile.id, { ...profile }]))
  const statuses: Array<{ id: string; status: string }> = []
  return {
    statuses,
    getById(id) {
      const row = rows.get(id)
      return { ok: true, data: row === undefined ? null : { ...row } }
    },
    setStatus(id, patch) {
      const row = rows.get(id)
      if (row === undefined) {
        return { ok: true, data: null }
      }
      statuses.push({ id, status: patch.status })
      rows.set(id, {
        ...row,
        status: patch.status,
        ...(patch.limitedUntil !== undefined
          ? { limitedUntil: patch.limitedUntil ?? undefined }
          : {}),
      })
      return { ok: true, data: { ...(rows.get(id) as AgentAccountProfile) } }
    },
  }
}

function fakeAdapter(
  overrides: Partial<AgentAccountProfileAdapter> = {},
): AgentAccountProfileAdapter {
  return {
    agentId: 'codex',
    reservedEnvKeys: ['CODEX_HOME'],
    buildRuntimeProjection(profile): IpcResult<AccountProfileRuntimeProjection> {
      return { ok: true, data: { env: { CODEX_HOME: profile.configHome ?? '' } } }
    },
    detectStatus(): Promise<IpcResult<AccountProfileStatusDetection>> {
      return Promise.resolve({ ok: true, data: { status: 'ready' } })
    },
    buildLoginCommand(): IpcResult<AccountProfileLoginCommand> {
      return { ok: true, data: { command: 'codex', args: ['login'] } }
    },
    ...overrides,
  }
}

interface FakeProcesses {
  processes: AccountLoginServiceDeps['processes']
  starts: ProcessStartRequest[]
  writes: Array<[string, string]>
  resizes: Array<[string, number, number]>
  stops: string[]
  /** When true, stop() does NOT emit process.exited (defensive-path tests). */
  silentStop: boolean
}

function fakeProcesses(events: EventBus<WorkbenchEvents>): FakeProcesses {
  const fake: FakeProcesses = {
    starts: [],
    writes: [],
    resizes: [],
    stops: [],
    silentStop: false,
    processes: {
      start(request): IpcResult<ManagedProcess> {
        fake.starts.push(request)
        return {
          ok: true,
          data: { id: request.id, pid: 10_000 + fake.starts.length, startedAt: AT },
        }
      },
      write(processId, data) {
        fake.writes.push([processId, data])
        return { ok: true, data: undefined }
      },
      resize(processId, cols, rows) {
        fake.resizes.push([processId, cols, rows])
        return { ok: true, data: undefined }
      },
      stop(processId): Promise<IpcResult<ProcessStopResult>> {
        fake.stops.push(processId)
        const exit = { processId, exitCode: 0 }
        if (!fake.silentStop) {
          events.emit('process.exited', exit)
        }
        return Promise.resolve({ ok: true, data: { stage: 'interrupt', exit } })
      },
    },
  }
  return fake
}

interface FakeCommands {
  commands: NonNullable<AccountLoginServiceDeps['commands']>
  calls: CommandRequest[]
}

function fakeCommands(exitCode = 0): FakeCommands {
  const calls: CommandRequest[] = []
  return {
    calls,
    commands: {
      run(request: CommandRequest): Promise<IpcResult<CommandResult>> {
        calls.push(request)
        return Promise.resolve({ ok: true, data: { stdout: '', stderr: '', exitCode } })
      },
    },
  }
}

function setup(
  overrides: {
    profiles?: readonly AgentAccountProfile[]
    adapter?: AgentAccountProfileAdapter
    sessionTimeoutMs?: number
    idValues?: string[]
    commands?: FakeCommands
    detectExecutable?: AccountLoginServiceDeps['detectExecutable']
  } = {},
) {
  const events = createEventBus<WorkbenchEvents>()
  const processes = fakeProcesses(events)
  const profiles = fakeProfiles(overrides.profiles ?? [PROFILE])
  const adapter = overrides.adapter ?? fakeAdapter()
  const commands = overrides.commands ?? fakeCommands()
  const service = createAccountLoginService({
    profiles,
    processes: processes.processes,
    events,
    adapters: { get: (agentId) => (agentId === 'codex' ? adapter : undefined) },
    commands: commands.commands,
    createRuntime: (ref: WorkspaceRuntimeRef) =>
      createWorkspaceRuntime(ref, {
        hostPlatform: 'win32',
        wsl: {
          available: true,
          version: '2.6.3.0',
          distributions: ['Ubuntu-24.04'],
          defaultDistro: 'Ubuntu-24.04',
          homeDirs: { 'Ubuntu-24.04': '/home/dev' },
        },
      }),
    createId: ids(...(overrides.idValues ?? ['sess-1', 'proc-1', 'sess-2', 'proc-2'])),
    now: () => AT,
    sessionTimeoutMs: overrides.sessionTimeoutMs,
    detectExecutable: overrides.detectExecutable,
  })
  return { events, processes, profiles, adapter, commands, service }
}

describe('AccountLoginService (TASK-102 §24)', () => {
  afterEach(() => vi.useRealTimers())

  it('starts a login session immediately with argv/env built in Main (never a shell string)', async () => {
    const { processes, commands, service } = setup()

    const result = await service.start({ profileId: 'acct-1' })

    expect(result).toEqual({
      ok: true,
      data: { sessionId: 'sess-1', profileId: 'acct-1', startedAt: AT },
    })
    const start = processes.starts[0]
    expect(start).toMatchObject({
      id: 'proc-1',
      command: 'codex',
      args: ['login'],
      env: { CODEX_HOME: PROFILE.configHome },
    })
    // P2-13: the login PTY runs from a dedicated per-profile directory under
    // the runtime's data root — never the configHome, which the CLI would
    // otherwise treat as a project directory (Claude Code writes a
    // project-level `.claude/` into its cwd).
    expect(start?.cwd).toBe('/home/dev/.teskra/account-logins/acct-1')
    expect(start?.cwd).not.toBe(PROFILE.configHome)
    // The workdir is created inside the distro with an argv-array mkdir.
    expect(commands.calls).toEqual([
      expect.objectContaining({
        command: 'mkdir',
        args: ['-p', '--', '/home/dev/.teskra/account-logins/acct-1'],
      }),
    ])
    // No workspace binding — login is a global CLI operation (§24).
    expect(start?.workspaceId).toBeUndefined()
  })

  it('launches the detector-resolved executable path instead of the bare command, args unchanged', async () => {
    const detectExecutable = vi.fn(() =>
      Promise.resolve('C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'),
    )
    const { processes, service } = setup({ detectExecutable })

    const result = await service.start({ profileId: 'acct-1' })

    expect(result.ok).toBe(true)
    expect(detectExecutable).toHaveBeenCalledWith('codex', PROFILE.runtime)
    const start = processes.starts[0]
    expect(start?.command).toBe('C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd')
    expect(start?.args).toEqual(['login'])
  })

  it('falls back to the bare command when detection reports the CLI as not installed', async () => {
    const detectExecutable = vi.fn(() => Promise.resolve(undefined))
    const { processes, service } = setup({ detectExecutable })

    const result = await service.start({ profileId: 'acct-1' })

    expect(result.ok).toBe(true)
    const start = processes.starts[0]
    expect(start?.command).toBe('codex')
    expect(start?.args).toEqual(['login'])
  })

  it('falls back to the bare command when detection throws', async () => {
    const detectExecutable = vi.fn(() => Promise.reject(new Error('where.exe exploded')))
    const { processes, service } = setup({ detectExecutable })

    const result = await service.start({ profileId: 'acct-1' })

    expect(result.ok).toBe(true)
    const start = processes.starts[0]
    expect(start?.command).toBe('codex')
    expect(start?.args).toEqual(['login'])
  })

  it('refuses a disabled profile with ACCOUNT_PROFILE_DISABLED before any side effect', async () => {
    const disabled: AgentAccountProfile = { ...PROFILE, id: 'acct-disabled', enabled: false }
    const { processes, commands, service } = setup({ profiles: [disabled] })

    const result = await service.start({ profileId: 'acct-disabled' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
    }
    expect(processes.starts).toHaveLength(0)
    expect(commands.calls).toHaveLength(0)
    expect(service.sessionForProfile('acct-disabled')).toBeUndefined()
  })

  it('fails fast when the WSL distro home is unknown instead of creating a literal ~ directory', async () => {
    const events = createEventBus<WorkbenchEvents>()
    const processes = fakeProcesses(events)
    const commands = fakeCommands()
    const service = createAccountLoginService({
      profiles: fakeProfiles([PROFILE]),
      processes: processes.processes,
      events,
      adapters: { get: () => fakeAdapter() },
      commands: commands.commands,
      createRuntime: (ref: WorkspaceRuntimeRef) =>
        createWorkspaceRuntime(ref, {
          hostPlatform: 'win32',
          // No homeDirs: detection could not probe the distro home, so the
          // data root degrades to a literal `~/.teskra` that no shell expands.
          wsl: { available: true, version: '2.6.3.0' },
        }),
      createId: ids('sess-1', 'proc-1'),
      now: () => AT,
    })

    const result = await service.start({ profileId: 'acct-1' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('WSL_DISTRO_NOT_FOUND')
    }
    expect(processes.starts).toHaveLength(0)
    expect(commands.calls).toHaveLength(0)
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
  })

  it('fails the login when the working directory cannot be created', async () => {
    const { processes, service } = setup({ commands: fakeCommands(1) })

    const result = await service.start({ profileId: 'acct-1' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN')
    }
    expect(processes.starts).toHaveLength(0)
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
  })

  it('refuses a WSL login session without a command runner', async () => {
    const events = createEventBus<WorkbenchEvents>()
    const processes = fakeProcesses(events)
    const service = createAccountLoginService({
      profiles: fakeProfiles([PROFILE]),
      processes: processes.processes,
      events,
      adapters: { get: () => fakeAdapter() },
      createRuntime: (ref: WorkspaceRuntimeRef) =>
        createWorkspaceRuntime(ref, {
          hostPlatform: 'win32',
          wsl: {
            available: true,
            version: '2.6.3.0',
            distributions: ['Ubuntu-24.04'],
            defaultDistro: 'Ubuntu-24.04',
            homeDirs: { 'Ubuntu-24.04': '/home/dev' },
          },
        }),
      createId: ids('sess-1', 'proc-1'),
      now: () => AT,
    })

    const result = await service.start({ profileId: 'acct-1' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    }
    expect(processes.starts).toHaveLength(0)
  })

  it('returns structured errors for unknown profiles and agents without an adapter', async () => {
    const { service } = setup()
    const missing = await service.start({ profileId: 'nope' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')

    const otherAgent = { ...PROFILE, id: 'acct-claude', agentId: 'claude' }
    const { service: service2 } = setup({ profiles: [otherAgent] })
    const noAdapter = await service2.start({ profileId: 'acct-claude' })
    expect(noAdapter.ok).toBe(false)
    if (!noAdapter.ok) expect(noAdapter.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
  })

  it('refuses to start a login session for an external profile (TASK-113, §49)', async () => {
    const external: AgentAccountProfile = {
      ...PROFILE,
      id: 'acct-external',
      authType: 'external',
      configHome: '/home/dev/.codex',
    }
    const { processes, service } = setup({ profiles: [external] })

    const result = await service.start({ profileId: 'acct-external' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED')
      expect(result.error.message).toContain('managed externally')
    }
    // Teskra never modifies an external home's login state (§49): no process,
    // no session.
    expect(processes.starts).toHaveLength(0)
    expect(service.sessionForProfile('acct-external')).toBeUndefined()
  })

  it('still detects the status of an external profile — probing reads, never writes login state (§49)', async () => {
    const external: AgentAccountProfile = {
      ...PROFILE,
      id: 'acct-external',
      authType: 'external',
      configHome: '/home/dev/.codex',
      status: 'unknown',
    }
    const { profiles, service } = setup({ profiles: [external] })

    const detected = await service.detectProfileStatus('acct-external')

    expect(detected.ok && detected.data.status).toBe('ready')
    expect(profiles.statuses).toEqual([{ id: 'acct-external', status: 'ready' }])
  })

  it('mutex: a repeated start for the same profile returns the existing session without spawning', async () => {
    const { processes, service } = setup()

    const first = await service.start({ profileId: 'acct-1' })
    const second = await service.start({ profileId: 'acct-1' })
    if (!first.ok || !second.ok) throw new Error('expected sessions')

    expect(second.data).toEqual(first.data)
    expect(processes.starts).toHaveLength(1)
    expect(service.sessionForProfile('acct-1')?.sessionId).toBe('sess-1')
  })

  it('attach leases: the first cancel only releases a lease, the second stops the process', async () => {
    const { events, processes, profiles, service } = setup()
    const exited = vi.fn()
    events.subscribe('account.login.exited', exited)

    // Two attaches on the same session — the StrictMode double-mount shape.
    const first = await service.start({ profileId: 'acct-1' })
    const second = await service.start({ profileId: 'acct-1' })
    if (!first.ok || !second.ok) throw new Error('expected sessions')
    expect(second.data.sessionId).toBe(first.data.sessionId)
    expect(processes.starts).toHaveLength(1)

    // The first unmount releases its lease: the PTY and the session survive.
    const released = await service.cancel('sess-1')
    expect(released.ok).toBe(true)
    expect(processes.stops).toHaveLength(0)
    expect(exited).not.toHaveBeenCalled()
    expect(service.sessionForProfile('acct-1')?.sessionId).toBe('sess-1')

    // The last lease release stops the process and removes the session.
    const stopped = await service.cancel('sess-1')
    expect(stopped.ok).toBe(true)
    expect(processes.stops).toEqual(['proc-1'])
    expect(exited).toHaveBeenCalledWith({ sessionId: 'sess-1', exitCode: 0 })
    expect(profiles.statuses).toEqual([])
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
  })

  it('natural exit with two outstanding leases settles once; later cancels are no-ops', async () => {
    const { events, processes, profiles, service } = setup()
    const exited = vi.fn()
    const statusChanged = vi.fn()
    events.subscribe('account.login.exited', exited)
    events.subscribe('account.status_changed', statusChanged)

    await service.start({ profileId: 'acct-1' })
    await service.start({ profileId: 'acct-1' })

    // A natural exit settles the session regardless of the lease count.
    events.emit('process.exited', { processId: 'proc-1', exitCode: 0 })
    await vi.waitFor(() => expect(profiles.statuses).toEqual([{ id: 'acct-1', status: 'ready' }]))

    expect(exited).toHaveBeenCalledTimes(1)
    expect(statusChanged).toHaveBeenCalledTimes(1)
    expect(service.sessionForProfile('acct-1')).toBeUndefined()

    // Releasing the stranded leases afterwards is a no-op: no stop call, and
    // the stale-cancel error contract is unchanged.
    const staleFirst = await service.cancel('sess-1')
    const staleSecond = await service.cancel('sess-1')
    expect(staleFirst.ok).toBe(false)
    expect(staleSecond.ok).toBe(false)
    expect(processes.stops).toHaveLength(0)
  })

  it('the Main-side timeout force-stops the session even with outstanding leases', async () => {
    vi.useFakeTimers()
    const { processes, profiles, service } = setup({ sessionTimeoutMs: 1_000 })

    // Two attaches, then the Renderer window reloads: its leases are stranded
    // (never cancelled). The timeout is the backstop that still reaps the PTY.
    await service.start({ profileId: 'acct-1' })
    await service.start({ profileId: 'acct-1' })

    await vi.advanceTimersByTimeAsync(1_000)

    expect(processes.stops).toEqual(['proc-1'])
    expect(profiles.statuses).toEqual([])
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
  })

  it('forwards process output as account.login.output and write/resize to the owning process', async () => {
    const { events, processes, service } = setup()
    const output = vi.fn()
    events.subscribe('account.login.output', output)
    const started = await service.start({ profileId: 'acct-1' })
    if (!started.ok) throw new Error('expected session')

    events.emit('process.output', { processId: 'proc-1', data: 'Open https://…' })
    expect(output).toHaveBeenCalledWith({ sessionId: 'sess-1', data: 'Open https://…' })

    expect(service.write('sess-1', '\r').ok).toBe(true)
    expect(service.resize('sess-1', 100, 40).ok).toBe(true)
    expect(processes.writes).toEqual([['proc-1', '\r']])
    expect(processes.resizes).toEqual([['proc-1', 100, 40]])

    expect(service.write('stale', 'x').ok).toBe(false)
    expect(service.resize('stale', 1, 1).ok).toBe(false)
  })

  it('natural exit emits account.login.exited, then detects and updates Profile.status (§24)', async () => {
    const { events, profiles, service } = setup()
    const exited = vi.fn()
    const statusChanged = vi.fn()
    events.subscribe('account.login.exited', exited)
    events.subscribe('account.status_changed', statusChanged)
    await service.start({ profileId: 'acct-1' })

    events.emit('process.exited', { processId: 'proc-1', exitCode: 0 })
    await vi.waitFor(() => expect(profiles.statuses).toEqual([{ id: 'acct-1', status: 'ready' }]))

    expect(exited).toHaveBeenCalledWith({ sessionId: 'sess-1', exitCode: 0 })
    expect(statusChanged).toHaveBeenCalledWith({
      profileId: 'acct-1',
      agentId: 'codex',
      status: 'ready',
      previousStatus: 'login-required',
    })
    // The session is finalized — the mutex is free for a fresh login.
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
  })

  it('cancel stops the process and keeps the pre-login Profile.status (no detect, never expired)', async () => {
    const { events, profiles, service } = setup()
    const exited = vi.fn()
    events.subscribe('account.login.exited', exited)
    await service.start({ profileId: 'acct-1' })

    const cancelled = await service.cancel('sess-1')

    expect(cancelled.ok).toBe(true)
    expect(exited).toHaveBeenCalledWith({ sessionId: 'sess-1', exitCode: 0 })
    expect(profiles.statuses).toEqual([])
    const kept = profiles.getById('acct-1')
    expect(kept.ok && kept.data?.status).toBe('login-required')
    expect(service.sessionForProfile('acct-1')).toBeUndefined()

    const stale = await service.cancel('sess-1')
    expect(stale.ok).toBe(false)
  })

  it('stops the session after the Main-side timeout without a Renderer cancel', async () => {
    vi.useFakeTimers()
    const { processes, profiles, service } = setup({ sessionTimeoutMs: 1_000 })
    const started = await service.start({ profileId: 'acct-1' })
    if (!started.ok) throw new Error('expected session')

    expect(ACCOUNT_LOGIN_SESSION_TIMEOUT_MS).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(processes.stops).toEqual(['proc-1'])
    expect(profiles.statuses).toEqual([])
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
  })

  it('does not start a second process when spawn fails', async () => {
    const { events, profiles } = setup()
    const failing = fakeProcesses(events)
    failing.processes = {
      ...failing.processes,
      start: () => ({
        ok: false,
        error: { code: 'UNKNOWN', message: 'spawn failed', retryable: true },
      }),
    }
    const service = createAccountLoginService({
      profiles,
      processes: failing.processes,
      events,
      adapters: { get: () => fakeAdapter() },
      commands: fakeCommands().commands,
      createRuntime: (ref: WorkspaceRuntimeRef) =>
        createWorkspaceRuntime(ref, {
          hostPlatform: 'win32',
          wsl: {
            available: true,
            version: '2.6.3.0',
            distributions: ['Ubuntu-24.04'],
            defaultDistro: 'Ubuntu-24.04',
            homeDirs: { 'Ubuntu-24.04': '/home/dev' },
          },
        }),
      createId: ids('sess-1', 'proc-1'),
      now: () => AT,
    })

    const result = await service.start({ profileId: 'acct-1' })
    expect(result.ok).toBe(false)
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
  })

  it('dispose stops every active login process and detaches event forwarding (P0-2)', async () => {
    const { events, processes, profiles, service } = setup()
    const output = vi.fn()
    events.subscribe('account.login.output', output)
    await service.start({ profileId: 'acct-1' })

    await service.dispose()

    expect(processes.stops).toEqual(['proc-1'])
    expect(service.sessionForProfile('acct-1')).toBeUndefined()
    // Shutdown is a cancel: no post-exit detect.
    expect(profiles.statuses).toEqual([])

    events.emit('process.output', { processId: 'proc-1', data: 'hidden' })
    expect(output).not.toHaveBeenCalled()
  })

  it('detectProfileStatus persists the adapter probe and emits status changes', async () => {
    const { events, profiles, service } = setup()
    const statusChanged = vi.fn()
    events.subscribe('account.status_changed', statusChanged)

    const detected = await service.detectProfileStatus('acct-1')
    expect(detected.ok && detected.data.status).toBe('ready')
    expect(profiles.statuses).toEqual([{ id: 'acct-1', status: 'ready' }])
    expect(statusChanged).toHaveBeenCalledTimes(1)

    // An unchanged status persists silently (no duplicate event).
    const again = await service.detectProfileStatus('acct-1')
    expect(again.ok).toBe(true)
    expect(statusChanged).toHaveBeenCalledTimes(1)

    const missing = await service.detectProfileStatus('nope')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
  })

  it('surfaces adapter detect failures on the channel path but only logs after exit', async () => {
    const adapter = fakeAdapter({
      detectStatus: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'UNKNOWN', message: 'probe failed', retryable: true },
        }),
    })
    const { events, profiles, service } = setup({ adapter })

    const failed = await service.detectProfileStatus('acct-1')
    expect(failed.ok).toBe(false)

    await service.start({ profileId: 'acct-1' })
    events.emit('process.exited', { processId: 'proc-1', exitCode: 0 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(profiles.statuses).toEqual([])
  })
})
