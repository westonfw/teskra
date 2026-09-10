import type { Artifact, ArtifactContent, PublicAppError } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createArtifactStore, type ArtifactStoreBridge } from './artifact-store'

const NOW = '2026-09-10T00:00:00.000Z'

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    type: 'plan',
    name: 'plan.md',
    createdAt: NOW,
    ...overrides,
  }
}

const rejected: PublicAppError = {
  code: 'VALIDATION_FAILED',
  message: 'The artifact file path escapes the Run artifact directory.',
  retryable: false,
}

function setup(initial: Artifact[] = []) {
  const artifacts = [...initial]
  const scanned: string[] = []
  const handlers = new Set<(payload: { taskId: string }) => void>()

  const bridge: ArtifactStoreBridge = {
    artifact: {
      list: vi.fn(async (request) => {
        if (request.taskId === 'broken') return { ok: false as const, error: rejected }
        return {
          ok: true as const,
          data: artifacts.filter(({ taskId }) => taskId === request.taskId),
        }
      }),
      get: vi.fn(async ({ artifactId }) => {
        const artifact = artifacts.find(({ id }) => id === artifactId)
        if (artifact === undefined) return { ok: true as const, data: null }
        if (artifact.id === 'evil') return { ok: false as const, error: rejected }
        const data: ArtifactContent = {
          artifact,
          content: artifact.content ?? '',
          truncated: false,
        }
        return { ok: true as const, data }
      }),
      scanRun: vi.fn(async ({ runId }) => {
        if (runId === 'broken') return { ok: false as const, error: rejected }
        scanned.push(runId)
        return { ok: true as const, data: [] }
      }),
    },
    events: {
      subscribe: vi.fn((_name, handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      }),
    },
  }

  return { bridge, handlers, scanned, store: createArtifactStore(() => bridge) }
}

describe('artifact store (TASK-050)', () => {
  it('loads the artifacts of a Task and refreshes on task.updated', async () => {
    const { bridge, handlers, store } = setup([
      makeArtifact(),
      makeArtifact({ id: 'artifact-2', taskId: 'task-2', name: 'other' }),
    ])
    const stop = store.getState().startSynchronization('task-1')
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))

    expect(store.getState().artifacts.map(({ id }) => id)).toEqual(['artifact-1'])

    for (const handler of handlers) handler({ taskId: 'task-1' })
    await vi.waitFor(() => expect(bridge.artifact.list).toHaveBeenCalledTimes(2))
    stop()
  })

  it('surfaces list failures as structured errors', async () => {
    const { store } = setup()
    await store.getState().synchronize('broken')
    expect(store.getState().artifacts).toEqual([])
    expect(store.getState().error?.code).toBe('VALIDATION_FAILED')
    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()
  })

  it('resolves artifact content and reports failures', async () => {
    const { store } = setup([makeArtifact({ content: '# Plan' }), makeArtifact({ id: 'evil' })])

    const content = await store.getState().loadContent('artifact-1')
    expect(content).toMatchObject({ content: '# Plan', truncated: false })

    expect(await store.getState().loadContent('evil')).toBeUndefined()
    expect(store.getState().error?.code).toBe('VALIDATION_FAILED')

    expect(await store.getState().loadContent('missing')).toBeUndefined()
  })

  it('scans run artifact directories and re-synchronizes', async () => {
    const { bridge, scanned, store } = setup([makeArtifact()])
    store.getState().startSynchronization('task-1')
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))

    const succeeded = await store.getState().scanRuns(['run-1', 'run-2'])
    expect(succeeded).toBe(true)
    expect(scanned).toEqual(['run-1', 'run-2'])
    expect(bridge.artifact.list).toHaveBeenCalledTimes(2)

    const failed = await store.getState().scanRuns(['broken'])
    expect(failed).toBe(false)
    expect(store.getState().error?.code).toBe('VALIDATION_FAILED')
  })
})
