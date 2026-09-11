import type {
  PublicAppError,
  ReviewPanel,
  ReviewPanelResult,
  WorkbenchEvents,
} from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createReviewPanelStore, type ReviewPanelStoreBridge } from './review-panel-store'

const AT = '2026-09-10T00:00:00.000Z'

function makePanel(overrides: Partial<ReviewPanel> & Pick<ReviewPanel, 'id'>): ReviewPanel {
  return { taskId: 'task-1', status: 'completed', createdAt: AT, ...overrides }
}

function makeDetail(panel: ReviewPanel): ReviewPanelResult {
  return { panel, members: [] }
}

function setup(initialPanels: ReviewPanel[] = []) {
  const panels = [...initialPanels]
  const handlers = new Map<string, Set<(payload: { panelId: string; taskId: string }) => void>>()
  const bridge: ReviewPanelStoreBridge = {
    review: {
      listPanels: vi.fn(async () => ({ ok: true as const, data: [...panels] })),
      getPanel: vi.fn(async (request: { panelId: string }) => {
        const panel = panels.find((entry) => entry.id === request.panelId)
        return { ok: true as const, data: panel === undefined ? null : makeDetail(panel) }
      }),
    },
    events: {
      subscribe: (name, handler) => {
        const registered = handlers.get(name) ?? new Set()
        registered.add(handler as (payload: { panelId: string; taskId: string }) => void)
        handlers.set(name, registered)
        return () =>
          registered.delete(handler as (payload: { panelId: string; taskId: string }) => void)
      },
    },
  }
  const emit = (
    name: 'review.panel_updated' | 'task.updated',
    payload: WorkbenchEvents['review.panel_updated'] | WorkbenchEvents['task.updated'],
  ) => {
    for (const handler of handlers.get(name) ?? []) {
      handler(payload as { panelId: string; taskId: string })
    }
  }
  return { bridge, panels, emit, store: createReviewPanelStore(() => bridge) }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createReviewPanelStore', () => {
  it('synchronizes the panels of a task', async () => {
    const { store } = setup([makePanel({ id: 'panel-1' }), makePanel({ id: 'panel-2' })])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    expect(store.getState().panels.map((panel) => panel.id)).toEqual(['panel-1', 'panel-2'])
    expect(store.getState().loading).toBe(false)
    stop()
  })

  it('refreshes when a panel of the task is updated, and ignores other tasks', async () => {
    const { bridge, panels, emit, store } = setup([makePanel({ id: 'panel-1', status: 'running' })])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    expect(bridge.review.listPanels).toHaveBeenCalledTimes(1)

    emit('review.panel_updated', { panelId: 'panel-1', taskId: 'task-2', status: 'completed' })
    await flush()
    expect(bridge.review.listPanels).toHaveBeenCalledTimes(1)

    panels[0] = makePanel({ id: 'panel-1', status: 'completed' })
    emit('review.panel_updated', { panelId: 'panel-1', taskId: 'task-1', status: 'completed' })
    await flush()
    expect(bridge.review.listPanels).toHaveBeenCalledTimes(2)
    expect(store.getState().panels[0]?.status).toBe('completed')
    stop()
  })

  it('loads a panel detail with its aggregate and keeps it fresh on refresh', async () => {
    const { bridge, panels, emit, store } = setup([makePanel({ id: 'panel-1' })])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    await store.getState().selectPanel('panel-1')
    expect(store.getState().detail?.panel.id).toBe('panel-1')
    expect(bridge.review.getPanel).toHaveBeenCalledTimes(1)

    panels[0] = makePanel({
      id: 'panel-1',
      consensus: 'mixed',
      aggregate: {
        panelId: 'panel-1',
        consensus: 'mixed',
        reviewers: [],
        findings: [],
        disagreements: [],
        verdict: 'block',
        reasons: ['1 critical finding reported.'],
      },
    })
    emit('review.panel_updated', { panelId: 'panel-1', taskId: 'task-1', status: 'completed' })
    await flush()
    expect(bridge.review.getPanel).toHaveBeenCalledTimes(2)
    expect(store.getState().detail?.panel.aggregate?.verdict).toBe('block')
    stop()
  })

  it('clears the detail when the selection is cleared', async () => {
    const { store } = setup([makePanel({ id: 'panel-1' })])
    await store.getState().selectPanel('panel-1')
    expect(store.getState().detail).toBeDefined()
    await store.getState().selectPanel(undefined)
    expect(store.getState().selectedId).toBeUndefined()
    expect(store.getState().detail).toBeUndefined()
  })

  it('surfaces a transport error instead of throwing', async () => {
    const bridge: ReviewPanelStoreBridge = {
      review: {
        listPanels: vi.fn(async () => {
          throw new Error('ipc down')
        }),
        getPanel: vi.fn(async () => {
          throw new Error('ipc down')
        }),
      },
      events: { subscribe: () => () => undefined },
    }
    const store = createReviewPanelStore(() => bridge)
    await store.getState().synchronize('task-1')
    expect(store.getState().error?.code).toBe('UNKNOWN')
    await store.getState().selectPanel('panel-1')
    expect(store.getState().error?.code).toBe('UNKNOWN')
    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()
  })

  it('surfaces IPC failures from the service', async () => {
    const failure: PublicAppError = { code: 'UNKNOWN', message: 'db gone', retryable: true }
    const bridge: ReviewPanelStoreBridge = {
      review: {
        listPanels: vi.fn(async () => ({ ok: false as const, error: failure })),
        getPanel: vi.fn(async () => ({ ok: false as const, error: failure })),
      },
      events: { subscribe: () => () => undefined },
    }
    const store = createReviewPanelStore(() => bridge)
    await store.getState().synchronize('task-1')
    expect(store.getState().error?.message).toBe('db gone')
    expect(store.getState().loading).toBe(false)
  })
})
