import { describe, expect, it } from 'vitest'

import { IPC_TEXT_MAX } from './limits'
import { sendTaskMessageRequestSchema, sendTaskMessageResultSchema } from './thread'

describe('send-message contract (TASK-135)', () => {
  it('accepts a minimal request (taskId absent = create from first line)', () => {
    expect(
      sendTaskMessageRequestSchema.safeParse({ workspaceId: 'ws-1', text: 'Fix the login page' })
        .success,
    ).toBe(true)
  })

  it('accepts a full request with per-send overrides', () => {
    expect(
      sendTaskMessageRequestSchema.safeParse({
        taskId: 'task-1',
        workspaceId: 'ws-1',
        text: 'Title\nDetails',
        overrides: { agentType: 'codex', accountProfileId: 'acct-1', executionProfileId: 'exec-1' },
      }).success,
    ).toBe(true)
  })

  it('is a strictObject: unknown keys are rejected at the IPC boundary', () => {
    expect(
      sendTaskMessageRequestSchema.safeParse({
        workspaceId: 'ws-1',
        text: 'hello',
        approvalMode: 'manual',
      }).success,
    ).toBe(false)
    expect(
      sendTaskMessageRequestSchema.safeParse({
        workspaceId: 'ws-1',
        text: 'hello',
        overrides: { agentType: 'codex', executionMode: 'attended' },
      }).success,
    ).toBe(false)
  })

  it('cannot express the attended + manual combination', () => {
    // The overrides schema structurally has no mode / executionMode /
    // approvalMode fields, so the forbidden combination cannot cross IPC.
    const parsed = sendTaskMessageRequestSchema.safeParse({
      workspaceId: 'ws-1',
      text: 'hello',
      overrides: {},
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(Object.keys(parsed.data.overrides ?? {})).toEqual([])
    }
  })

  it('rejects blank and oversized text', () => {
    expect(
      sendTaskMessageRequestSchema.safeParse({ workspaceId: 'ws-1', text: '   ' }).success,
    ).toBe(false)
    expect(
      sendTaskMessageRequestSchema.safeParse({
        workspaceId: 'ws-1',
        text: 'x'.repeat(IPC_TEXT_MAX + 1),
      }).success,
    ).toBe(false)
  })

  it('bounds the result kind to run | review | workflow', () => {
    for (const kind of ['run', 'review', 'workflow'] as const) {
      expect(
        sendTaskMessageResultSchema.safeParse({ taskId: 'task-1', kind, id: 'id-1' }).success,
      ).toBe(true)
    }
    expect(
      sendTaskMessageResultSchema.safeParse({ taskId: 'task-1', kind: 'chat', id: 'id-1' }).success,
    ).toBe(false)
  })
})
