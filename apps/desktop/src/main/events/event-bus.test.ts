import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { createEventBus, type EventBus } from './event-bus'

describe('EventBus (TASK-016)', () => {
  it('delivers typed payloads to every subscriber in registration order', () => {
    const bus = createEventBus()
    const calls: string[] = []
    bus.subscribe('process.output', (event) => calls.push(`first:${event.data}`))
    bus.subscribe('process.output', (event) => calls.push(`second:${event.processId}`))

    bus.emit('process.output', { processId: 'p1', data: 'hello' })

    expect(calls).toEqual(['first:hello', 'second:p1'])
  })

  it('supports idempotent unsubscribe and clear', () => {
    const bus = createEventBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe('workspace.opened', listener)
    unsubscribe()
    unsubscribe()
    bus.emit('workspace.opened', { workspaceId: 'ws1' })
    expect(listener).not.toHaveBeenCalled()

    bus.subscribe('workspace.opened', listener)
    bus.clear()
    bus.emit('workspace.opened', { workspaceId: 'ws2' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('uses a snapshot for re-entrant unsubscription', () => {
    const bus = createEventBus()
    const calls: string[] = []
    let unsubscribeSecond = (): void => undefined
    bus.subscribe('task.updated', () => {
      calls.push('first')
      unsubscribeSecond()
    })
    unsubscribeSecond = bus.subscribe('task.updated', () => calls.push('second'))

    bus.emit('task.updated', { taskId: 't1' })
    bus.emit('task.updated', { taskId: 't1' })
    expect(calls).toEqual(['first', 'second', 'first'])
  })

  it('isolates a throwing subscriber so later subscribers still receive the event', () => {
    const bus = createEventBus()
    const later = vi.fn()
    bus.subscribe('terminal.closed', () => {
      throw new Error('broken listener')
    })
    bus.subscribe('terminal.closed', later)

    expect(() => bus.emit('terminal.closed', { terminalId: 'term1' })).not.toThrow()
    expect(later).toHaveBeenCalledWith({ terminalId: 'term1' })
  })

  it('retains compile-time event-name/payload coupling', () => {
    expectTypeOf<EventBus<WorkbenchEvents>['emit']>().toBeFunction()
    const bus = createEventBus()
    // @ts-expect-error process.output requires processId and data
    bus.emit('process.output', { data: 'missing id' })
    // @ts-expect-error unknown event names are rejected
    bus.emit('not.an.event', {})
  })
})
