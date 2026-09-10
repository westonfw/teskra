import { describe, expect, it, vi } from 'vitest'

import type { AgentDetectionResult, AgentStartRequest, IpcResult } from '@teskra/contracts'

import type { ProcessManager } from '../../process/process-manager'
import type { WorkspaceRuntime } from '../../workspace/runtime'
import type { AgentDetector } from '../agent-detector'
import { agentProcessId } from './cli-agent-adapter'
import { createFakeAgentAdapter } from './fake-agent-adapter'

const runtime: WorkspaceRuntime = {
  ref: { kind: 'wsl', distro: 'Ubuntu' },
  hostNative: true,
  resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
  resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: [] } }),
  resolveCwd: (path) => path,
  resolveHostPath: (path) => ({ ok: true, data: path }),
  resolveDataRoot: () => '/home/test',
  validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: true } }),
}

const request: AgentStartRequest = {
  runId: 'run-1',
  workspace: {
    id: 'workspace-1',
    name: 'Demo',
    runtime: runtime.ref,
    path: '/repo',
    env: { WORKSPACE_VALUE: 'one' },
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  },
  worktreePath: '/worktree',
  handoffPath: '/run/handoff.json',
  artifactDir: '/run/artifacts',
  environment: { TESKRA_FAKE_SCENARIO: 'needs-input', RUN_VALUE: 'two' },
}

function dependencies() {
  const processes: Pick<ProcessManager, 'start' | 'write' | 'stop'> = {
    start: vi.fn(() => ({
      ok: true as const,
      data: {
        id: agentProcessId(request.runId),
        pid: 4242,
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
    agentId: 'fake',
    runtime: runtime.ref,
    installed: true,
    executable: process.execPath,
    version: 'teskra-fake-agent 1.0.0',
    overridden: true,
    fromCache: false,
    checkedAt: '2026-09-10T00:00:00.000Z',
  }
  const detector: Pick<AgentDetector, 'detect' | 'getExecutableOverride'> = {
    detect: vi.fn(async () => ({ ok: true as const, data: detection })),
    getExecutableOverride: vi.fn(() => ({ ok: true as const, data: process.execPath })),
  }
  return { processes, detector }
}

describe('FakeAgentAdapter (TASK-025)', () => {
  it('detects and starts through injected runtime services', async () => {
    const deps = dependencies()
    const adapter = createFakeAgentAdapter({
      ...deps,
      scriptPath: '/teskra/tools/fake-agent.js',
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })

    expect(await adapter.detect({ runtime: runtime.ref })).toMatchObject({
      ok: true,
      data: { agentId: 'fake', installed: true },
    })
    expect(await adapter.start(request)).toEqual({
      ok: true,
      data: {
        runId: 'run-1',
        processId: 'agent-run:run-1',
        pid: 4242,
        startedAt: '2026-09-10T00:00:00.000Z',
      },
    })
    expect(deps.processes.start).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-run:run-1',
        command: process.execPath,
        args: ['/teskra/tools/fake-agent.js', '--scenario', 'needs-input'],
        cwd: '/worktree',
        workspaceId: 'workspace-1',
        agentRunId: 'run-1',
        runtime,
        env: expect.objectContaining({
          WORKSPACE_VALUE: 'one',
          RUN_VALUE: 'two',
          TESKRA_HANDOFF_PATH: '/run/handoff.json',
          TESKRA_ARTIFACT_DIR: '/run/artifacts',
          TESKRA_RUN_ID: 'run-1',
        }),
      }),
    )
  })

  it('sends and cancels only through ProcessManager', async () => {
    const deps = dependencies()
    const adapter = createFakeAgentAdapter({
      ...deps,
      scriptPath: '/teskra/tools/fake-agent.js',
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })

    expect(await adapter.send('run-1', 'continue\n')).toEqual({ ok: true, data: undefined })
    expect(deps.processes.write).toHaveBeenCalledWith('agent-run:run-1', 'continue\n')
    expect(await adapter.cancel('run-1')).toEqual({ ok: true, data: undefined })
    expect(deps.processes.stop).toHaveBeenCalledWith('agent-run:run-1')
  })

  it('propagates structured ProcessManager start failures', async () => {
    const deps = dependencies()
    deps.processes.start = vi.fn((): IpcResult<never> => ({
      ok: false,
      error: { code: 'UNKNOWN', message: 'spawn failed', retryable: false },
    }))
    const adapter = createFakeAgentAdapter({
      ...deps,
      scriptPath: '/teskra/tools/fake-agent.js',
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })

    expect(await adapter.start(request)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN', message: 'spawn failed', retryable: false },
    })
  })
})
