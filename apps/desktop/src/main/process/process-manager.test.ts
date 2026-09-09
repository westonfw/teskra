import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { createEventBus } from '../events/event-bus'
import type { WorkspaceRuntime } from '../workspace/runtime'
import {
  createProcessManager,
  type ProcessManagerDeps,
  type ProcessStartRequest,
} from './process-manager'

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
  calls: Array<{ file: string; args: string[]; options: unknown }>
} {
  const terminals: FakePty[] = []
  const calls: Array<{ file: string; args: string[]; options: unknown }> = []
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
    calls.push({ file, args: [...args], options })
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
  resolveCwd: (path) => path,
  resolveDataRoot: () => '/home/test/.teskra',
  validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: false } }),
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
})
