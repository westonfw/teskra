import type { IpcResult, PendingDecision } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createInboxStore, type InboxStoreBridge } from './inbox-store'

function decision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'decision-1',
    workspaceId: 'workspace-1',
    kind: 'agent_blocker',
    status: 'open',
    severity: 'warning',
    dedupeKey: 'agent_blocker:run-1',
    title: 'The Agent reported a blocker',
    detail: { kind: 'agent_blocker', text: 'need help' },
    options: [{ id: 'acknowledge', label: 'Acknowledge' }],
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function createBridge(initial: readonly PendingDecision[] = []) {
  const handlers = new Map<string, Set<(payload: { decision: PendingDecision }) => void>>()
  const bridge: InboxStoreBridge = {
    decision: {
      list: vi.fn(async () => ok([...initial])),
      resolve: vi.fn(async ({ id }) =>
        ok(decision({ id, status: 'resolved', resolvedAt: '2026-09-10T01:00:00.000Z' })),
      ),
    },
    events: {
      subscribe: vi.fn(
        (name: string, handler: (payload: { decision: PendingDecision }) => void) => {
          let listeners = handlers.get(name)
          if (listeners === undefined) {
            listeners = new Set()
            handlers.set(name, listeners)
          }
          listeners.add(handler)
          return () => listeners?.delete(handler)
        },
      ),
    },
  }
  const emit = (name: 'decision.opened' | 'decision.resolved', value: PendingDecision): void => {
    for (const handler of handlers.get(name) ?? []) handler({ decision: value })
  }
  return { bridge, emit }
}

describe('inbox store (TASK-131)', () => {
  it('loads the open backlog from the bridge', async () => {
    const { bridge } = createBridge([decision({ id: 'a' }), decision({ id: 'b' })])
    const store = createInboxStore(() => bridge)

    await store.getState().load()

    expect(store.getState().status).toBe('ready')
    expect(store.getState().decisions.map(({ id }) => id)).toEqual(['a', 'b'])
    expect(bridge.decision.list).toHaveBeenCalledWith({ status: 'open' })
  })

  it('turns a failed list call into a block-level error', async () => {
    const { bridge } = createBridge()
    bridge.decision.list = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'UNKNOWN' as const, message: 'db gone', retryable: true },
    }))
    const store = createInboxStore(() => bridge)

    await store.getState().load()

    expect(store.getState().status).toBe('error')
    expect(store.getState().error?.message).toBe('db gone')
  })

  it('resolves a decision and drops it from the list', async () => {
    const { bridge } = createBridge([decision({ id: 'a' }), decision({ id: 'b' })])
    const store = createInboxStore(() => bridge)
    await store.getState().load()

    const resolved = await store.getState().resolve('a', 'acknowledge')

    expect(resolved).toBe(true)
    expect(bridge.decision.resolve).toHaveBeenCalledWith({ id: 'a', optionId: 'acknowledge' })
    expect(store.getState().decisions.map(({ id }) => id)).toEqual(['b'])
    expect(store.getState().resolvingId).toBeUndefined()
  })

  it('keeps the decision listed and surfaces the error when resolve fails', async () => {
    const { bridge } = createBridge([decision({ id: 'a' })])
    bridge.decision.resolve = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'VALIDATION_FAILED' as const, message: 'already closed', retryable: false },
    }))
    const store = createInboxStore(() => bridge)
    await store.getState().load()

    const resolved = await store.getState().resolve('a', 'acknowledge')

    expect(resolved).toBe(false)
    expect(store.getState().decisions).toHaveLength(1)
    expect(store.getState().error?.code).toBe('VALIDATION_FAILED')
  })

  it('applies decision.opened / decision.resolved incrementally and stops after unsubscribe', async () => {
    const { bridge, emit } = createBridge([decision({ id: 'a' })])
    const store = createInboxStore(() => bridge)
    const stop = store.getState().startSynchronization()
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'))

    emit('decision.opened', decision({ id: 'b' }))
    expect(store.getState().decisions.map(({ id }) => id)).toEqual(['a', 'b'])

    // Duplicate opens (the list snapshot raced the event) do not double-count.
    emit('decision.opened', decision({ id: 'b' }))
    expect(store.getState().decisions).toHaveLength(2)

    emit('decision.resolved', decision({ id: 'a', status: 'resolved' }))
    expect(store.getState().decisions.map(({ id }) => id)).toEqual(['b'])

    stop()
    emit('decision.opened', decision({ id: 'c' }))
    expect(store.getState().decisions.map(({ id }) => id)).toEqual(['b'])
  })

  it('ignores non-open payloads on decision.opened', async () => {
    const { bridge, emit } = createBridge([])
    const store = createInboxStore(() => bridge)
    const stop = store.getState().startSynchronization()
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'))

    emit('decision.opened', decision({ id: 'expired-1', status: 'expired' }))
    expect(store.getState().decisions).toHaveLength(0)
    stop()
  })
})
