import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { createEventBus } from '../events/event-bus'
import type { WorkspaceRuntime } from '../workspace/runtime'
import {
  createProcessManager,
  type KillPolicy,
  type ProcessManagerDeps,
  type ProcessStartRequest,
} from './process-manager'

const FAST_KILL_POLICY: KillPolicy = {
  interruptTimeoutMs: 5,
  terminateTimeoutMs: 5,
  forceKillTimeoutMs: 5,
}

interface FakePty extends IPty {
  emitData(data: string): void
  emitExit(exitCode: number, signal?: number): void
  readonly writes: Array<string | Buffer>
  readonly resizes: Array<[number, number]>
  readonly kills: Array<string | undefined>
}

function fakePtyBackend(): {
  spawn: NonNullable<ProcessManagerDeps['spawn']>
  terminals: FakePty[]
  calls: Array<{ file: string; args: string[] | string; options: unknown }>
} {
  const terminals: FakePty[] = []
  const calls: Array<{ file: string; args: string[] | string; options: unknown }> = []
  let nextPid = 10_000
  const spawn: NonNullable<ProcessManagerDeps['spawn']> = (file, args, options) => {
    const dataListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
    const terminal: FakePty = {
      pid: nextPid++,
      cols: options.cols ?? 0,
      rows: options.rows ?? 0,
      process: file,
      handleFlowControl: false,
      writes: [],
      resizes: [],
      kills: [],
      onData(listener) {
        dataListeners.add(listener)
        return { dispose: () => dataListeners.delete(listener) }
      },
      onExit(listener) {
        exitListeners.add(listener)
        return { dispose: () => exitListeners.delete(listener) }
      },
      write(data) {
        this.writes.push(data)
      },
      resize(cols, rows) {
        this.resizes.push([cols, rows])
      },
      kill(signal) {
        this.kills.push(signal)
      },
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      emitData(data) {
        for (const listener of [...dataListeners]) listener(data)
      },
      emitExit(exitCode, signal) {
        const event = signal === undefined ? { exitCode } : { exitCode, signal }
        for (const listener of [...exitListeners]) listener(event)
      },
    }
    terminals.push(terminal)
    calls.push({ file, args: typeof args === 'string' ? args : [...args], options })
    return terminal
  }
  return { spawn, terminals, calls }
}

const runtime: WorkspaceRuntime = {
  ref: { kind: 'wsl', distro: 'Ubuntu' },
  hostNative: false,
  resolveCommand: (command, args = [], cwd) => ({
    executable: 'wsl.exe',
    args: ['-d', 'Ubuntu', ...(cwd === undefined ? [] : ['--cd', cwd]), command, ...args],
  }),
  resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: ['-l'] } }),
  resolveCwd: (path) => path,
  resolveHostPath: (path) => ({ ok: true, data: path }),
  resolveDataRoot: () => '/home/test/.teskra',
  resolveAgentProfilesRoot: () => '/home/test/.teskra/agent-profiles',
  resolveAgentProfileHome: (agentId, slug) => ({
    ok: true,
    data: `/home/test/.teskra/agent-profiles/${agentId}/${slug}`,
  }),

  validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: false } }),
}

const windowsRuntime: WorkspaceRuntime = {
  ref: { kind: 'windows' },
  hostNative: true,
  resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
  resolveTerminal: () => ({ ok: true, data: { command: 'cmd.exe', args: [] } }),
  resolveCwd: (path) => path,
  resolveHostPath: (path) => ({ ok: true, data: path }),
  resolveDataRoot: () => 'C:\\Users\\test',
  resolveAgentProfilesRoot: () => 'C:\\Users\\test/agent-profiles',
  resolveAgentProfileHome: (agentId, slug) => ({
    ok: true,
    data: `C:\\Users\\test/agent-profiles/${agentId}/${slug}`,
  }),

  validate: () => ({ ok: true, data: { kind: 'windows', hostNative: true } }),
}

