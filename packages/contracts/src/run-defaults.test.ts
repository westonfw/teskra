import { describe, expect, it } from 'vitest'

import {
  resolveRunDefaultsRequestSchema,
  resolvedRunDefaultsSchema,
  workflowRunDefaultsSchema,
  type ResolvedRunDefaults,
} from './run-defaults'

const RESOLVED: ResolvedRunDefaults = {
  agentType: 'codex',
  accountProfileId: 'acct-1',
  executionProfileId: 'exec-1',
  mode: 'exec',
  executionMode: 'orchestrated',
  approvalMode: 'safe-auto',
  isolation: 'worktree',
  reasons: [
    { key: 'runDefaults.reason.agent.configured', params: { agent: 'codex' } },
    { key: 'runDefaults.reason.mode.fixed' },
  ],
}

describe('run-defaults contract (TASK-134)', () => {
  it('accepts a fully populated ResolvedRunDefaults', () => {
    expect(resolvedRunDefaultsSchema.safeParse(RESOLVED).success).toBe(true)
  })

  it('accepts absent profile ids (no defaults configured)', () => {
    const minimal = { ...RESOLVED }
    delete (minimal as Record<string, unknown>)['accountProfileId']
    delete (minimal as Record<string, unknown>)['executionProfileId']
    expect(resolvedRunDefaultsSchema.safeParse(minimal).success).toBe(true)
  })

  it('rejects non-thread-mode fixed values', () => {
    expect(resolvedRunDefaultsSchema.safeParse({ ...RESOLVED, mode: 'interactive' }).success).toBe(
      false,
    )
    expect(
      resolvedRunDefaultsSchema.safeParse({ ...RESOLVED, executionMode: 'attended' }).success,
    ).toBe(false)
    expect(
      resolvedRunDefaultsSchema.safeParse({ ...RESOLVED, approvalMode: 'full-auto' }).success,
    ).toBe(false)
    expect(resolvedRunDefaultsSchema.safeParse({ ...RESOLVED, isolation: 'none' }).success).toBe(
      false,
    )
  })

  it('rejects unknown keys and non-string params (strictObject)', () => {
    expect(resolvedRunDefaultsSchema.safeParse({ ...RESOLVED, extra: 1 }).success).toBe(false)
    expect(
      resolvedRunDefaultsSchema.safeParse({
        ...RESOLVED,
        reasons: [{ key: 'k', params: { p: true } }],
      }).success,
    ).toBe(false)
  })

  it('validates the resolve request (role is an AgentRole, optional)', () => {
    expect(resolveRunDefaultsRequestSchema.safeParse({ workspaceId: 'ws-1' }).success).toBe(true)
    expect(
      resolveRunDefaultsRequestSchema.safeParse({ workspaceId: 'ws-1', role: 'reviewer' }).success,
    ).toBe(true)
    expect(
      resolveRunDefaultsRequestSchema.safeParse({ workspaceId: 'ws-1', role: 'captain' }).success,
    ).toBe(false)
    expect(resolveRunDefaultsRequestSchema.safeParse({ role: 'reviewer' }).success).toBe(false)
  })

  it('validates workflow defaults (implementer + reviewers)', () => {
    expect(
      workflowRunDefaultsSchema.safeParse({ implementer: RESOLVED, reviewers: ['claude'] }).success,
    ).toBe(true)
    expect(
      workflowRunDefaultsSchema.safeParse({ implementer: RESOLVED, reviewers: [''] }).success,
    ).toBe(false)
  })
})
