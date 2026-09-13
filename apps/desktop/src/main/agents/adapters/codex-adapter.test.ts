import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import type {
  AgentDetectionResult,
  AgentResumeRequest,
  AgentStartRequest,
  IpcResult,
  WorkbenchEvents,
} from '@teskra/contracts'

import { createEventBus } from '../../events/event-bus'
import { createProcessManager, type ProcessManagerDeps } from '../../process/process-manager'
import { createWorkspaceRuntime } from '../../workspace/runtime'
import type { AgentDetector } from '../agent-detector'
import { agentProcessId } from './cli-agent-adapter'
import {
  buildCodexArguments,
  buildCodexResumeArguments,
  createCodexAdapter,
  validateCodexResumeProfile,
  type CodexResumeProfileContext,
} from './codex-adapter'

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

describe('CodexAdapter resume profile guard (TASK-098, §10.5)', () => {
  const resumeRequest: AgentResumeRequest = {
    ...baseRequest,
    prompt: 'Continue from the failure',
    providerSession: { provider: 'codex', sessionId: '0199-codex-session' },
  }
  const sameHome: CodexResumeProfileContext = {
    accountProfileId: 'acct_codex_personal',
    snapshotConfigHome: '/home/u/.teskra/agent-profiles/codex/personal',
    currentConfigHome: '/home/u/.teskra/agent-profiles/codex/personal',
  }

  it('rejects resume when the resolved profile configHome changed (§10.5 (1))', () => {
    const result = validateCodexResumeProfile(resumeRequest, {
      ...sameHome,
      currentConfigHome: '/home/u/.teskra/agent-profiles/codex/work',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CONFLICT')
    expect(result.error.message).toContain('Continuation')
  })

  it('rejects resume when the snapshot home exists but no profile resolves now', () => {
    const result = validateCodexResumeProfile(resumeRequest, {
      ...sameHome,
      currentConfigHome: undefined,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CONFLICT')
  })

  it('allows resume when the configHome matches and a session id exists', () => {
    expect(validateCodexResumeProfile(resumeRequest, sameHome)).toEqual({
      ok: true,
      data: undefined,
    })
  })

  it('disables the --last fallback for account-profile runs (§10.5 (2))', () => {
    const withoutSession: AgentResumeRequest = {
      ...resumeRequest,
      providerSession: { provider: 'codex' },
    }

    const result = validateCodexResumeProfile(withoutSession, sameHome)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(result.error.message).toContain('--last')

    // Even an ungated argument build must not emit --last: the CLI errors out
    // instead of silently resuming whatever session is last in that home.
    const args = buildCodexResumeArguments(withoutSession, sameHome)
    expect(args).not.toContain('--last')
  })

  it('keeps the legacy --last fallback for runs without an account profile', () => {
    const withoutSession: AgentResumeRequest = {
      ...resumeRequest,
      providerSession: { provider: 'codex' },
    }

    expect(validateCodexResumeProfile(withoutSession, {})).toEqual({ ok: true, data: undefined })
    expect(buildCodexResumeArguments(withoutSession)).toContain('--last')
    expect(buildCodexResumeArguments(withoutSession, {})).toContain('--last')
  })
})

describe('CodexAdapter handoff writable root (ADR-0004)', () => {
  const windowsRequest: AgentStartRequest = {
    ...baseRequest,
    workspace: { ...baseRequest.workspace, runtime: { kind: 'windows' } },
    handoffPath: 'C:\\Users\\u\\.teskra\\runs\\run-codex-1\\handoff.json',
    artifactDir: 'C:\\Users\\u\\.teskra\\runs\\run-codex-1\\artifacts',
  }
  const RUN_DIR = 'C:\\Users\\u\\.teskra\\runs\\run-codex-1'

  it('grants the run directory as a writable root under workspace-write modes', () => {
    expect(
      buildCodexArguments({
        ...windowsRequest,
        mode: 'exec',
        prompt: 'Ship it',
        approvalMode: 'safe-auto',
      }),
    ).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '-c',
      `sandbox_workspace_write.writable_roots=[${JSON.stringify(RUN_DIR)}]`,
      'exec',
      'Ship it',
    ])
  })

  it('omits the writable root under the read-only sandbox (the CLI has no such mechanism)', () => {
    expect(buildCodexArguments({ ...windowsRequest, approvalMode: 'read-only' })).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
    ])
  })

  it('omits the writable root when the launch carries no handoff path', () => {
    expect(buildCodexArguments({ ...baseRequest, approvalMode: 'safe-auto' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ])
  })

  it('grants the runtime-scoped (posix) run directory on WSL launches', () => {
    expect(
      buildCodexArguments({
        ...baseRequest,
        approvalMode: 'full-auto',
        handoffPath: '/mnt/c/Users/u/.teskra/runs/run-codex-1/handoff.json',
      }),
    ).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      '-c',
      'sandbox_workspace_write.writable_roots=["/mnt/c/Users/u/.teskra/runs/run-codex-1"]',
    ])
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
        '--exec',
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
      resize: vi.fn(),
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

describe('CliAgentAdapter launch command resolution', () => {
  const hostNativeRuntime = {
    ref: baseRequest.workspace.runtime,
    hostNative: true,
    resolveCommand: (command: string, args: readonly string[] = [], cwd?: string) => ({
      executable: command,
      args,
      cwd,
    }),
    resolveTerminal: () => ({ ok: true as const, data: { command: 'bash', args: [] } }),
    resolveCwd: (path: string) => path,
    resolveHostPath: (path: string) => ({ ok: true as const, data: path }),
    resolveDataRoot: () => '/home/test',
    resolveAgentProfilesRoot: () => '/home/test/agent-profiles',
    resolveAgentProfileHome: (agentId: string, slug: string) => ({
      ok: true as const,
      data: `/home/test/agent-profiles/${agentId}/${slug}`,
    }),
    validate: () => ({ ok: true as const, data: { kind: 'wsl' as const, hostNative: true } }),
  }

  function setup(options: {
    detection: IpcResult<AgentDetectionResult>
    override?: string | null
  }) {
    const processes = {
      start: vi.fn(() => ({
        ok: true as const,
        data: {
          id: agentProcessId(baseRequest.runId),
          pid: 4646,
          workspaceId: baseRequest.workspace.id,
          agentRunId: baseRequest.runId,
          startedAt: '2026-09-10T00:00:00.000Z',
        },
      })),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    }
    const adapter = createCodexAdapter({
      processes,
      detector: {
        detect: vi.fn(async () => options.detection),
        getExecutableOverride: vi.fn(() => ({
          ok: true as const,
          data: options.override ?? null,
        })),
      },
      resolveRuntime: () => ({ ok: true as const, data: hostNativeRuntime }),
    })
    return { adapter, processes }
  }

  function detectionResult(
    overrides: Partial<AgentDetectionResult>,
  ): IpcResult<AgentDetectionResult> {
    return {
      ok: true,
      data: {
        agentId: 'codex',
        runtime: baseRequest.workspace.runtime,
        installed: true,
        overridden: false,
        fromCache: false,
        checkedAt: '2026-09-10T00:00:00.000Z',
        ...overrides,
      },
    }
  }

  it('launches with the full executable path resolved by detection', async () => {
    const { adapter, processes } = setup({
      detection: detectionResult({
        executable: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
      }),
    })

    const started = await adapter.start(baseRequest)
    expect(started.ok).toBe(true)
    expect(processes.start).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd' }),
    )
  })

  it('falls back to the bare command when detection says not installed', async () => {
    const { adapter, processes } = setup({
      detection: detectionResult({
        installed: false,
        executable: 'C:\\npm\\codex.cmd',
        error: 'not found',
      }),
    })

    const started = await adapter.start(baseRequest)
    expect(started.ok).toBe(true)
    expect(processes.start).toHaveBeenCalledWith(expect.objectContaining({ command: 'codex' }))
  })

  it('falls back to the bare command when detection itself fails', async () => {
    const { adapter, processes } = setup({
      detection: {
        ok: false,
        error: { code: 'UNKNOWN', message: 'probe failed', retryable: true },
      },
    })

    const started = await adapter.start(baseRequest)
    expect(started.ok).toBe(true)
    expect(processes.start).toHaveBeenCalledWith(expect.objectContaining({ command: 'codex' }))
  })

  it('keeps the executable override when detection cannot confirm an install', async () => {
    const { adapter, processes } = setup({
      override: '/opt/codex-custom',
      detection: detectionResult({ installed: false, error: 'not found' }),
    })

    const started = await adapter.start(baseRequest)
    expect(started.ok).toBe(true)
    expect(processes.start).toHaveBeenCalledWith(
      expect.objectContaining({ command: '/opt/codex-custom' }),
    )
  })
})
