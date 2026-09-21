import type {
  AgentResumeProfileContext,
  AgentResumeRequest,
  AgentStartRequest,
  IpcResult,
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
  structuredOutputArguments,
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
    // TASK-122 (§6.1): `--json` follows the `exec` subcommand, before the prompt.
    ...structuredOutputArguments(request),
    ...(request.prompt === undefined ? [] : [request.prompt]),
  ]
}

export function buildCodexResumeArguments(
  request: AgentResumeRequest,
  profile?: CodexResumeProfileContext,
): readonly string[] {
  const sessionId = request.providerSession.sessionId ?? request.providerSession.threadId
  // §10.5 (2): never fall back to `--last` for an account-profile run — it
  // picks the last session in whatever CODEX_HOME is active, very likely
  // another run's. Callers must gate on validateCodexResumeProfile() first;
  // omitting the flag here keeps even an ungated call from silently resuming
  // the wrong account's session (the CLI errors out instead of guessing).
  const lastFallbackAllowed = profile?.accountProfileId === undefined
  return [
    ...commonArguments(request),
    ...(request.mode === 'exec' ? (CODEX_AGENT.prompt.headlessArgs ?? ['exec']) : []),
    ...structuredOutputArguments(request),
    'resume',
    ...(sessionId !== undefined ? [sessionId] : lastFallbackAllowed ? ['--last'] : []),
    ...(request.prompt === undefined ? [] : [request.prompt]),
  ]
}

/**
 * Milestone 24 §10.5 — the profile context a Codex resume must be validated
 * against. Codex sessions live under CODEX_HOME, so per-profile homes change
 * what a resume can even see. The AgentManager populates
 * `AgentResumeRequest.resumeProfileContext` from the run row (profileSnapshot
 * + freshly resolved profile, TASK-100); this module owns the rules.
 */
export type CodexResumeProfileContext = AgentResumeProfileContext

export function validateCodexResumeProfile(
  request: AgentResumeRequest,
  profile: CodexResumeProfileContext,
): IpcResult<void> {
  if (profile.accountProfileId === undefined) {
    return { ok: true, data: undefined }
  }
  // §10.5 (1): a profile switch makes the recorded session unreachable.
  // Refuse loudly instead of letting the CLI fail ambiguously — the designed
  // path forward is a Continuation run with the new profile (§39).
  if (profile.snapshotConfigHome !== profile.currentConfigHome) {
    return {
      ok: false,
      error: {
        code: 'CONFLICT',
        message:
          'This session belongs to a different account profile and cannot be resumed. Start a Continuation run with the new profile instead.',
        retryable: false,
      },
    }
  }
  const sessionId = request.providerSession.sessionId ?? request.providerSession.threadId
  if (sessionId === undefined) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message:
          'This run has no recorded Codex session id; the --last fallback is disabled for account-profile runs.',
        retryable: false,
      },
    }
  }
  return { ok: true, data: undefined }
}

export function createCodexAdapter(options: CodexAdapterOptions): CodingAgentAdapter {
  const adapter = createCliAgentAdapter({
    ...options,
    definition: CODEX_AGENT,
    buildLaunch: (request) => ({
      args: buildCodexArguments(request),
      providerSession: { provider: CODEX_AGENT.id },
    }),
    buildResumeLaunch: (request) => ({
      args: buildCodexResumeArguments(request, request.resumeProfileContext),
    }),
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
      // §10.5: validate the historical profile identity BEFORE building argv —
      // a configHome mismatch or a missing session id for a profile run is a
      // loud refusal, never a CLI-ambiguous failure or a --last guess.
      const profileCheck = validateCodexResumeProfile(request, request.resumeProfileContext ?? {})
      if (!profileCheck.ok) {
        return profileCheck
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
