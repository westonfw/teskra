import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import type { AgentResumeRequest, AgentStartRequest, WorkbenchEvents } from '@teskra/contracts'

import { createEventBus } from '../../events/event-bus'
import { createProcessManager, type ProcessManagerDeps } from '../../process/process-manager'
import { createWorkspaceRuntime } from '../../workspace/runtime'
import type { AgentDetector } from '../agent-detector'
import { buildCodexArguments, buildCodexResumeArguments, createCodexAdapter } from './codex-adapter'

const baseRequest: AgentStartRequest = {
  runId: 'run-codex-1',
  workspace: {
    id: 'workspace-1',
    name: 'Demo',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: '/workspaces/demo',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  },
}

describe('CodexAdapter arguments (TASK-026)', () => {
  it('builds an interactive launch with model and manual approval policy', () => {
    expect(
      buildCodexArguments({
        ...baseRequest,
        prompt: 'Implement TASK-026',
        model: 'gpt-5-codex',
        approvalMode: 'manual',
      }),
    ).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-5-codex',
      'Implement TASK-026',
    ])
  })

  it('builds headless exec without unsafe sandbox bypass flags', () => {
    const args = buildCodexArguments({
      ...baseRequest,
      mode: 'exec',
      prompt: 'Run the tests',
      approvalMode: 'full-auto',
    })

    expect(args).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      'exec',
      'Run the tests',
    ])
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('builds interactive and exec resume commands from provider session identity', () => {
    const resumeRequest: AgentResumeRequest = {
      ...baseRequest,
      prompt: 'Continue from the failure',
      approvalMode: 'read-only',
      providerSession: { provider: 'codex', sessionId: '0199-codex-session' },
    }
    expect(buildCodexResumeArguments(resumeRequest)).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      'resume',
      '0199-codex-session',
      'Continue from the failure',
    ])
    expect(
      buildCodexResumeArguments({
        ...resumeRequest,
        mode: 'exec',
        prompt: undefined,
        providerSession: { provider: 'codex' },
      }),
    ).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      'exec',
      'resume',
      '--last',
    ])
  })

  it('prefers the projected permission profile over the bare approval mode (TASK-077)', () => {
    expect(
      buildCodexArguments({
        ...baseRequest,
        approvalMode: 'full-auto',
        permissionProfile: {
          id: 'codex:read-only',
          approvalMode: 'read-only',
          allow: [],
          deny: [],
        },
      }),
    ).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request'])
  })
})

describe('CodexAdapter process integration (TASK-026)', () => {
  it('runs the complete Windows-to-WSL PTY path and delegates input and stop', async () => {
    const writes: Array<string | Buffer> = []
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined
    const spawn: NonNullable<ProcessManagerDeps['spawn']> = vi.fn((file, _args, options) => {
      const terminal = {
        pid: 4242,
        cols: options.cols ?? 0,
        rows: options.rows ?? 0,
        process: file,
        handleFlowControl: false,
        onData: () => ({ dispose: () => undefined }),
        onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
          exitListener = listener
          return { dispose: () => undefined }
        },
        write(data: string | Buffer) {
          writes.push(data)
          if (data === '\u0003') exitListener?.({ exitCode: 130, signal: 2 })
        },
        resize: () => undefined,
        kill: () => undefined,
        clear: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
      } as IPty
      return terminal
    })
    const events = createEventBus<WorkbenchEvents>()
    const processes = createProcessManager({ events, spawn, hostPlatform: 'win32' })
    const runtime = createWorkspaceRuntime(baseRequest.workspace.runtime, {
      hostPlatform: 'win32',
      wsl: {
        available: true,
        version: '2.4.11.0',
        distributions: ['Ubuntu'],
        defaultDistro: 'Ubuntu',
      },
    })
    if (!runtime.ok) throw new Error(runtime.error.message)
    const detector: Pick<AgentDetector, 'detect' | 'getExecutableOverride'> = {
      detect: vi.fn(async () => ({
        ok: true as const,
        data: {
          agentId: 'codex',
          runtime: baseRequest.workspace.runtime,
          installed: true,
          executable: '/home/test/.local/bin/codex',
          version: 'codex-cli 0.153.4',
          overridden: true,
          fromCache: false,
          checkedAt: '2026-09-10T00:00:00.000Z',
        },
      })),
      getExecutableOverride: vi.fn(() => ({
        ok: true as const,
        data: '/home/test/.local/bin/codex',
      })),
    }
    const adapter = createCodexAdapter({
      processes,
      detector,
      resolveRuntime: () => runtime,
    })

    expect(
      await adapter.start({
        ...baseRequest,
        prompt: 'Inspect the repository',
        approvalMode: 'safe-auto',
      }),
    ).toMatchObject({ ok: true, data: { runId: 'run-codex-1', pid: 4242 } })
    expect(spawn).toHaveBeenCalledWith(
      'wsl.exe',
      [
        '-d',
        'Ubuntu',
        '--cd',
        '/workspaces/demo',
        '/home/test/.local/bin/codex',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'on-request',
        'Inspect the repository',
      ],
      expect.objectContaining({ useConpty: true }),
    )

    expect(await adapter.send('run-codex-1', 'continue\r')).toEqual({
      ok: true,
      data: undefined,
    })
    expect(await adapter.cancel('run-codex-1')).toEqual({ ok: true, data: undefined })
    expect(writes).toEqual(['continue\r', '\u0003'])
  })

  it('rejects a provider-mismatched resume before starting a process', async () => {
    const processes = {
      start: vi.fn(),
      write: vi.fn(),
      stop: vi.fn(),
    }
    const adapter = createCodexAdapter({
      processes,
      detector: {
        detect: vi.fn(),
        getExecutableOverride: vi.fn(),
      },
      resolveRuntime: vi.fn(),
    })

    const result = await adapter.resume?.({
      ...baseRequest,
      providerSession: { provider: 'claude', sessionId: 'claude-session' },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(processes.start).not.toHaveBeenCalled()
  })
})