function request(id: string): ProcessStartRequest {
  return {
    id,
    command: 'bash',
    args: ['-l'],
    cwd: '/repo',
    runtime,
    workspaceId: 'ws1',
  }
}

describe('ProcessManager (TASK-014)', () => {
  it('simultaneously manages three uniquely identified PTYs', () => {
    const backend = fakePtyBackend()
    const events = createEventBus<WorkbenchEvents>()
    const started: WorkbenchEvents['process.started'][] = []
    events.subscribe('process.started', (event) => started.push(event))
    const manager = createProcessManager({ events, spawn: backend.spawn, hostPlatform: 'linux' })

    expect(manager.start(request('p1')).ok).toBe(true)
    expect(manager.start(request('p2')).ok).toBe(true)
    expect(manager.start(request('p3')).ok).toBe(true)

    expect(manager.list().map((entry) => entry.id)).toEqual(['p1', 'p2', 'p3'])
    expect(new Set(manager.list().map((entry) => entry.pid)).size).toBe(3)
    expect(started.map((event) => event.processId)).toEqual(['p1', 'p2', 'p3'])
    expect(backend.calls[0]).toMatchObject({
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '/repo', 'bash', '-l'],
    })
  })

  it('launches a Windows .cmd shim through cmd.exe with a pre-quoted command line', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'win32',
    })

    const started = manager.start({
      id: 'shim-1',
      command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['exec', 'fix the bug'],
      cwd: 'C:\\repo',
      runtime: windowsRuntime,
    })

    expect(started.ok).toBe(true)
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]!.file.toLowerCase()).toMatch(/cmd\.exe$/)
    // node-pty receives ONE pre-quoted string (its isCommandLine branch).
    expect(backend.calls[0]!.args).toBe(
      '/d /s /c call "C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd" exec "fix the bug"',
    )
  })

  it('unwraps a .cmd shim into a direct node launch for multi-line args', () => {
    // Regression: cmd ends the batch command at the first line break, so a
    // multi-line prompt through codex.cmd arrived truncated to its first
    // line. The shim's real target (node + entry .js) is spawned directly.
    const NPM_SHIM = [
      '@ECHO off',
      'SET dp0=%~dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      '',
    ].join('\r\n')
    const ENTRY = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    const NODE = 'C:\\Nodejs\\node.exe'
    vi.stubEnv('PATH', 'C:\\Nodejs')
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'win32',
      shimIO: { read: () => NPM_SHIM, exists: (path) => path === ENTRY || path === NODE },
    })

    const started = manager.start({
      id: 'shim-multiline',
      command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['exec', '# Implement the Task\n\n用c++开发一个数学计算器'],
      cwd: 'C:\\repo',
      runtime: windowsRuntime,
    })
    vi.unstubAllEnvs()

    expect(started.ok).toBe(true)
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]!.file).toBe(NODE)
    expect(backend.calls[0]!.args).toEqual([
      ENTRY,
      'exec',
      '# Implement the Task\n\n用c++开发一个数学计算器',
    ])
  })

  it('falls back to the cmd.exe line when a shim needing direct launch cannot be unwrapped', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'win32',
      shimIO: { read: () => undefined, exists: () => false },
    })

    const started = manager.start({
      id: 'shim-fallback',
      command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['exec', 'line1\nline2'],
      cwd: 'C:\\repo',
      runtime: windowsRuntime,
    })

    expect(started.ok).toBe(true)
    expect(backend.calls[0]!.file.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(typeof backend.calls[0]!.args).toBe('string')
  })

  it('does not wrap non-shim executables through cmd.exe on Windows', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'win32',
    })

    const started = manager.start({
      id: 'exe-1',
      command: 'C:\\Tools\\codex.exe',
      args: ['--version'],
      cwd: 'C:\\repo',
      runtime: windowsRuntime,
    })

    expect(started.ok).toBe(true)
    expect(backend.calls[0]).toMatchObject({
      file: 'C:\\Tools\\codex.exe',
      args: ['--version'],
    })
  })

  it('routes output through EventBus and removes an exited process exactly once', async () => {
    const backend = fakePtyBackend()
    const events = createEventBus<WorkbenchEvents>()
    const output = vi.fn()
    const exited = vi.fn()
    events.subscribe('process.output', output)
    events.subscribe('process.exited', exited)
    const manager = createProcessManager({ events, spawn: backend.spawn, hostPlatform: 'linux' })
    manager.start(request('p1'))
    const waiting = manager.waitForExit('p1')

    backend.terminals[0]?.emitData('hello')
    backend.terminals[0]?.emitExit(7, 15)
    backend.terminals[0]?.emitExit(7, 15)

    expect(output).toHaveBeenCalledWith({ processId: 'p1', data: 'hello' })
    expect(exited).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledWith({ processId: 'p1', exitCode: 7, signal: 15 })
    expect(manager.get('p1')).toBeUndefined()
    expect(await waiting).toEqual({
      ok: true,
      data: { processId: 'p1', exitCode: 7, signal: 15 },
    })
  })

  it('carries AgentRun identity on process output and exit events', () => {
    const backend = fakePtyBackend()
    const events = createEventBus<WorkbenchEvents>()
    const output = vi.fn()
    const exited = vi.fn()
    events.subscribe('process.output', output)
    events.subscribe('process.exited', exited)
    const manager = createProcessManager({ events, spawn: backend.spawn, hostPlatform: 'linux' })
    manager.start({ ...request('agent-process'), agentRunId: 'run-1' })

    backend.terminals[0]?.emitData('chunk')
    backend.terminals[0]?.emitExit(0)

    expect(output).toHaveBeenCalledWith({
      processId: 'agent-process',
      agentRunId: 'run-1',
      data: 'chunk',
    })
    expect(exited).toHaveBeenCalledWith({
      processId: 'agent-process',
      agentRunId: 'run-1',
      exitCode: 0,
    })
  })

  it('centralizes write, resize, interrupt, terminate, and force kill', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    manager.start(request('p1'))
    const terminal = backend.terminals[0]
    if (terminal === undefined) throw new Error('expected fake PTY')

    expect(manager.write('p1', 'input').ok).toBe(true)
    expect(manager.resize('p1', 132, 44).ok).toBe(true)
    expect(manager.interrupt('p1').ok).toBe(true)
    expect(manager.terminate('p1').ok).toBe(true)
    expect(manager.kill('p1').ok).toBe(true)
    expect(terminal.writes).toEqual(['input', '\u0003'])
    expect(terminal.resizes).toEqual([[132, 44]])
    expect(terminal.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('rejects duplicate ids, invalid dimensions, unavailable runtimes, and unknown ids', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    manager.start(request('p1'))

    const duplicate = manager.start(request('p1'))
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.error.code).toBe('VALIDATION_FAILED')
    const badSize = manager.resize('p1', 0, 20)
    expect(badSize.ok).toBe(false)
    const missing = manager.write('missing', 'x')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('PROCESS_NOT_FOUND')

    const unavailable: WorkspaceRuntime = {
      ...runtime,
      validate: () => ({
        ok: false,
        error: { code: 'WSL_NOT_AVAILABLE', message: 'missing', retryable: false },
      }),
    }
    const invalidRuntime = manager.start({ ...request('p2'), runtime: unavailable })
    expect(invalidRuntime.ok).toBe(false)
    expect(backend.terminals).toHaveLength(1)
  })

  it('uses signal-less kill calls on Windows where node-pty rejects POSIX signals', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'win32',
    })
    manager.start(request('p1'))
    manager.terminate('p1')
    manager.kill('p1')
    expect(backend.terminals[0]?.kills).toEqual([undefined, undefined])
  })

  it('stops at Ctrl+C when a cooperative process exits', async () => {
    const backend = fakePtyBackend()
    const events = createEventBus<WorkbenchEvents>()
    const exited = vi.fn()
    events.subscribe('process.exited', exited)
    const manager = createProcessManager({ events, spawn: backend.spawn, hostPlatform: 'linux' })
    manager.start(request('p1'))
    const terminal = backend.terminals[0]
    if (terminal === undefined) throw new Error('expected fake PTY')
    terminal.write = function (data) {
      this.writes.push(data)
      if (data === '\u0003') this.emitExit(130, 2)
    }

    const result = await manager.stop('p1', FAST_KILL_POLICY)
    expect(result).toEqual({
      ok: true,
      data: { stage: 'interrupt', exit: { processId: 'p1', exitCode: 130, signal: 2 } },
    })
    expect(terminal.kills).toEqual([])
    expect(exited).toHaveBeenCalledTimes(1)
  })

  it('escalates to graceful terminate when Ctrl+C is ignored', async () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    manager.start(request('p1'))
    const terminal = backend.terminals[0]
    if (terminal === undefined) throw new Error('expected fake PTY')
    terminal.kill = function (signal) {
      this.kills.push(signal)
      if (signal === 'SIGTERM') this.emitExit(143, 15)
    }

    const result = await manager.stop('p1', FAST_KILL_POLICY)
    expect(result.ok && result.data.stage).toBe('terminate')
    expect(terminal.writes).toEqual(['\u0003'])
    expect(terminal.kills).toEqual(['SIGTERM'])
  })

  it('escalates to force kill and emits exit only once', async () => {
    const backend = fakePtyBackend()
    const events = createEventBus<WorkbenchEvents>()
    const exited = vi.fn()
    events.subscribe('process.exited', exited)
    const manager = createProcessManager({ events, spawn: backend.spawn, hostPlatform: 'linux' })
    manager.start(request('p1'))
    const terminal = backend.terminals[0]
    if (terminal === undefined) throw new Error('expected fake PTY')
    terminal.kill = function (signal) {
      this.kills.push(signal)
      if (signal === 'SIGKILL') {
        this.emitExit(137, 9)
        this.emitExit(137, 9)
      }
    }

    const result = await manager.stop('p1', FAST_KILL_POLICY)
    expect(result.ok && result.data.stage).toBe('kill')
    expect(terminal.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(exited).toHaveBeenCalledTimes(1)
  })

  it('times out after force kill when a stuck backend never reports exit', async () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    manager.start(request('p1'))

    const result = await manager.stop('p1', FAST_KILL_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('COMMAND_TIMEOUT')
    expect(backend.terminals[0]?.writes).toEqual(['\u0003'])
    expect(backend.terminals[0]?.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('rejects invalid kill policies before signalling the process', async () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    manager.start(request('p1'))

    const result = await manager.stop('p1', { ...FAST_KILL_POLICY, interruptTimeoutMs: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(backend.terminals[0]?.writes).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'interrupts a real cooperative PTY process with Ctrl+C',
    async () => {
      const nativeRuntime: WorkspaceRuntime = {
        ...runtime,
        ref: { kind: 'wsl' },
        hostNative: true,
        resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
      }
      const manager = createProcessManager({ events: createEventBus(), hostPlatform: 'linux' })
      const started = manager.start({
        id: 'real-pty',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        runtime: nativeRuntime,
      })
      expect(started.ok).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 50))

      const stopped = await manager.stop('real-pty', {
        interruptTimeoutMs: 1_000,
        terminateTimeoutMs: 500,
        forceKillTimeoutMs: 500,
      })
      expect(stopped.ok).toBe(true)
      if (stopped.ok) expect(stopped.data.stage).toBe('interrupt')
    },
  )

  it('declares every env key in WSLENV for a WSL-boundary runtime (P0-1)', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'win32',
    })
    // The ambient environment may carry its own WSLENV (e.g. under WSL2);
    // pin it so the merge is asserted deterministically.
    const inherited = process.env['WSLENV']
    process.env['WSLENV'] = 'USER/p'
    try {
      // The shared `runtime` fixture is a WSL-on-Windows runtime (hostNative:
      // false), so env values must be declared in WSLENV to cross into WSL.
      manager.start({
        ...request('p1'),
        env: {
          TESKRA_HANDOFF_PATH: '/mnt/c/u/.teskra/runs/r1/handoff.json',
          TESKRA_RUN_ID: 'r1',
        },
      })

      const options = backend.calls[0]?.options as { env: Record<string, string> }
      expect(options.env['TESKRA_HANDOFF_PATH']).toBe('/mnt/c/u/.teskra/runs/r1/handoff.json')
      expect(options.env['WSLENV']).toBe('USER/p:TESKRA_HANDOFF_PATH:TESKRA_RUN_ID')
    } finally {
      if (inherited === undefined) {
        delete process.env['WSLENV']
      } else {
        process.env['WSLENV'] = inherited
      }
    }
  })

  it('leaves env untouched for a host-native runtime (no WSLENV)', () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    const inherited = process.env['WSLENV']
    delete process.env['WSLENV']
    try {
      const nativeRuntime: WorkspaceRuntime = { ...runtime, hostNative: true }
      manager.start({ ...request('p1'), runtime: nativeRuntime, env: { FOO: 'bar' } })

      const options = backend.calls[0]?.options as { env: Record<string, string> }
      expect(options.env['FOO']).toBe('bar')
      expect(options.env['WSLENV']).toBeUndefined()
    } finally {
      if (inherited !== undefined) process.env['WSLENV'] = inherited
    }
  })

  it('disposeAll stops every active process through the kill ladder (P0-2)', async () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    manager.start(request('p1'))
    manager.start(request('p2'))
    const [cooperative, stubborn] = backend.terminals
    if (cooperative === undefined || stubborn === undefined) throw new Error('expected fake PTYs')
    cooperative.write = function (data) {
      this.writes.push(data)
      if (data === '') this.emitExit(130, 2)
    }
    stubborn.kill = function (signal) {
      this.kills.push(signal)
      if (signal === 'SIGKILL') this.emitExit(137, 9)
    }

    const result = await manager.disposeAll(FAST_KILL_POLICY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.failed).toEqual([])
    expect(result.data.stopped.map((entry) => entry.exit.processId).sort()).toEqual(['p1', 'p2'])
    expect(result.data.stopped.map((entry) => entry.stage).sort()).toEqual(['interrupt', 'kill'])
    expect(manager.list()).toEqual([])

    // Disposal is idempotent: a second call has nothing left to stop.
    const again = await manager.disposeAll(FAST_KILL_POLICY)
    expect(again).toEqual({ ok: true, data: { stopped: [], failed: [] } })
  })

  it('disposeAll reports stuck processes without blocking the remaining stops (P0-2)', async () => {
    const backend = fakePtyBackend()
    const manager = createProcessManager({
      events: createEventBus(),
      spawn: backend.spawn,
      hostPlatform: 'linux',
    })
    manager.start(request('p1'))
    manager.start(request('p2'))
    // p1's backend never reports exit: its stop times out after force kill.
    const cooperative = backend.terminals[1]
    if (cooperative === undefined) throw new Error('expected fake PTYs')
    cooperative.write = function (data) {
      this.writes.push(data)
      if (data === '') this.emitExit(130, 2)
    }

    const result = await manager.disposeAll(FAST_KILL_POLICY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.stopped.map((entry) => entry.exit.processId)).toEqual(['p2'])
    expect(result.data.failed).toHaveLength(1)
    expect(result.data.failed[0]).toMatchObject({ id: 'p1', error: { code: 'COMMAND_TIMEOUT' } })
  })
})
