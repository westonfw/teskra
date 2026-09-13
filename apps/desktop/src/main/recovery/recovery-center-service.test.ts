import { describe, expect, it, vi } from 'vitest'

import type { AgentRun, Workspace, Worktree } from '@teskra/contracts'

import type { WorkspaceRuntime } from '../workspace/runtime'
import {
  createRecoveryCenterService,
  type RecoveryCenterServiceDeps,
} from './recovery-center-service'

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Demo',
  runtime: { kind: 'wsl', distro: 'Ubuntu' },
  path: '/repo',
  defaultBranch: 'main',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const runtime: WorkspaceRuntime = {
  ref: workspace.runtime,
  hostNative: true,
  resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
  resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: [] } }),
  resolveCwd: (path) => path,
  resolveHostPath: (path) => ({ ok: true, data: path }),
  resolveDataRoot: () => '/data',
  resolveAgentProfilesRoot: () => '/data/agent-profiles',
  resolveAgentProfileHome: (agentId, slug) => ({
    ok: true,
    data: `/data/agent-profiles/${agentId}/${slug}`,
  }),

  validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: true } }),
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    workspaceId: workspace.id,
    agentType: 'codex',
    status: 'running',
    executionMode: 'attended',
    runDir: '/data/runs/run-1',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    workspaceId: workspace.id,
    branch: 'agent/run-1',
    baseBranch: 'main',
    path: '/data/worktrees/workspace-1/run-1',
    state: 'ready',
    isolation: 'worktree',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function setup(overrides: Partial<RecoveryCenterServiceDeps> = {}) {
  const deps: RecoveryCenterServiceDeps = {
    workspaces: { getById: vi.fn(() => ({ ok: true as const, data: workspace })) },
    worktrees: { listByWorkspace: vi.fn(() => ({ ok: true as const, data: [] })) },
    runs: { listByWorkspace: vi.fn(() => ({ ok: true as const, data: [] })) },
    processes: { list: vi.fn(() => []) },
    git: {
      status: vi.fn(async () => ({
        ok: true as const,
        data: { branch: 'main', ahead: 0, behind: 0, clean: true, entries: [] },
      })),
    },
    resolveRuntime: () => ({ ok: true, data: runtime }),
    resolveStalledThresholdMs: () => ({ ok: true as const, data: 600_000 }),
    pathExists: () => true,
    now: () => new Date('2026-09-10T01:00:00.000Z'),
    ...overrides,
  }
  return { service: createRecoveryCenterService(deps), deps }
}

