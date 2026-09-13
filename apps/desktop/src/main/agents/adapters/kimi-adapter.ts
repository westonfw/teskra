import type {
  AgentResumeRequest,
  AgentStartRequest,
  TeskraPermissionProfile,
} from '@teskra/contracts'

import { KIMI_AGENT } from '../definitions/kimi'
import {
  KIMI_PERMISSION_MAPPING,
  permissionProfileForApprovalMode,
} from '../permissions/permission-projection'
import { createCliAgentAdapter, type CliAgentAdapterOptions } from './cli-agent-adapter'
import type { CodingAgentAdapter } from './coding-agent-adapter'

export type KimiAdapterOptions = Omit<
  CliAgentAdapterOptions,
  'definition' | 'baseArgs' | 'buildLaunch' | 'buildResumeLaunch'
>

function profileFor(request: AgentStartRequest): TeskraPermissionProfile {
  return (
    request.permissionProfile ??
    permissionProfileForApprovalMode(KIMI_AGENT.id, request.approvalMode ?? 'safe-auto')
  )
}

function permissionArguments(profile: TeskraPermissionProfile): string[] {
  return KIMI_PERMISSION_MAPPING.buildArgs?.(profile) ?? []
}

/**
 * TASK-026: Kimi CLI argument construction lives exclusively in this Adapter.
 *
 * `kimi --prompt` rejects `--plan` / `--yolo` / `--auto` (non-interactive runs
 * always use the CLI's own auto permission policy), so headless launches omit
 * the permission flags; interactive launches get them. The interactive TUI has
 * no positional-prompt form, so an initial prompt only travels in `--prompt`
 * (headless) mode.
 */
export function buildKimiArguments(request: AgentStartRequest): readonly string[] {
  const headless = request.mode === 'exec'
  return [
    ...(headless ? [] : permissionArguments(profileFor(request))),
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(headless ? (KIMI_AGENT.prompt.headlessArgs ?? ['--prompt']) : []),
    ...(headless && request.prompt !== undefined ? [request.prompt] : []),
  ]
}

/** Resume: `--session <id>` for a known session, `--continue` for the latest. */
export function buildKimiResumeArguments(request: AgentResumeRequest): readonly string[] {
  const sessionId = request.providerSession.sessionId ?? request.providerSession.threadId
  const headless = request.mode === 'exec'
  return [
    ...(headless ? [] : permissionArguments(profileFor(request))),
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(sessionId === undefined ? ['--continue'] : ['--session', sessionId]),
    ...(headless ? (KIMI_AGENT.prompt.headlessArgs ?? ['--prompt']) : []),
    ...(headless && request.prompt !== undefined ? [request.prompt] : []),
  ]
}

export function createKimiAdapter(options: KimiAdapterOptions): CodingAgentAdapter {
  const adapter = createCliAgentAdapter({
    ...options,
    definition: KIMI_AGENT,
    buildLaunch: (request) => ({
      args: buildKimiArguments(request),
      providerSession: { provider: KIMI_AGENT.id },
    }),
    buildResumeLaunch: (request) => ({ args: buildKimiResumeArguments(request) }),
  })
  const resume = adapter.resume

  return {
    ...adapter,
    async resume(request) {
      if (request.providerSession.provider !== KIMI_AGENT.id) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: `Cannot resume a ${request.providerSession.provider} session with Kimi Code.`,
            retryable: false,
          },
        }
      }
      if (resume === undefined) {
        return {
          ok: false,
          error: {
            code: 'CAPABILITY_NOT_AVAILABLE',
            message: 'This Kimi Adapter does not support session resume.',
            retryable: false,
          },
        }
      }
      return resume(request)
    },
  }
}
