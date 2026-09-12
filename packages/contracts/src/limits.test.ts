import { describe, expect, it } from 'vitest'

import { resizeAgentRunRequestSchema, startAgentRunRequestSchema } from './agent'
import {
  IPC_CONTENT_MAX,
  IPC_ID_MAX,
  TERMINAL_DIMENSION_MAX,
  terminalDimensionSchema,
} from './limits'
import { taskSchema } from './task'
import {
  createTerminalRequestSchema,
  terminalResizeRequestSchema,
  terminalWriteRequestSchema,
} from './terminal'
import { workspaceSchema } from './workspace'

/**
 * P2-20 — IPC request schemas carry upper bounds; storage/output schemas do
 * NOT, so rows persisted before the bounds existed keep validating.
 */
describe('IPC request payload bounds (P2-20)', () => {
  it('rejects absurd terminal dimensions before they reach pty.resize', () => {
    expect(
      terminalResizeRequestSchema.safeParse({ terminalId: 't-1', cols: 1e9, rows: 30 }).success,
    ).toBe(false)
    expect(
      terminalResizeRequestSchema.safeParse({ terminalId: 't-1', cols: 120, rows: 1e9 }).success,
    ).toBe(false)
    expect(
      terminalResizeRequestSchema.safeParse({
        terminalId: 't-1',
        cols: TERMINAL_DIMENSION_MAX,
        rows: TERMINAL_DIMENSION_MAX,
      }).success,
    ).toBe(true)
    expect(
      terminalResizeRequestSchema.safeParse({
        terminalId: 't-1',
        cols: TERMINAL_DIMENSION_MAX + 1,
        rows: 30,
      }).success,
    ).toBe(false)
    expect(terminalDimensionSchema.safeParse(0).success).toBe(false)
  })

  it('bounds cols/rows on terminal create and agent-run resize too', () => {
    expect(
      createTerminalRequestSchema.safeParse({
        workspaceId: 'ws-1',
        shell: 'wsl',
        cols: 10_000,
      }).success,
    ).toBe(false)
    expect(
      resizeAgentRunRequestSchema.safeParse({ runId: 'run-1', cols: 80, rows: 24 }).success,
    ).toBe(true)
    expect(
      resizeAgentRunRequestSchema.safeParse({ runId: 'run-1', cols: 80, rows: 100_000 }).success,
    ).toBe(false)
  })

  it('rejects over-length id strings on request schemas', () => {
    const tooLong = 'x'.repeat(IPC_ID_MAX + 1)
    expect(
      createTerminalRequestSchema.safeParse({ workspaceId: tooLong, shell: 'wsl' }).success,
    ).toBe(false)
    expect(
      startAgentRunRequestSchema.safeParse({ workspaceId: 'ws-1', agentType: tooLong }).success,
    ).toBe(false)
    // Exactly at the bound still passes.
    expect(
      startAgentRunRequestSchema.safeParse({
        workspaceId: 'x'.repeat(IPC_ID_MAX),
        agentType: 'fake-agent',
      }).success,
    ).toBe(true)
  })

  it('rejects over-length bulk payloads (terminal write / run input)', () => {
    const huge = 'y'.repeat(IPC_CONTENT_MAX + 1)
    expect(terminalWriteRequestSchema.safeParse({ terminalId: 't-1', data: huge }).success).toBe(
      false,
    )
  })

  it('leaves storage schemas unbounded so existing DB rows keep validating', () => {
    const longText = 'z'.repeat(IPC_CONTENT_MAX * 2)
    const task = taskSchema.safeParse({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: longText,
      description: longText,
      status: 'draft',
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    })
    expect(task.success).toBe(true)

    const workspace = workspaceSchema.safeParse({
      id: 'ws-1',
      name: longText,
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: longText,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    })
    expect(workspace.success).toBe(true)
  })
})