describe('RecoveryCenterService (TASK-070)', () => {
  it('returns an empty report when no workspace is selected', async () => {
    const { service } = setup()
    const result = await service.list()

    expect(result).toEqual({
      ok: true,
      data: { generatedAt: '2026-09-10T01:00:00.000Z', issues: [] },
    })
  })

  it('returns an empty report when everything is healthy', async () => {
    const { service } = setup({
      runs: {
        listByWorkspace: vi.fn(() => ({
          ok: true as const,
          data: [run({ status: 'completed' })],
        })),
      },
      worktrees: { listByWorkspace: vi.fn(() => ({ ok: true as const, data: [worktree()] })) },
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.workspaceId).toBe(workspace.id)
    expect(result.data.issues).toEqual([])
  })

  it('fails when the workspace no longer exists', async () => {
    const { service } = setup({
      workspaces: { getById: vi.fn(() => ({ ok: true as const, data: null })) },
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('reports interrupted runs with a resume suggestion', async () => {
    const { service } = setup({
      runs: {
        listByWorkspace: vi.fn(() => ({
          ok: true as const,
          data: [run({ id: 'run-interrupted', status: 'interrupted', worktreeId: 'wt-1' })],
        })),
      },
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues).toEqual([
      {
        id: 'interrupted_run:run-interrupted',
        kind: 'interrupted_run',
        summary: 'Run run-interrupted (codex) was interrupted and can be resumed.',
        suggestedAction: 'resume',
        workspaceId: workspace.id,
        runId: 'run-interrupted',
        worktreeId: 'wt-1',
      },
    ])
  })

  it.each(['missing', 'orphaned'] as const)(
    'reports %s worktrees as broken with a repair suggestion',
    async (state) => {
      const { service } = setup({
        worktrees: {
          listByWorkspace: vi.fn(() => ({
            ok: true as const,
            data: [worktree({ id: `wt-${state}`, state })],
          })),
        },
      })
      const result = await service.list({ workspaceId: workspace.id })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.issues).toHaveLength(1)
      expect(result.data.issues[0]).toMatchObject({
        kind: 'broken_worktree',
        suggestedAction: 'repair',
        worktreeId: `wt-${state}`,
      })
    },
  )

  it('reports a path-backed worktree whose directory is gone as broken', async () => {
    const { service } = setup({
      worktrees: {
        listByWorkspace: vi.fn(() => ({
          ok: true as const,
          data: [worktree({ id: 'wt-gone', state: 'ready' })],
        })),
      },
      pathExists: () => false,
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues).toHaveLength(1)
    expect(result.data.issues[0]).toMatchObject({
      kind: 'broken_worktree',
      suggestedAction: 'repair',
      worktreeId: 'wt-gone',
    })
    expect(result.data.issues[0]?.summary).toContain('missing on disk')
  })

  it('reports dirty worktrees with an inspect suggestion', async () => {
    const { service } = setup({
      worktrees: {
        listByWorkspace: vi.fn(() => ({
          ok: true as const,
          data: [worktree({ id: 'wt-dirty', state: 'dirty' })],
        })),
      },
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues).toEqual([
      expect.objectContaining({
        kind: 'dirty_worktree',
        suggestedAction: 'inspect',
        worktreeId: 'wt-dirty',
      }),
    ])
  })

  it('reports worktree conflicts and repository-level conflicts as inspect items', async () => {
    const { service } = setup({
      worktrees: {
        listByWorkspace: vi.fn(() => ({
          ok: true as const,
          data: [worktree({ id: 'wt-conflict', state: 'conflict' })],
        })),
      },
      git: {
        status: vi.fn(async () => ({
          ok: true as const,
          data: {
            branch: 'main',
            ahead: 0,
            behind: 0,
            clean: false,
            entries: [{ path: 'src/app.ts', code: 'UU' }],
          },
        })),
      },
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues).toHaveLength(2)
    expect(result.data.issues[0]).toMatchObject({
      kind: 'conflict',
      suggestedAction: 'inspect',
      worktreeId: 'wt-conflict',
    })
    expect(result.data.issues[1]).toMatchObject({
      kind: 'conflict',
      suggestedAction: 'inspect',
      detail: 'src/app.ts',
    })
    expect(result.data.issues[1]?.worktreeId).toBeUndefined()
  })

  it('reports a running run with no matching process as a stale process', async () => {
    const { service } = setup({
      runs: {
        listByWorkspace: vi.fn(() => ({
          ok: true as const,
          data: [run({ id: 'run-stale', status: 'running', processId: 'proc-1', pid: 4321 })],
        })),
      },
      processes: { list: vi.fn(() => []) },
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues).toEqual([
      expect.objectContaining({
        kind: 'stale_process',
        suggestedAction: 'inspect',
        runId: 'run-stale',
      }),
    ])
    expect(result.data.issues[0]?.summary).toContain('process is gone')
  })

  it('reports a silent active run as a stale process via the watchdog threshold', async () => {
    const silent = run({
      id: 'run-silent',
      status: 'waiting_for_agent',
      processId: 'proc-2',
      pid: 777,
      lastOutputAt: '2026-09-10T00:00:00.000Z',
    })
    const { service } = setup({
      runs: { listByWorkspace: vi.fn(() => ({ ok: true as const, data: [silent] })) },
      processes: {
        list: vi.fn(() => [
          {
            id: 'proc-2',
            pid: 777,
            agentRunId: 'run-silent',
            startedAt: '2026-09-10T00:00:00.000Z',
          },
        ]),
      },
      resolveStalledThresholdMs: () => ({ ok: true as const, data: 600_000 }),
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues).toEqual([
      expect.objectContaining({
        kind: 'stale_process',
        suggestedAction: 'inspect',
        runId: 'run-silent',
      }),
    ])
  })

  it('does not flag a live, recently active run as stale', async () => {
    const active = run({
      id: 'run-live',
      status: 'running',
      processId: 'proc-3',
      pid: 555,
      lastOutputAt: '2026-09-10T00:59:30.000Z',
    })
    const { service } = setup({
      runs: { listByWorkspace: vi.fn(() => ({ ok: true as const, data: [active] })) },
      processes: {
        list: vi.fn(() => [
          {
            id: 'proc-3',
            pid: 555,
            agentRunId: 'run-live',
            startedAt: '2026-09-10T00:30:00.000Z',
          },
        ]),
      },
    })
    const result = await service.list({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.issues).toEqual([])
  })
})
