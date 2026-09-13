import type {
  AgentResumeRequest,
  AgentStartRequest,
  TeskraPermissionProfile,
} from '@teskra/contracts'

import { CODEX_AGENT } from '../definitions/codex'
import {
  CODEX_PERMISSION_MAPPING,
  permissionProfileForApprovalMode,
} from '../permissions/permission-projection'
import {
  agentHandoffDir,
  createCliAgentAdapter,
  type CliAgentAdapterOptions,
} from './cli-agent-adapter'
import type { CodingAgentAdapter } from './coding-agent-adapter'

export type CodexAdapterOptions = Omit<
  CliAgentAdapterOptions,
  'definition' | 'baseArgs' | 'buildLaunch' | 'buildResumeLaunch'
>

/** TASK-077: approval/sandbox args come from the shared policy projection mapping. */
function profileFor(request: AgentStartRequest): TeskraPermissionProfile {
  return (
    request.permissionProfile ??
    permissionProfileForApprovalMode(CODEX_AGENT.id, request.approvalMode ?? 'safe-auto')
  )
}

function permissionArguments(profile: TeskraPermissionProfile): string[] {
  return CODEX_PERMISSION_MAPPING.buildArgs?.(profile) ?? []
}

/**
 * ADR-0004: Codex's `workspace-write` sandbox covers only the workdir, so the
 * Run directory (handoff + artifacts) must be granted as an extra writable
 * root — otherwise the agent cannot write its handoff at all (observed on a
 * real run: both apply_patch and direct writes were denied). Verified against
 * codex CLI 0.154.0: `-c sandbox_workspace_write.writable_roots=[...]` must
 * precede the `exec` subcommand. The read-only sandbox has no writable-root
 * mechanism, so reviewers use the snapshot isolation tier instead.
 */
function writableRootArguments(
  profile: TeskraPermissionProfile,
  request: AgentStartRequest,
): string[] {
  const handoffDir = agentHandoffDir(request)
  if (handoffDir === undefined || profile.approvalMode === 'read-only') {
    return []
  }
  return ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(handoffDir)}]`]
}

function commonArguments(request: AgentStartRequest): string[] {
  const profile = profileFor(request)
  return [
    ...permissionArguments(profile),
    ...writableRootArguments(profile, request),
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
