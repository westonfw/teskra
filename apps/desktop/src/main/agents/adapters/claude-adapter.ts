import { randomUUID } from 'node:crypto'

import type {
  AgentResumeRequest,
  AgentStartRequest,
  ProviderSessionRef,
} from '@teskra/contracts'

import { CLAUDE_AGENT } from '../definitions/claude'
import {
  CLAUDE_PERMISSION_MAPPING,
  permissionProfileForApprovalMode,
} from '../permissions/permission-projection'
import { createCliAgentAdapter, type CliAgentAdapterOptions } from './cli-agent-adapter'
import type { CodingAgentAdapter } from './coding-agent-adapter'

export interface ClaudeAdapterOptions extends Omit<
  CliAgentAdapterOptions,
  'definition' | 'baseArgs' | 'buildLaunch' | 'buildResumeLaunch'
> {
  readonly createSessionId?: () => string
}

/** TASK-077: permission args come from the shared policy projection mapping. */
function permissionArguments(request: AgentStartRequest): string[] {
  const profile =
    request.permissionProfile ??
    permissionProfileForApprovalMode(CLAUDE_AGENT.id, request.approvalMode ?? 'manual')
  return CLAUDE_PERMISSION_MAPPING.buildArgs?.(profile, request.permissionConfigPath) ?? []
}

function commonArguments(request: AgentStartRequest): string[] {
  return [
    ...permissionArguments(request),
    ...(request.model === undefined ? [] : ['--model', request.model]),
  ]
}

/** TASK-027: all Claude Code CLI details are private to this Adapter module. */
export function buildClaudeArguments(
  request: AgentStartRequest,
  sessionId: string,
): readonly string[] {
  return [
    ...commonArguments(request),
    '--session-id',
    sessionId,
    ...(request.mode === 'exec' ? (CLAUDE_AGENT.prompt.headlessArgs ?? ['--print']) : []),
    ...(request.prompt === undefined ? [] : [request.prompt]),
  ]
}

export function buildClaudeResumeArguments(request: AgentResumeRequest): readonly string[] {
  const sessionId = request.providerSession.sessionId ?? request.providerSession.threadId
  return [
    ...commonArguments(request),
    ...(request.mode === 'exec' ? (CLAUDE_AGENT.prompt.headlessArgs ?? ['--print']) : []),
    ...(sessionId === undefined ? ['--continue'] : ['--resume', sessionId]),
    ...(request.prompt === undefined ? [] : [request.prompt]),
  ]
}

export function createClaudeAdapter(options: ClaudeAdapterOptions): CodingAgentAdapter {
  const createSessionId = options.createSessionId ?? randomUUID
  const adapter = createCliAgentAdapter({
    ...options,
    definition: CLAUDE_AGENT,
    buildLaunch(request) {
      const sessionId = createSessionId()
      const providerSession: ProviderSessionRef = { provider: CLAUDE_AGENT.id, sessionId }
      return {
        args: buildClaudeArguments(request, sessionId),
        providerSession,
      }
    },
    buildResumeLaunch: (request) => ({
      args: buildClaudeResumeArguments(request),
      providerSession: request.providerSession,
    }),
  })
  const resume = adapter.resume

  return {
    ...adapter,
    async resume(request) {
      if (request.providerSession.provider !== CLAUDE_AGENT.id) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: `Cannot resume a ${request.providerSession.provider} session with Claude Code.`,
            retryable: false,
          },
        }
      }
      if (resume === undefined) {
        return {
          ok: false,
          error: {
            code: 'CAPABILITY_NOT_AVAILABLE',
            message: 'This Claude Adapter does not support session resume.',
            retryable: false,
          },
        }
      }
      return resume(request)
    },
  }
}
