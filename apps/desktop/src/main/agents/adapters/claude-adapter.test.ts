import { describe, expect, it, vi } from 'vitest'

import type { AgentDetectionResult, AgentResumeRequest, AgentStartRequest } from '@teskra/contracts'

import type { ProcessManager } from '../../process/process-manager'
import type { WorkspaceRuntime } from '../../workspace/runtime'
import type { AgentDetector } from '../agent-detector'
import { agentProcessId } from './cli-agent-adapter'
import {
  buildClaudeArguments,
  buildClaudeResumeArguments,
  createClaudeAdapter,
} from './claude-adapter'

const runtime: WorkspaceRuntime = {
  ref: { kind: 'wsl', distro: 'Ubuntu' },
  hostNative: true,
  resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
  resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: [] } }),
  resolveCwd: (path) => path,
  resolveDataRoot: () => '/home/test',
  validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: true } }),
}

const request: AgentStartRequest = {
  runId: 'run-claude-1',
  workspace: {
    id: 'workspace-1',
    name: 'Demo',
    runtime: runtime.ref,
    path: '/repo',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  },
}

function dependencies() {
  const processes: Pick<ProcessManager, 'start' | 'write' | 'stop'> = {
    start: vi.fn(() => ({
      ok: true as const,
      data: {
        id: agentProcessId(request.runId),
        pid: 4343,
        workspaceId: request.workspace.id,
        agentRunId: request.runId,
        startedAt: '2026-09-10T00:00:00.000Z',
      },
    })),
    write: vi.fn(() => ({ ok: true as const, data: undefined })),
    stop: vi.fn(async () => ({
      ok: true as const,
      data: {
        stage: 'interrupt' as const,
        exit: { processId: agentProcessId(request.runId), exitCode: 0 },
      },
    })),
  }
  const detection: AgentDetectionResult = {
    agentId: 'claude',
    runtime: runtime.ref,
    installed: true,
    executable: 'claude',
    version: '2.1.236 (Claude Code)',
    overridden: false,
    fromCache: false,
    checkedAt: '2026-09-10T00:00:00.000Z',
  }
  const detector: Pick<AgentDetector, 'detect' | 'getExecutableOverride'> = {
    detect: vi.fn(async () => ({ ok: true as const, data: detection })),
    getExecutableOverride: vi.fn(() => ({ ok: true as const, data: null })),
  }
  return { processes, detector }
}

describe('ClaudeAdapter arguments (TASK-027)', () => {
  it('builds interactive, model, and persisted session arguments', () => {
    expect(
      buildClaudeArguments(
        {
          ...request,
          prompt: 'Review this change',
          model: 'sonnet',
          approvalMode: 'manual',
        },
        '550e8400-e29b-41d4-a716-446655440000',
      ),
    ).toEqual([
      '--permission-mode',
      'manual',
      '--model',
      'sonnet',
      '--session-id',
      '550e8400-e29b-41d4-a716-446655440000',
      'Review this change',
    ])
  })

  it('projects read-only to plan mode and headless to --print', () => {
    expect(
      buildClaudeArguments(
        { ...request, mode: 'exec', prompt: 'Analyze only', approvalMode: 'read-only' },
        '550e8400-e29b-41d4-a716-446655440001',
      ),
    ).toEqual([
      '--permission-mode',
      'plan',
      '--session-id',
      '550e8400-e29b-41d4-a716-446655440001',
      '--print',
      'Analyze only',
    ])
  })

  it('builds --resume for a known session and --continue for the latest', () => {
    const resumeRequest: AgentResumeRequest = {
      ...request,
      mode: 'exec',
      prompt: 'Continue review',
      approvalMode: 'safe-auto',
      providerSession: { provider: 'claude', sessionId: 'claude-session' },
    }
    expect(buildClaudeResumeArguments(resumeRequest)).toEqual([
      '--permission-mode',
      'auto',
      '--print',
      '--resume',
      'claude-session',
      'Continue review',
    ])
    expect(
      buildClaudeResumeArguments({
        ...resumeRequest,
        mode: 'interactive',
        prompt: undefined,
        providerSession: { provider: 'claude' },
      }),
    ).toEqual(['--permission-mode', 'auto', '--continue'])
  })
})

describe('ClaudeAdapter process contract (TASK-027)', () => {
  it('starts, returns provider session identity, sends input, and stops', async () => {
    const deps = dependencies()
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const adapter = createClaudeAdapter({
      ...deps,
      resolveRuntime: () => ({ ok: true, data: runtime }),
      createSessionId: () => sessionId,
    })

    expect(await adapter.start({ ...request, prompt: 'Review' })).toEqual({
      ok: true,
      data: {
        runId: 'run-claude-1',
        processId: 'agent-run:run-claude-1',
        pid: 4343,
        startedAt: '2026-09-10T00:00:00.000Z',
        providerSession: { provider: 'claude', sessionId },
      },
    })
    expect(deps.processes.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'claude',
        args: ['--permission-mode', 'manual', '--session-id', sessionId, 'Review'],
      }),
    )
    expect(await adapter.send(request.runId, 'next\r')).toEqual({ ok: true, data: undefined })
    expect(await adapter.cancel(request.runId)).toEqual({ ok: true, data: undefined })
    expect(deps.processes.write).toHaveBeenCalledWith(agentProcessId(request.runId), 'next\r')
    expect(deps.processes.stop).toHaveBeenCalledWith(agentProcessId(request.runId))
  })

  it('resumes through the same process contract and preserves session identity', async () => {
    const deps = dependencies()
    const adapter = createClaudeAdapter({
      ...deps,
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })
    const providerSession = { provider: 'claude', sessionId: 'session-to-resume' }

    const result = await adapter.resume?.({ ...request, providerSession })
    expect(result).toMatchObject({ ok: true, data: { providerSession } })
    expect(deps.processes.start).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--permission-mode', 'manual', '--resume', 'session-to-resume'],
      }),
    )
  })

  it('rejects a provider-mismatched resume', async () => {
    const deps = dependencies()
    const adapter = createClaudeAdapter({
      ...deps,
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })

    const result = await adapter.resume?.({
      ...request,
      providerSession: { provider: 'codex', sessionId: 'codex-session' },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(deps.processes.start).not.toHaveBeenCalled()
  })
})
