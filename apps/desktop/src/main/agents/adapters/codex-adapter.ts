import type { AgentResumeRequest, AgentStartRequest, ApprovalMode } from '@teskra/contracts'

import { CODEX_AGENT } from '../definitions/codex'
import { createCliAgentAdapter, type CliAgentAdapterOptions } from './cli-agent-adapter'
import type { CodingAgentAdapter } from './coding-agent-adapter'

export type CodexAdapterOptions = Omit<
  CliAgentAdapterOptions,
  'definition' | 'baseArgs' | 'buildLaunch' | 'buildResumeLaunch'
>

function permissionArguments(mode: ApprovalMode | undefined): string[] {
  switch (mode ?? 'safe-auto') {
    case 'read-only':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request']
    case 'manual':
    case 'safe-auto':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
    case 'full-auto':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
  }
}

function commonArguments(request: AgentStartRequest): string[] {
  return [
    ...permissionArguments(request.approvalMode),
    ...(request.model === undefined ? [] : ['--model', request.model]),
  ]
}

/** TASK-026: Codex CLI argument construction lives exclusively in this Adapter. */
export function buildCodexArguments(request: AgentStartRequest): readonly string[] {
  return [
    ...commonArguments(request),
    ...(request.mode === 'exec' ? (CODEX_AGENT.prompt.headlessArgs ?? ['exec']) : []),
    ...(request.prompt === undefined ? [] : [request.prompt]),
  ]
}

export function buildCodexResumeArguments(request: AgentResumeRequest): readonly string[] {
  const sessionId = request.providerSession.sessionId ?? request.providerSession.threadId
  return [
    ...commonArguments(request),
    ...(request.mode === 'exec' ? (CODEX_AGENT.prompt.headlessArgs ?? ['exec']) : []),
    'resume',
    ...(sessionId === undefined ? ['--last'] : [sessionId]),
    ...(request.prompt === undefined ? [] : [request.prompt]),
  ]
}

export function createCodexAdapter(options: CodexAdapterOptions): CodingAgentAdapter {
  const adapter = createCliAgentAdapter({
    ...options,
    definition: CODEX_AGENT,
    buildLaunch: (request) => ({
      args: buildCodexArguments(request),
      providerSession: { provider: CODEX_AGENT.id },
    }),
    buildResumeLaunch: (request) => ({ args: buildCodexResumeArguments(request) }),
  })
  const resume = adapter.resume

  return {
    ...adapter,
    async resume(request) {
      if (request.providerSession.provider !== CODEX_AGENT.id) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: `Cannot resume a ${request.providerSession.provider} session with Codex.`,
            retryable: false,
          },
        }
      }
      if (resume === undefined) {
        return {
          ok: false,
          error: {
            code: 'CAPABILITY_NOT_AVAILABLE',
            message: 'This Codex Adapter does not support session resume.',
            retryable: false,
          },
        }
      }
      return resume(request)
    },
  }
}
