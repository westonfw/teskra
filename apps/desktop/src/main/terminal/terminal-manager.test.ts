import { describe, expect, it, vi, afterEach } from 'vitest'

import type { IpcResult, WorkbenchEvents, Workspace } from '@teskra/contracts'

import { AGENT_OUTPUT_BATCH_MS } from '../agents/agent-output-batcher'
import { createEventBus, type EventBus } from '../events/event-bus'
import type {
  ManagedProcess,
  ProcessStartRequest,
  ProcessStopResult,
} from '../process/process-manager'
import { createWorkspaceRuntime, type ShellExecutionContext } from '../workspace/runtime'
import { createTerminalManager, type TerminalManagerDeps } from './terminal-manager'

const AT = '2026-09-10T00:00:00.000Z'

const workspaces: Workspace[] = [
  {
    id: 'windows-ws',
    name: 'Windows Repo',
    runtime: { kind: 'windows' },
    path: 'C:\\repo',
    createdAt: AT,
    updatedAt: AT,
  },
  {
    id: 'wsl-ws',
    name: 'WSL Repo',
    runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
    path: '/home/dev/repo',
    createdAt: AT,
    updatedAt: AT,
  },
]

function workspaceStore(): TerminalManagerDeps['workspaces'] {
  return {
    getById(id) {
      return { ok: true, data: workspaces.find((workspace) => workspace.id === id) ?? null }
    },
  }
}

function fakeProcesses(events: EventBus<WorkbenchEvents>): {
  processes: TerminalManagerDeps['processes']
  starts: ProcessStartRequest[]
  contexts: ShellExecutionContext[]
  writes: Array<[string, string]>
  resizes: Array<[string, number, number]>
  stops: string[]
} {
  const starts: ProcessStartRequest[] = []
  const contexts: ShellExecutionContext[] = []
  const writes: Array<[string, string]> = []
  const resizes: Array<[string, number, number]> = []
  const stops: string[] = []
  return {
    starts,
    contexts,
    writes,
    resizes,
    stops,
    processes: {
      start(request): IpcResult<ManagedProcess> {
        starts.push(request)
        contexts.push(request.runtime.resolveCommand(request.command, request.args, request.cwd))
        return {
          ok: true,
          data: {
            id: request.id,
            pid: 10_000 + starts.length,
            workspaceId: request.workspaceId,
            startedAt: AT,
          },
        }
      },
      write(processId, data) {
        writes.push([processId, data])
        return { ok: true, data: undefined }
      },
      resize(processId, cols, rows) {
        resizes.push([processId, cols, rows])
        return { ok: true, data: undefined }
      },
      async stop(processId): Promise<IpcResult<ProcessStopResult>> {
        stops.push(processId)
        const exit = { processId, exitCode: 0 }
        events.emit('process.exited', exit)
        return { ok: true, data: { stage: 'interrupt', exit } }
      },
    },
  }
}

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `generated-${String(index)}`
}

function managerSetup(idValues = ['term-1', 'proc-1', 'term-2', 'proc-2']) {
  const events = createEventBus<WorkbenchEvents>()
  const processFake = fakeProcesses(events)
  const manager = createTerminalManager({
    events,
    processes: processFake.processes,
    workspaces: workspaceStore(),
    createId: ids(...idValues),
    now: () => AT,
    resolveRuntime: (workspace) =>
      createWorkspaceRuntime(workspace.runtime, {
        hostPlatform: 'win32',
        wsl: {
          available: true,
          version: '2.6.3.0',
          distributions: ['Ubuntu-24.04'],
          defaultDistro: 'Ubuntu-24.04',
        },
      }),
  })
  return { events, processFake, manager }
}

