import type { DiffResult, GitStatus, WorkbenchEventName, WorkbenchEvents } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createGitStore, type GitStoreBridge } from './git-store'

function createBridge() {
  const handlers = new Map<WorkbenchEventName, Set<(payload: never) => void>>()
  let status: GitStatus = {
    branch: 'main',
    ahead: 0,
    behind: 0,
    clean: false,
    entries: [{ code: '.M', path: 'src/main.ts' }],
  }
  let changes: DiffResult = {
    files: [
      {
        path: 'src/main.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1,2 @@\n-old\n+new\n+line',
      },
    ],
  }
  const bridge: GitStoreBridge = {
    git: {
      status: vi.fn(async () => ({ ok: true as const, data: status })),
      changes: vi.fn(async () => ({ ok: true as const, data: changes })),
      openFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
    },
    events: {
      subscribe: vi.fn((name, handler) => {
        const listeners = handlers.get(name) ?? new Set()
        listeners.add(handler as (payload: never) => void)
        handlers.set(name, listeners)
        return () => listeners.delete(handler as (payload: never) => void)
      }),
    },
  }

  return {
    bridge,
    update(nextStatus: GitStatus, nextChanges: DiffResult) {
      status = nextStatus
      changes = nextChanges
    },
    emit<Name extends WorkbenchEventName>(name: Name, payload: WorkbenchEvents[Name]) {
      for (const handler of handlers.get(name) ?? []) handler(payload as never)
    },
  }
}

describe('Git store (TASK-037)', () => {
  it('loads changes and refreshes automatically after an Agent finishes', async () => {
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    const stop = store.getState().startSynchronization('workspace-1')

    await vi.waitFor(() => expect(store.getState().changes.files).toHaveLength(1))
    harness.update({ branch: 'main', ahead: 0, behind: 0, clean: true, entries: [] }, { files: [] })
    harness.emit('agent.completed', { runId: 'run-1', exitCode: 0 })

    await vi.waitFor(() => expect(store.getState().changes.files).toEqual([]))
    expect(harness.bridge.git.status).toHaveBeenCalledTimes(2)
    expect(harness.bridge.git.changes).toHaveBeenCalledTimes(2)
    stop()
  })

  it('keeps a selected file across refreshes and opens it through typed IPC', async () => {
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    await store.getState().refresh('workspace-1')

    expect(store.getState().selectedPath).toBe('src/main.ts')
    expect(await store.getState().openFile('workspace-1', 'src/main.ts')).toBe(true)
    expect(harness.bridge.git.openFile).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      path: 'src/main.ts',
    })
  })
})
