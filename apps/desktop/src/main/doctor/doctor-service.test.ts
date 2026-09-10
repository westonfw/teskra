import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentDefinition, AgentRun, Workspace } from '@teskra/contracts'

import type { WorkspaceRuntime } from '../workspace/runtime'
import { createDoctorService, type DoctorServiceDeps } from './doctor-service'

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
  validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: true } }),
}

function definition(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    executable: { command: id },
    capabilities: {
      interactive: true,
      headless: true,
      resume: true,
      readOnlyMode: true,
      modelSelection: true,
    },
    prompt: {},
    detection: { versionArgs: ['--version'] },
    defaults: {},
    permissionEnforcement: 'native',
  }
}

const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup(overrides: Partial<DoctorServiceDeps> = {}) {
  const connection = new Database(':memory:')
  databases.push(connection)
  const definitions = [definition('codex', 'Codex'), definition('claude', 'Claude Code')]
  const deps: DoctorServiceDeps = {
    paths: { home: () => '/data' },
    database: { connection, filePath: ':memory:' },
    commands: {
      run: vi.fn(async () => ({
        ok: true as const,
        data: { stdout: 'git version 2.51.0\n', stderr: '', exitCode: 0 },
      })),
    },
    wsl: {
      inspect: vi.fn(async () => ({
        ok: true as const,
        data: {
          version: '2.6.3',
          supportsCd: true,
          effectiveDefault: 'Ubuntu',
          distributions: [{ name: 'Ubuntu', isSystemDefault: true, isConfiguredDefault: false }],
        },
      })),
    },
    registry: { list: () => definitions },
    detector: {
      detect: vi.fn(async ({ agentId, runtime: target }) => ({
        ok: true as const,
        data: {
          agentId,
          runtime: target,
          installed: true,
          executable: agentId,
          version: `${agentId} 1.0.0`,
          overridden: false,
          fromCache: false,
          checkedAt: '2026-09-10T00:00:00.000Z',
        },
      })),
    },
    workspaces: { getById: vi.fn(() => ({ ok: true as const, data: workspace })) },
    worktrees: { listByWorkspace: vi.fn(() => ({ ok: true as const, data: [] })) },
    runs: {
      listActive: vi.fn(() => ({ ok: true as const, data: [] })),
      listByWorkspace: vi.fn(() => ({ ok: true as const, data: [] })),
    },
    processes: { list: vi.fn(() => []) },
    git: {
      branch: vi.fn(async () => ({
        ok: true as const,
        data: { current: 'main', detached: false, branches: ['main'] },
      })),
      status: vi.fn(async () => ({
        ok: true as const,
        data: { branch: 'main', ahead: 0, behind: 0, clean: true, entries: [] },
      })),
    },
    resolveRuntime: () => ({ ok: true, data: runtime }),
    pathExists: () => true,
    canAccessDataDirectory: () => true,
    now: () => '2026-09-10T01:00:00.000Z',
    ...overrides,
  }
  return { service: createDoctorService(deps), deps }
}

describe('DoctorService (TASK-041)', () => {
  it('outputs a healthy system report covering every required subsystem', async () => {
    const { service } = setup()
    const result = await service.run({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      workspaceId: workspace.id,
      generatedAt: '2026-09-10T01:00:00.000Z',
      severity: 'info',
      issueCount: 0,
    })
    expect(result.data.checks.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'git',
        'wsl',
        'distro',
        'agent:codex',
        'agent:claude',
        'data-directory',
        'database',
        'workspace',
        'worktree',
        'run',
        'branch',
        'conflict',
      ]),
    )
    expect(result.data.checks.every(({ severity }) => severity === 'info')).toBe(true)
  })

  it('identifies a stale running Run without changing or killing it', async () => {
    const stale: AgentRun = {
      id: 'run-stale',
      workspaceId: workspace.id,
      agentType: 'codex',
      status: 'running',
      processId: 'agent-run:run-stale',
      pid: 4242,
      executionMode: 'attended',
      runDir: '/runs/run-stale',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }
    const listActive = vi.fn(() => ({ ok: true as const, data: [stale] }))
    const processes = { list: vi.fn(() => []) }
    const { service } = setup({
      runs: {
        listActive,
        listByWorkspace: vi.fn(() => ({ ok: true as const, data: [stale] })),
      },
      processes,
    })

    const result = await service.run({ workspaceId: workspace.id })

    expect(result).toMatchObject({
      ok: true,
      data: {
        severity: 'error',
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'run',
            outcome: 'issue',
            severity: 'error',
            relatedIds: ['run-stale'],
          }),
        ]),
      },
    })
    expect(listActive).toHaveBeenCalledOnce()
    expect(processes.list).toHaveBeenCalledOnce()
  })

  it('assigns severity to Agent, branch, conflict, and worktree problems', async () => {
    const { service } = setup({
      detector: {
        detect: vi.fn(async ({ agentId, runtime: target }) => ({
          ok: true as const,
          data: {
            agentId,
            runtime: target,
            installed: false,
            error: 'not found',
            overridden: false,
            fromCache: false,
            checkedAt: '2026-09-10T00:00:00.000Z',
          },
        })),
      },
      worktrees: {
        listByWorkspace: vi.fn(() => ({
          ok: true as const,
          data: [
            {
              id: 'worktree-broken',
              workspaceId: workspace.id,
              branch: 'task/broken',
              baseBranch: 'main',
              path: '/missing',
              state: 'orphaned' as const,
              isolation: 'worktree' as const,
              createdAt: '2026-09-10T00:00:00.000Z',
              updatedAt: '2026-09-10T00:00:00.000Z',
            },
          ],
        })),
      },
      git: {
        branch: vi.fn(async () => ({
          ok: true as const,
          data: { detached: true, branches: ['main'] },
        })),
        status: vi.fn(async () => ({
          ok: true as const,
          data: {
            ahead: 0,
            behind: 0,
            clean: false,
            entries: [{ path: 'conflicted.ts', code: 'UU' }],
          },
        })),
      },
    })

    const result = await service.run({ workspaceId: workspace.id })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const issues = result.data.checks.filter(({ outcome }) => outcome === 'issue')
    expect(issues.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['agent:codex', 'agent:claude', 'worktree', 'branch', 'conflict']),
    )
    expect(issues.every(({ severity }) => severity === 'warning' || severity === 'error')).toBe(
      true,
    )
  })
})
