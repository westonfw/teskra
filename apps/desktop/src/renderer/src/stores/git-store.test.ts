import type { DiffResult, GitStatus, WorkbenchEventName, WorkbenchEvents } from '@teskra/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createGitStore,
  GIT_FOCUS_THROTTLE_MS,
  GIT_OUTPUT_DEBOUNCE_MS,
  type GitStoreBridge,
} from './git-store'

afterEach(() => vi.useRealTimers())

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
      },
    ],
  }
  const bridge: GitStoreBridge = {
    git: {
      status: vi.fn(async () => ({ ok: true as const, data: status })),
      changes: vi.fn(async () => ({ ok: true as const, data: changes })),
      filePatch: vi.fn(async () => ({
        ok: true as const,
        data: { patch: '@@ -1 +1,2 @@\n-old\n+new\n+line' },
      })),
      init: vi.fn(async () => ({ ok: true as const, data: undefined })),
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

  it('lazy-loads the selected file patch once and drops it on refresh', async () => {
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    await store.getState().refresh('workspace-1')
    expect(harness.bridge.git.filePatch).not.toHaveBeenCalled()

    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(harness.bridge.git.filePatch).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      path: 'src/main.ts',
    })
    expect(store.getState().patches['workspace-1 src/main.ts']).toContain('+new')

    // Cached: a repeated load does not hit IPC again.
    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(1)

    // A refresh invalidates loaded patches (file contents may have changed).
    await store.getState().refresh('workspace-1')
    expect(store.getState().patches).toEqual({})
    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(2)
  })

  it('surfaces a filePatch failure as the store error', async () => {
    const harness = createBridge()
    vi.mocked(harness.bridge.git.filePatch).mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNKNOWN', message: 'git diff failed', retryable: true },
    })
    const store = createGitStore(() => harness.bridge)

    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(store.getState().error?.message).toBe('git diff failed')
    expect(store.getState().patches).toEqual({})
  })

  it('re-issues a patch fetch that a refresh voided mid-flight', async () => {
    const harness = createBridge()
    let releasePatch!: (value: { ok: true; data: { patch: string } }) => void
    vi.mocked(harness.bridge.git.filePatch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePatch = resolve
        }),
    )
    const store = createGitStore(() => harness.bridge)
    await store.getState().refresh('workspace-1')

    const loading = store.getState().loadPatch('workspace-1', 'src/main.ts')
    await vi.waitFor(() => expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(1))
    // The refresh bumps the generation and clears the cache mid-flight…
    await store.getState().refresh('workspace-1')
    releasePatch({ ok: true, data: { patch: '@@ stale' } })
    await loading

    // …so the voided fetch re-issues itself under the new generation.
    await vi.waitFor(() =>
      expect(store.getState().patches['workspace-1 src/main.ts']).toContain('+new'),
    )
    expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(2)
  })

  it('re-issues a voided fetch at most once', async () => {
    const harness = createBridge()
    const releases: Array<(value: { ok: true; data: { patch: string } }) => void> = []
    vi.mocked(harness.bridge.git.filePatch).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve)
        }),
    )
    const store = createGitStore(() => harness.bridge)
    await store.getState().refresh('workspace-1')

    void store.getState().loadPatch('workspace-1', 'src/main.ts')
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    await store.getState().refresh('workspace-1')
    releases[0]?.({ ok: true, data: { patch: '@@ stale-1' } })

    // The one allowed re-issue…
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    await store.getState().refresh('workspace-1')
    releases[1]?.({ ok: true, data: { patch: '@@ stale-2' } })

    // …but no second one: a refresh cadence faster than a fetch cannot become
    // a self-sustaining IPC loop.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(releases).toHaveLength(2)
  })

  it('does not re-issue a voided fetch when the file is no longer selected', async () => {
    const harness = createBridge()
    let releasePatch!: (value: { ok: true; data: { patch: string } }) => void
    vi.mocked(harness.bridge.git.filePatch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePatch = resolve
        }),
    )
    const store = createGitStore(() => harness.bridge)
    await store.getState().refresh('workspace-1')

    void store.getState().loadPatch('workspace-1', 'src/main.ts')
    await vi.waitFor(() => expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(1))
    await store.getState().refresh('workspace-1')
    // The user moved on before the fetch settled.
    store.getState().selectFile(undefined)
    releasePatch({ ok: true, data: { patch: '@@ stale' } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(1)
    expect(store.getState().patches).toEqual({})
  })

  it('does not auto-retry a failed patch until the user re-selects the file', async () => {
    const harness = createBridge()
    vi.mocked(harness.bridge.git.filePatch).mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNKNOWN', message: 'git diff failed', retryable: true },
    })
    const store = createGitStore(() => harness.bridge)
    await store.getState().refresh('workspace-1')
    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(store.getState().error?.message).toBe('git diff failed')

    // The refresh-driven retry stays silent: no new fetch, no error overwrite
    // after clearError().
    store.getState().clearError()
    await store.getState().refresh('workspace-1')
    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(1)
    expect(store.getState().error).toBeUndefined()

    // Explicit reselection is the manual retry.
    store.getState().selectFile('src/main.ts')
    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(2)
    await vi.waitFor(() =>
      expect(store.getState().patches['workspace-1 src/main.ts']).toContain('+new'),
    )
  })

  it('scopes patch failure marks per workspace', async () => {
    const harness = createBridge()
    vi.mocked(harness.bridge.git.filePatch).mockImplementation(async ({ workspaceId }) =>
      workspaceId === 'workspace-1'
        ? {
            ok: false as const,
            error: { code: 'UNKNOWN' as const, message: 'git diff failed', retryable: true },
          }
        : { ok: true as const, data: { patch: '@@ -1 +1 @@\n-old\n+new' } },
    )
    const store = createGitStore(() => harness.bridge)

    await store.getState().loadPatch('workspace-1', 'src/main.ts')
    expect(store.getState().patchFailures['workspace-1 src/main.ts']).toBe(true)

    // The same path in another workspace is not blocked by workspace-1's mark.
    await store.getState().loadPatch('workspace-2', 'src/main.ts')
    expect(harness.bridge.git.filePatch).toHaveBeenCalledTimes(2)
    expect(store.getState().patches['workspace-2 src/main.ts']).toContain('+new')
    expect(store.getState().patchFailures['workspace-2 src/main.ts']).toBeUndefined()
  })

  it('bumps refreshCount on every completed refresh', async () => {
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    expect(store.getState().refreshCount).toBe(0)
    await store.getState().refresh('workspace-1')
    expect(store.getState().refreshCount).toBe(1)
    await store.getState().refresh('workspace-1')
    expect(store.getState().refreshCount).toBe(2)
  })

  it('initializes the repository and refreshes into the normal view', async () => {
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    vi.mocked(harness.bridge.git.status).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'GIT_NOT_A_REPOSITORY',
        message: 'This directory is not a Git repository yet.',
        retryable: false,
      },
    })
    await store.getState().refresh('workspace-1')
    expect(store.getState().error?.code).toBe('GIT_NOT_A_REPOSITORY')

    expect(await store.getState().initRepository('workspace-1')).toBe(true)
    expect(harness.bridge.git.init).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
    // The post-init refresh replaced the error with the loaded status.
    expect(store.getState().error).toBeUndefined()
    expect(store.getState().status?.branch).toBe('main')
    expect(store.getState().initializing).toBe(false)
  })

  it('surfaces a git.init failure as the store error without refreshing', async () => {
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    vi.mocked(harness.bridge.git.init).mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNKNOWN', message: 'Git init failed.', retryable: true },
    })

    expect(await store.getState().initRepository('workspace-1')).toBe(false)
    expect(store.getState().error?.message).toBe('Git init failed.')
    expect(store.getState().initializing).toBe(false)
    expect(harness.bridge.git.status).not.toHaveBeenCalled()
  })

  it('ignores a second git.init while one is already in flight', async () => {
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    let releaseInit!: (value: { ok: true; data: undefined }) => void
    vi.mocked(harness.bridge.git.init).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseInit = resolve
        }),
    )

    const first = store.getState().initRepository('workspace-1')
    expect(store.getState().initializing).toBe(true)
    expect(await store.getState().initRepository('workspace-1')).toBe(false)
    expect(harness.bridge.git.init).toHaveBeenCalledTimes(1)

    releaseInit({ ok: true, data: undefined })
    expect(await first).toBe(true)
  })

  it('debounces high-frequency Agent output into one refresh', async () => {
    vi.useFakeTimers()
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    const stop = store.getState().startSynchronization('workspace-1')
    await vi.runAllTimersAsync()
    vi.mocked(harness.bridge.git.status).mockClear()
    vi.mocked(harness.bridge.git.changes).mockClear()

    for (let index = 0; index < 100; index += 1) {
      harness.emit('agent.output', { runId: 'run-1', data: `chunk-${String(index)}` })
    }
    await vi.advanceTimersByTimeAsync(GIT_OUTPUT_DEBOUNCE_MS - 1)
    expect(harness.bridge.git.status).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(harness.bridge.git.status).toHaveBeenCalledOnce()
    expect(harness.bridge.git.changes).toHaveBeenCalledOnce()
    stop()
  })

  it('throttles focus refreshes while manual refresh remains immediate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))
    const harness = createBridge()
    const store = createGitStore(() => harness.bridge)
    const stop = store.getState().startSynchronization('workspace-1')
    await vi.runAllTimersAsync()
    vi.mocked(harness.bridge.git.status).mockClear()

    store.getState().refreshOnFocus('workspace-1')
    expect(harness.bridge.git.status).not.toHaveBeenCalled()
    vi.setSystemTime(Date.now() + GIT_FOCUS_THROTTLE_MS)
    store.getState().refreshOnFocus('workspace-1')
    await vi.runAllTimersAsync()
    expect(harness.bridge.git.status).toHaveBeenCalledOnce()

    await store.getState().refresh('workspace-1')
    expect(harness.bridge.git.status).toHaveBeenCalledTimes(2)
    stop()
  })
})
