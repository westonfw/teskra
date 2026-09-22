import { describe, expect, it } from 'vitest'

import { IPC_TEXT_MAX } from './limits'
import {
  AGENT_REPLY_TEXT_MAX,
  TASK_THREAD_MAX_LIMIT,
  sendTaskMessageRequestSchema,
  sendTaskMessageResultSchema,
  taskThreadRequestSchema,
  taskThreadResponseSchema,
  threadItemSchema,
} from './thread'

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

describe('task thread contract (TASK-138)', () => {
  it('accepts a minimal request and a cursor-paged one', () => {
    expect(taskThreadRequestSchema.safeParse({ taskId: 'task-1' }).success).toBe(true)
    expect(
      taskThreadRequestSchema.safeParse({
        taskId: 'task-1',
        afterCursor: '2026-09-23T00:00:00.000Z|user:run-1',
        limit: 50,
      }).success,
    ).toBe(true)
  })

  it('is a strictObject: unknown keys are rejected at the IPC boundary', () => {
    expect(
      taskThreadRequestSchema.safeParse({ taskId: 'task-1', workspaceId: 'ws-1' }).success,
    ).toBe(false)
  })

  it('caps limit at 200 and rejects non-positive values', () => {
    expect(
      taskThreadRequestSchema.safeParse({ taskId: 'task-1', limit: TASK_THREAD_MAX_LIMIT }).success,
    ).toBe(true)
    expect(
      taskThreadRequestSchema.safeParse({ taskId: 'task-1', limit: TASK_THREAD_MAX_LIMIT + 1 })
        .success,
    ).toBe(false)
    expect(taskThreadRequestSchema.safeParse({ taskId: 'task-1', limit: 0 }).success).toBe(false)
  })

  it('validates all five ThreadItem kinds through the discriminated union', () => {
    const at = '2026-09-23T00:00:00.000Z'
    const items = [
      { kind: 'user_message', id: 'user:run-1', createdAt: at, runId: 'run-1', text: 'hello' },
      {
        kind: 'agent_reply',
        id: 'reply:run-1',
        createdAt: at,
        runId: 'run-1',
        agentType: 'codex',
        text: 'hi',
        source: 'observation',
        truncated: false,
      },
      {
        kind: 'agent_progress',
        id: 'progress:1',
        createdAt: at,
        runId: 'run-1',
        event: { kind: 'progress', message: 'half', percent: 50 },
      },
      {
        kind: 'decision',
        id: 'decision:dec-1',
        createdAt: at,
        decisionId: 'dec-1',
        runId: 'run-1',
        decisionKind: 'agent_blocker',
        severity: 'blocking',
        status: 'open',
        title: 'Blocked',
        options: [{ id: 'retry', label: 'Retry' }],
      },
      {
        kind: 'system',
        id: 'system:workflow:wf-1',
        createdAt: at,
        systemKind: 'workflow',
        workflowRunId: 'wf-1',
        status: 'running',
        text: 'Workflow full',
      },
    ]
    for (const item of items) {
      expect(threadItemSchema.safeParse(item).success).toBe(true)
    }
    expect(threadItemSchema.safeParse({ kind: 'note', id: 'n-1', createdAt: at }).success).toBe(
      false,
    )
  })

  it('bounds agent_reply text at 32 KiB and validates the response envelope', () => {
    const at = '2026-09-23T00:00:00.000Z'
    const reply = {
      kind: 'agent_reply' as const,
      id: 'reply:run-1',
      createdAt: at,
      runId: 'run-1',
      agentType: 'codex',
      text: 'x'.repeat(AGENT_REPLY_TEXT_MAX),
      source: 'terminal' as const,
      truncated: true,
    }
    expect(
      taskThreadResponseSchema.safeParse({ items: [reply], nextCursor: `${at}|reply:run-1` })
        .success,
    ).toBe(true)
    expect(
      taskThreadResponseSchema.safeParse({
        items: [{ ...reply, text: 'x'.repeat(AGENT_REPLY_TEXT_MAX + 1) }],
      }).success,
    ).toBe(false)
  })
})
