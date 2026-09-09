import { describe, expect, it } from 'vitest'

import {
  createTerminalRequestSchema,
  terminalCloseRequestSchema,
  terminalResizeRequestSchema,
  terminalSessionSchema,
  terminalWriteRequestSchema,
} from './terminal'

describe('terminal contracts (TASK-017)', () => {
  it('validates TerminalSession independently from AgentRun', () => {
    expect(
      terminalSessionSchema.safeParse({
        id: 'term-1',
        workspaceId: 'ws-1',
        shell: 'wsl',
        processId: 'proc-1',
        title: 'Ubuntu',
        createdAt: '2026-09-10T00:00:00.000Z',
      }).success,
    ).toBe(true)
  })

  it('ships strict create/write/resize/close request schemas for the future Facade and IPC', () => {
    expect(
      createTerminalRequestSchema.safeParse({ workspaceId: 'ws-1', shell: 'powershell' }).success,
    ).toBe(true)
    expect(
      terminalWriteRequestSchema.safeParse({ terminalId: 'term-1', data: '\u0003' }).success,
    ).toBe(true)
    expect(
      terminalResizeRequestSchema.safeParse({ terminalId: 'term-1', cols: 120, rows: 30 }).success,
    ).toBe(true)
    expect(
      terminalResizeRequestSchema.safeParse({ terminalId: 'term-1', cols: 0, rows: 30 }).success,
    ).toBe(false)
    expect(
      terminalCloseRequestSchema.safeParse({ terminalId: 'term-1', extra: true }).success,
    ).toBe(false)
  })
})
