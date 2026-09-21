import { describe, expect, it } from 'vitest'

import { agentContinuationSchema, continueAgentRunRequestSchema } from './agent-continuation'
import { IPC_CHANNELS, ipcChannelDefinitions } from './ipc'

/**
 * TASK-107 (Milestone 24 §20/§28) — the cross-profile continuation contracts.
 */
describe('agentContinuationSchema (§20)', () => {
  it('accepts the full §20 shape', () => {
    const parsed = agentContinuationSchema.safeParse({
      sourceRunId: 'run-1',
      reason: 'rate-limit',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      summary: 'Half done.',
      changedFiles: ['src/a.ts'],
      artifactIds: ['art-1'],
      acceptanceCriteria: [{ id: 'c-1', description: 'works', required: true }],
      previousAgentId: 'codex',
      previousAccountProfileId: 'acct-personal',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts the minimal shape and rejects unknown reasons and extra keys', () => {
    expect(
      agentContinuationSchema.safeParse({
        sourceRunId: 'run-1',
        reason: 'manual-switch',
        workspaceId: 'ws-1',
        summary: 's',
        previousAgentId: 'codex',
      }).success,
    ).toBe(true)
    expect(
      agentContinuationSchema.safeParse({
        sourceRunId: 'run-1',
        reason: 'user-bored',
        workspaceId: 'ws-1',
        summary: 's',
        previousAgentId: 'codex',
      }).success,
    ).toBe(false)
    expect(
      agentContinuationSchema.safeParse({
        sourceRunId: 'run-1',
        reason: 'delegation',
        workspaceId: 'ws-1',
        summary: 's',
        previousAgentId: 'codex',
        targetRunId: 'run-2',
      }).success,
    ).toBe(false)
  })
})

describe('continueAgentRunRequestSchema (§28)', () => {
  it('accepts the §28 request shape with optional profile pins', () => {
    expect(
      continueAgentRunRequestSchema.safeParse({
        sourceRunId: 'run-1',
        targetAgentId: 'codex',
        targetAccountProfileId: 'acct-work',
        targetExecutionProfileId: 'exec-1',
      }).success,
    ).toBe(true)
    expect(
      continueAgentRunRequestSchema.safeParse({
        sourceRunId: 'run-1',
        targetAgentId: 'claude',
      }).success,
    ).toBe(true)
  })

  it('accepts an optional caller-declared reason and rejects unknown reasons (P1-2)', () => {
    expect(
      continueAgentRunRequestSchema.safeParse({
        sourceRunId: 'run-1',
        targetAgentId: 'codex',
        reason: 'rate-limit',
      }).success,
    ).toBe(true)
    expect(
      continueAgentRunRequestSchema.safeParse({
        sourceRunId: 'run-1',
        targetAgentId: 'codex',
        reason: 'user-bored',
      }).success,
    ).toBe(false)
  })

  it('rejects a missing sourceRunId / targetAgentId', () => {
    expect(continueAgentRunRequestSchema.safeParse({ targetAgentId: 'codex' }).success).toBe(false)
    expect(continueAgentRunRequestSchema.safeParse({ sourceRunId: 'run-1' }).success).toBe(false)
  })

  it('is mounted as the teskra:agent:continue-with-profile channel', () => {
    expect(IPC_CHANNELS.agentRunContinueWithProfile).toBe('teskra:agent:continue-with-profile')
    const definition = ipcChannelDefinitions.agentRunContinueWithProfile
    expect(definition.channel).toBe('teskra:agent:continue-with-profile')
    expect(
      definition.request.safeParse({ sourceRunId: 'run-1', targetAgentId: 'codex' }).success,
    ).toBe(true)
  })
})
