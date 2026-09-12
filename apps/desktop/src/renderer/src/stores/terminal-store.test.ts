import type { TerminalSession, WorkbenchEvents } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  createTerminalStore,
  historyText,
  TERMINAL_HISTORY_MAX_CHARS,
  type TerminalStoreBridge,
} from './terminal-store'

const FIRST: TerminalSession = {
  id: 'terminal-1',
  workspaceId: 'workspace-1',
  shell: 'bash',
  processId: 'process-1',
  title: 'Bash',
  createdAt: '2026-09-10T00:00:00.000Z',
}
const SECOND: TerminalSession = {
  ...FIRST,
  id: 'terminal-2',
  processId: 'process-2',
  title: 'Logs',
}

function harness() {
  const handlers = new Map<string, Set<(payload: never) => void>>()
  const stops: ReturnType<typeof vi.fn>[] = []
  const bridge: TerminalStoreBridge = {
    terminal: {
      create: vi.fn(async () => ({ ok: true as const, data: SECOND })),
      close: vi.fn(async () => ({ ok: true as const, data: undefined })),
      get: vi.fn(async ({ terminalId }) => ({
        ok: true as const,
        data: terminalId === FIRST.id ? FIRST : null,
      })),
      list: vi.fn(async () => ({ ok: true as const, data: [FIRST] })),
    },
    events: {
      subscribe(name, handler) {
        let current = handlers.get(name)
        if (current === undefined) {
          current = new Set()
          handlers.set(name, current)
        }
        current.add(handler)
        const stop = vi.fn(() => current?.delete(handler as (payload: never) => void))
        stops.push(stop)
        return stop
      },
    },
  }
  return {
    bridge,
    stops,
    emit<Name extends keyof WorkbenchEvents>(name: Name, payload: WorkbenchEvents[Name]) {
      for (const handler of handlers.get(name) ?? []) handler(payload as never)
    },
  }
}

describe('terminal keep-alive store', () => {
  it('shares one event subscription set and buffers output while views are hidden', () => {
    const test = harness()
    const store = createTerminalStore(() => test.bridge)
    const stopFirst = store.getState().startSynchronization()
    const stopSecond = store.getState().startSynchronization()

    test.emit('terminal.output', { terminalId: FIRST.id, data: '\x1b[32mlong job\x1b[0m' })
    expect(historyText(store.getState().history[FIRST.id])).toContain('long job')
    expect(test.stops).toHaveLength(3)

    stopFirst()
    expect(test.stops.every((stop) => stop.mock.calls.length === 0)).toBe(true)
    stopSecond()
    stopSecond()
    expect(test.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true)
    expect(test.bridge.terminal.close).not.toHaveBeenCalled()
  })

  it('keeps sessions and history when switching the active tab', async () => {
    const test = harness()
    const store = createTerminalStore(() => test.bridge)
    const stop = store.getState().startSynchronization()
    await store.getState().synchronize('workspace-1')
    await store.getState().createTerminal({ workspaceId: 'workspace-1', shell: 'bash' })
    test.emit('terminal.output', { terminalId: FIRST.id, data: 'still running' })

    store.getState().activate(FIRST.id)
    store.getState().activate(SECOND.id)
    expect(store.getState().tabs.map((tab) => tab.session.id)).toEqual([FIRST.id, SECOND.id])
    expect(historyText(store.getState().history[FIRST.id])).toBe('still running')
    expect(test.bridge.terminal.close).not.toHaveBeenCalled()
    stop()
  })

  it('retains exited output until the user dismisses the tab', async () => {
    const test = harness()
    const store = createTerminalStore(() => test.bridge)
    const stop = store.getState().startSynchronization()
    await store.getState().synchronize()
    test.emit('terminal.closed', { terminalId: FIRST.id })

    expect(store.getState().tabs[0]?.status).toBe('closed')
    expect(historyText(store.getState().history[FIRST.id])).toContain('[terminal exited]')
    await store.getState().closeTerminal(FIRST.id)
    expect(store.getState().tabs).toEqual([])
    expect(test.bridge.terminal.close).not.toHaveBeenCalled()
    stop()
  })

  it('stores history as chunks and joins them in arrival order (P1-2)', () => {
    const test = harness()
    const store = createTerminalStore(() => test.bridge)
    const stop = store.getState().startSynchronization()

    test.emit('terminal.output', { terminalId: FIRST.id, data: 'abc' })
    test.emit('terminal.output', { terminalId: FIRST.id, data: 'def' })
    test.emit('terminal.output', { terminalId: FIRST.id, data: 'ghi' })

    const history = store.getState().history[FIRST.id]
    expect(history?.chunks).toEqual(['abc', 'def', 'ghi'])
    expect(history?.length).toBe(9)
    expect(historyText(history)).toBe('abcdefghi')
    stop()
  })

  it('drops the oldest chunks once history exceeds the cap, keeping the tail intact (P1-2)', () => {
    const test = harness()
    const store = createTerminalStore(() => test.bridge)
    const stop = store.getState().startSynchronization()
    const chunkSize = Math.floor(TERMINAL_HISTORY_MAX_CHARS / 2) + 1

    test.emit('terminal.output', { terminalId: FIRST.id, data: 'A'.repeat(chunkSize) })
    test.emit('terminal.output', { terminalId: FIRST.id, data: 'B'.repeat(chunkSize) })

    const history = store.getState().history[FIRST.id]
    // 2 chunks × (cap/2 + 1) > cap, so the oldest chunk is dropped whole.
    expect(history?.chunks).toHaveLength(1)
    expect(history?.length).toBe(chunkSize)
    const text = historyText(history)
    expect(text).toHaveLength(chunkSize)
    expect(text?.startsWith('B')).toBe(true)
    stop()
  })

  it('retains a single chunk even when it alone exceeds the cap (P1-2)', () => {
    const test = harness()
    const store = createTerminalStore(() => test.bridge)
    const stop = store.getState().startSynchronization()

    test.emit('terminal.output', {
      terminalId: FIRST.id,
      data: 'x'.repeat(TERMINAL_HISTORY_MAX_CHARS + 100),
    })

    const history = store.getState().history[FIRST.id]
    expect(history?.chunks).toHaveLength(1)
    expect(historyText(history)).toHaveLength(TERMINAL_HISTORY_MAX_CHARS + 100)
    stop()
  })
})