describe('TerminalManager (TASK-017)', () => {
  afterEach(() => vi.useRealTimers())

  it('creates a PowerShell terminal for a Windows workspace', () => {
    const { events, processFake, manager } = managerSetup()
    const created = vi.fn()
    events.subscribe('terminal.created', created)

    const result = manager.create({ workspaceId: 'windows-ws', shell: 'powershell' })
    expect(result).toEqual({
      ok: true,
      data: {
        id: 'term-1',
        workspaceId: 'windows-ws',
        shell: 'powershell',
        processId: 'proc-1',
        title: 'PowerShell',
        createdAt: AT,
      },
    })
    expect(processFake.contexts[0]).toEqual({
      executable: 'powershell.exe',
      args: ['-NoLogo'],
      cwd: 'C:\\repo',
    })
    expect(created).toHaveBeenCalledWith({ terminalId: 'term-1', workspaceId: 'windows-ws' })
  })

  it('creates WSL bash through WslRuntime with distro and --cd', () => {
    const { processFake, manager } = managerSetup()
    const result = manager.create({
      workspaceId: 'wsl-ws',
      shell: 'wsl',
      title: 'Ubuntu shell',
      cols: 140,
      rows: 45,
    })
    expect(result.ok && result.data.title).toBe('Ubuntu shell')
    expect(processFake.contexts[0]).toEqual({
      executable: 'wsl.exe',
      args: ['-d', 'Ubuntu-24.04', '--cd', '/home/dev/repo', '--exec', 'bash', '-l'],
    })
    expect(processFake.starts[0]).toMatchObject({ cols: 140, rows: 45, workspaceId: 'wsl-ws' })
  })

  it('keeps multiple terminals independent when one is closed', async () => {
    const { events, processFake, manager } = managerSetup()
    const closed = vi.fn()
    events.subscribe('terminal.closed', closed)
    const first = manager.create({ workspaceId: 'wsl-ws', shell: 'bash' })
    const second = manager.create({ workspaceId: 'wsl-ws', shell: 'wsl' })
    if (!first.ok || !second.ok) throw new Error('expected terminals')

    const result = await manager.close(first.data.id)
    expect(result.ok).toBe(true)
    expect(processFake.stops).toEqual([first.data.processId])
    expect(manager.get(first.data.id)).toBeUndefined()
    expect(manager.get(second.data.id)).toEqual(second.data)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith({ terminalId: first.data.id })
  })

  it('maps process output and natural exit to terminal events', () => {
    vi.useFakeTimers()
    const { events, manager } = managerSetup()
    const output = vi.fn()
    const closed = vi.fn()
    events.subscribe('terminal.output', output)
    events.subscribe('terminal.closed', closed)
    const created = manager.create({ workspaceId: 'wsl-ws', shell: 'bash' })
    if (!created.ok) throw new Error('expected terminal')

    events.emit('process.output', { processId: created.data.processId, data: '\x1b[32mok' })
    // P1-2: forwarding is batched; nothing is emitted until the batch window closes.
    expect(output).not.toHaveBeenCalled()
    vi.advanceTimersByTime(AGENT_OUTPUT_BATCH_MS)
    expect(output).toHaveBeenCalledWith({ terminalId: created.data.id, data: '\x1b[32mok' })
    events.emit('process.exited', { processId: created.data.processId, exitCode: 0 })
    expect(manager.get(created.data.id)).toBeUndefined()
    expect(closed).toHaveBeenCalledWith({ terminalId: created.data.id })
  })

  it('coalesces a burst of process output into one terminal.output event (P1-2)', () => {
    vi.useFakeTimers()
    const { events, manager } = managerSetup()
    const output = vi.fn()
    events.subscribe('terminal.output', output)
    const created = manager.create({ workspaceId: 'wsl-ws', shell: 'bash' })
    if (!created.ok) throw new Error('expected terminal')

    for (let index = 0; index < 500; index += 1) {
      events.emit('process.output', {
        processId: created.data.processId,
        data: `chunk-${String(index)}|`,
      })
    }
    vi.advanceTimersByTime(AGENT_OUTPUT_BATCH_MS)

    expect(output).toHaveBeenCalledOnce()
    const payload = output.mock.calls[0]?.[0] as { terminalId: string; data: string }
    expect(payload.terminalId).toBe(created.data.id)
    expect(payload.data.startsWith('chunk-0|')).toBe(true)
    expect(payload.data.endsWith('chunk-499|')).toBe(true)
  })

  it('flushes buffered output before terminal.closed so replay order survives exit (P1-2)', () => {
    vi.useFakeTimers()
    const { events, manager } = managerSetup()
    const order: string[] = []
    const output = vi.fn(() => order.push('output'))
    events.subscribe('terminal.output', output)
    events.subscribe('terminal.closed', () => order.push('closed'))
    const created = manager.create({ workspaceId: 'wsl-ws', shell: 'bash' })
    if (!created.ok) throw new Error('expected terminal')

    events.emit('process.output', { processId: created.data.processId, data: 'tail' })
    events.emit('process.exited', { processId: created.data.processId, exitCode: 0 })

    expect(order).toEqual(['output', 'closed'])
    expect(output).toHaveBeenCalledWith({ terminalId: created.data.id, data: 'tail' })
    vi.advanceTimersByTime(AGENT_OUTPUT_BATCH_MS * 2)
    expect(output).toHaveBeenCalledOnce()
  })

  it('forwards input and resize to the owning process only', () => {
    const { processFake, manager } = managerSetup()
    const created = manager.create({ workspaceId: 'windows-ws', shell: 'cmd' })
    if (!created.ok) throw new Error('expected terminal')

    expect(manager.write(created.data.id, 'dir\r').ok).toBe(true)
    expect(manager.resize(created.data.id, 100, 32).ok).toBe(true)
    expect(processFake.writes).toEqual([[created.data.processId, 'dir\r']])
    expect(processFake.resizes).toEqual([[created.data.processId, 100, 32]])
  })

  it('returns structured errors for missing workspaces, incompatible shells, and stale ids', async () => {
    const { manager } = managerSetup()
    const missing = manager.create({ workspaceId: 'missing', shell: 'powershell' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('WORKSPACE_NOT_FOUND')

    const incompatible = manager.create({ workspaceId: 'windows-ws', shell: 'bash' })
    expect(incompatible.ok).toBe(false)
    if (!incompatible.ok) expect(incompatible.error.code).toBe('CAPABILITY_NOT_AVAILABLE')

    const write = manager.write('stale', 'x')
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.error.code).toBe('TERMINAL_NOT_FOUND')
    const close = await manager.close('stale')
    expect(close.ok).toBe(false)
  })

  it('dispose stops every active terminal process and detaches event forwarding (P0-2)', async () => {
    const { events, processFake, manager } = managerSetup()
    const output = vi.fn()
    const closed = vi.fn()
    events.subscribe('terminal.output', output)
    events.subscribe('terminal.closed', closed)
    const first = manager.create({ workspaceId: 'wsl-ws', shell: 'bash' })
    const second = manager.create({ workspaceId: 'wsl-ws', shell: 'wsl' })
    if (!first.ok || !second.ok) throw new Error('expected terminals')

    await manager.dispose()

    // Both terminal processes were stopped; their process.exited events closed
    // the sessions while the subscriptions were still live.
    expect(processFake.stops).toEqual([first.data.processId, second.data.processId])
    expect(manager.get(first.data.id)).toBeUndefined()
    expect(manager.get(second.data.id)).toBeUndefined()
    expect(closed).toHaveBeenCalledTimes(2)

    events.emit('process.output', { processId: first.data.processId, data: 'hidden' })
    expect(output).not.toHaveBeenCalled()
  })
})
