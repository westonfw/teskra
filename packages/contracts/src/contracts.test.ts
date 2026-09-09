import { describe, expect, it } from 'vitest'

import { AGENT_RUN_STATUSES, agentDefinitionSchema, agentStartRequestSchema } from './agent'
import { IPC_CHANNELS, ipcChannelDefinitions, pingChannel, pingResponseSchema } from './ipc'

describe('agent contracts', () => {
  it('agentType is a free-form string, not a hardcoded enum (plan §21 / TASK-022)', () => {
    const definition = {
      id: 'fake-agent-for-tests',
      name: 'Fake Agent',
      executable: { command: 'fake-agent' },
      capabilities: {
        interactive: true,
        headless: false,
        resume: false,
        readOnlyMode: false,
        modelSelection: false,
      },
      prompt: {},
      detection: { versionArgs: ['--version'] },
      defaults: {},
    }
    const result = agentDefinitionSchema.safeParse(definition)
    expect(result.success).toBe(true)
    expect(result.success && result.data.id).toBe('fake-agent-for-tests')
  })

  it('AgentStartRequest carries the ADR-0004 file-contract paths', () => {
    const result = agentStartRequestSchema.safeParse({
      runId: 'RUN-001',
      workspace: {
        id: 'ws1',
        name: 'demo',
        runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
        path: '/home/user/demo',
        createdAt: '2026-09-09T00:00:00.000Z',
        updatedAt: '2026-09-09T00:00:00.000Z',
      },
      prompt: 'implement TASK-003',
      approvalMode: 'read-only',
      handoffPath: '/wt/.teskra/handoff/RUN-001.json',
      artifactDir: '/wt/.teskra/artifacts/RUN-001/',
    })
    expect(result.success).toBe(true)
  })

  it('AgentRunStatus schema accepts interrupted', () => {
    expect(AGENT_RUN_STATUSES).toContain('interrupted')
  })
})

describe('ipc contracts', () => {
  it('ping channel is registered with request/response schemas', () => {
    expect(IPC_CHANNELS.ping).toBe('teskra:ping')
    expect(pingChannel.channel).toBe('teskra:ping')
    expect(ipcChannelDefinitions.ping).toBe(pingChannel)
    expect(pingResponseSchema.safeParse({ ok: true, data: 'pong' }).success).toBe(true)
    expect(() => pingChannel.request.parse(undefined)).not.toThrow()
  })

  it('registers a request and IpcResult response schema for every IPC channel', () => {
    expect(Object.values(ipcChannelDefinitions)).toHaveLength(Object.keys(IPC_CHANNELS).length)
    for (const definition of Object.values(ipcChannelDefinitions)) {
      expect(definition.request).toBeDefined()
      expect(
        definition.response.safeParse({
          ok: false,
          error: {
            code: 'UNKNOWN',
            message: 'safe',
            retryable: false,
          },
        }).success,
      ).toBe(true)
    }
  })
})
