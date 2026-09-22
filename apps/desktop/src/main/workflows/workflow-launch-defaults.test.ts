import { describe, expect, it, vi } from 'vitest'

import type {
  IpcResult,
  ResolvedRunDefaults,
  WorkflowDefinitionFileInfo,
  WorkflowRunDefaults,
  Workspace,
} from '@teskra/contracts'

import {
  buildDefaultFullWorkflowDefinition,
  DEFAULT_FULL_TEST_COMMAND,
  DEFAULT_FULL_WORKFLOW_ID,
} from './default-workflow'
import { createWorkflowLaunchDefaultsService } from './workflow-launch-defaults'

const WORKSPACE: Workspace = {
  id: 'ws1',
  name: 'Demo',
  runtime: { kind: 'windows' },
  path: '/repo',
  trustLevel: 'trusted',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

function runDefaults(agentType: string): ResolvedRunDefaults {
  return {
    agentType,
    mode: 'exec',
    executionMode: 'orchestrated',
    approvalMode: 'safe-auto',
    isolation: 'worktree',
    reasons: [],
  }
}

function workflowDefaults(
  implementer = 'codex',
  reviewers: readonly string[] = ['claude-code'],
): IpcResult<WorkflowRunDefaults> {
  return { ok: true, data: { implementer: runDefaults(implementer), reviewers: [...reviewers] } }
}

function overrideInfo(testCommand: string): WorkflowDefinitionFileInfo {
  return {
    path: '/repo/.teskra/workflows/full.yaml',
    status: 'loaded',
    id: DEFAULT_FULL_WORKFLOW_ID,
    definition: buildDefaultFullWorkflowDefinition({
      implementer: 'fake-impl',
      reviewers: ['fake-rev'],
      testCommand,
    }),
    issues: [],
  }
}

interface FixtureOptions {
  readonly workspace?: Workspace | null
  readonly definitions?: readonly WorkflowDefinitionFileInfo[]
  readonly defaults?: IpcResult<WorkflowRunDefaults>
}

function fixture(options: FixtureOptions = {}) {
  const list = vi.fn(() => ({ ok: true as const, data: options.definitions ?? [] }))
  const service = createWorkflowLaunchDefaultsService({
    workspaces: {
      getById: () => ({
        ok: true as const,
        data: options.workspace === undefined ? WORKSPACE : options.workspace,
      }),
    },
    definitions: { list },
    defaults: {
      resolveWorkflowDefaults: async () => options.defaults ?? workflowDefaults(),
    },
  })
  return { service, list }
}

describe('WorkflowLaunchDefaultsService (TASK-137)', () => {
  it('summarizes the DefaultSelectionService identities with the built-in test command', async () => {
    const { service } = fixture()
    const resolved = await service.resolve('ws1')
    expect(resolved).toEqual({
      ok: true,
      data: {
        implementer: 'codex',
        reviewers: ['claude-code'],
        testCommand: DEFAULT_FULL_TEST_COMMAND,
        testCommandFromRepo: false,
      },
    })
  })

  it('takes the test command from the repo full definition of a trusted workspace', async () => {
    const { service } = fixture({ definitions: [overrideInfo('make test')] })
    const resolved = await service.resolve('ws1')
    expect(resolved).toEqual({
      ok: true,
      data: {
        implementer: 'codex',
        reviewers: ['claude-code'],
        testCommand: 'make test',
        testCommandFromRepo: true,
      },
    })
  })

  it('falls back to the built-in command for a restricted workspace without reading the repo (TASK-118)', async () => {
    const { service, list } = fixture({
      workspace: { ...WORKSPACE, trustLevel: 'restricted' },
      definitions: [overrideInfo('make test')],
    })
    const resolved = await service.resolve('ws1')
    expect(resolved).toEqual({
      ok: true,
      data: {
        implementer: 'codex',
        reviewers: ['claude-code'],
        testCommand: DEFAULT_FULL_TEST_COMMAND,
        testCommandFromRepo: false,
      },
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('rejects an invalid repo full definition instead of hiding it', async () => {
    const { service } = fixture({
      definitions: [
        {
          path: '/repo/.teskra/workflows/full.yaml',
          status: 'invalid',
          id: DEFAULT_FULL_WORKFLOW_ID,
          issues: ['duplicate step id'],
        },
      ],
    })
    const resolved = await service.resolve('ws1')
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('VALIDATION_FAILED')
      expect(resolved.error.messageKey).toBe('errorMessage.fullWorkflowOverrideInvalid')
    }
  })

  it('fails when the workspace is gone', async () => {
    const { service } = fixture({ workspace: null })
    const resolved = await service.resolve('ws1')
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error.messageKey).toBe('errorMessage.workspaceNotFound')
  })

  it('propagates a DefaultSelectionService failure (e.g. no installed agent)', async () => {
    const failure: IpcResult<WorkflowRunDefaults> = {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'No installed Agent is available.',
        retryable: false,
      },
    }
    const { service } = fixture({ defaults: failure })
    const resolved = await service.resolve('ws1')
    expect(resolved).toEqual(failure)
  })
})
