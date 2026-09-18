import { describe, expect, it, vi } from 'vitest'

import type { AgentResumeRequest, AgentStartRequest } from '@teskra/contracts'

import { buildKimiArguments, buildKimiResumeArguments, createKimiAdapter } from './kimi-adapter'

const baseRequest: AgentStartRequest = {
  runId: 'run-kimi-1',
  workspace: {
    id: 'workspace-1',
    name: 'Demo',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: '/workspaces/demo',
    trustLevel: 'trusted',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  },
}

describe('KimiAdapter arguments (TASK-026)', () => {
  it('builds an interactive launch with permission flag and model', () => {
    expect(
      buildKimiArguments({
        ...baseRequest,
        model: 'kimi-k2',
        approvalMode: 'safe-auto',
      }),
    ).toEqual(['--yolo', '--model', 'kimi-k2'])
  })

  it('omits permission flags in headless mode (kimi --prompt rejects them)', () => {
    expect(
      buildKimiArguments({
        ...baseRequest,
        mode: 'exec',
        prompt: 'Implement the feature',
        approvalMode: 'full-auto',
      }),
    ).toEqual(['--prompt', 'Implement the feature'])
  })

  it('keeps interactive launches permission-projected but prompt-less', () => {
    expect(
      buildKimiArguments({
        ...baseRequest,
        prompt: 'ignored by the interactive TUI',
        approvalMode: 'read-only',
      }),
    ).toEqual(['--plan'])
  })

  it('prefers the projected permission profile over the bare approval mode (TASK-077)', () => {
    expect(
      buildKimiArguments({
        ...baseRequest,
        approvalMode: 'full-auto',
        permissionProfile: {
          id: 'kimi:read-only',
          approvalMode: 'read-only',
          allow: [],
          deny: [],
        },
      }),
    ).toEqual(['--plan'])
  })

  it('builds resume with --session for a known session and --continue for the latest', () => {
    const resumeRequest: AgentResumeRequest = {
      ...baseRequest,
      prompt: 'Continue the fix',
      approvalMode: 'manual',
      providerSession: { provider: 'kimi', sessionId: 'kimi-session-1' },
    }
    expect(buildKimiResumeArguments(resumeRequest)).toEqual(['--session', 'kimi-session-1'])
    expect(
      buildKimiResumeArguments({
        ...resumeRequest,
        mode: 'exec',
        providerSession: { provider: 'kimi' },
      }),
    ).toEqual(['--continue', '--prompt', 'Continue the fix'])
  })

  it('rejects a provider-mismatched resume before starting a process', async () => {
    const adapter = createKimiAdapter({
      processes: {
        start: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        stop: vi.fn(),
      },
      detector: {
        detect: vi.fn(),
        getExecutableOverride: vi.fn(),
      },
      resolveRuntime: vi.fn(),
    })

    const result = await adapter.resume?.({
      ...baseRequest,
      providerSession: { provider: 'codex', sessionId: 'codex-session' },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})
