import type {
  AgentAccountProfile,
  AgentRun,
  ErrorCode,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'
import { ACCOUNT_LIMITED_DEFAULT_DURATION_MS } from '@teskra/contracts'

/**
 * TASK-108 (Milestone 24 §26/§37) — candidate filtering for the
 * "Continue with another account" modal. Mirrors the Main-side §37 step 0
 * rules (account-profile-runtime-resolver.isRuntimeCompatible) so the list
 * only ever offers profiles the §37 selector would accept.
 */

/** §37 step 0 — kind must match; wsl additionally requires the same distro. */
export function runtimeCompatible(
  profileRuntime: WorkspaceRuntimeRef,
  workspaceRuntime: WorkspaceRuntimeRef,
): boolean {
  if (profileRuntime.kind !== workspaceRuntime.kind) return false
  if (profileRuntime.kind !== 'wsl') return true
  return (
    (profileRuntime.distro ?? '').toLowerCase() === (workspaceRuntime.distro ?? '').toLowerCase()
  )
}

/**
 * A profile is offerable when it is enabled, runtime-compatible, and currently
 * usable (`ready` / `unknown`). A row still marked `limited` whose
 * `limitedUntil` has already passed is also offerable: §18.0's lazy sweep
 * demotes it on the next account.list, and the modal always refreshes before
 * judging, so an expired limit must not exclude the profile forever. A
 * `limited` row without `limitedUntil` is judged by the same §18.0 default
 * window as the Main-side isLimitedExpired: it becomes offerable once its
 * `lastFailureAt` is older than ACCOUNT_LIMITED_DEFAULT_DURATION_MS (or
 * immediately when no timestamp exists), so a provider message without a
 * parseable reset time can never exclude the profile permanently (P1-3).
 */
export function isContinuationCandidate(
  profile: AgentAccountProfile,
  workspaceRuntime: WorkspaceRuntimeRef,
  now: number,
): boolean {
  if (!profile.enabled) return false
  if (!runtimeCompatible(profile.runtime, workspaceRuntime)) return false
  if (profile.status === 'ready' || profile.status === 'unknown') return true
  if (profile.status === 'limited') {
    if (profile.limitedUntil !== undefined) {
      return Date.parse(profile.limitedUntil) <= now
    }
    if (profile.lastFailureAt === undefined) return true
    const failedAt = Date.parse(profile.lastFailureAt)
    return Number.isNaN(failedAt) || failedAt + ACCOUNT_LIMITED_DEFAULT_DURATION_MS <= now
  }
  return false
}

export interface ContinuationCandidateGroups {
  /** Available profiles of the source run's Agent (excluding the limited one). */
  readonly sameAgent: readonly AgentAccountProfile[]
  /** Available profiles of every other Agent — cross-Agent continuation. */
  readonly crossAgent: readonly AgentAccountProfile[]
}

/**
 * §26 — the two sections of the Continue modal. The source run's own account
 * is never a candidate (that is what "another account" means; Retry covers
 * reusing it).
 */
export function groupContinuationCandidates(
  profiles: readonly AgentAccountProfile[],
  source: Pick<AgentRun, 'agentType' | 'accountProfileId'>,
  workspaceRuntime: WorkspaceRuntimeRef,
  now: number,
): ContinuationCandidateGroups {
  const candidates = profiles.filter(
    (profile) =>
      profile.id !== source.accountProfileId &&
      isContinuationCandidate(profile, workspaceRuntime, now),
  )
  return {
    sameAgent: candidates.filter((profile) => profile.agentId === source.agentType),
    crossAgent: candidates.filter((profile) => profile.agentId !== source.agentType),
  }
}

/**
 * §19.3 — a continuation that fails because the source process would not stop
 * (CONFLICT / COMMAND_TIMEOUT) gets one dedicated message; every other code
 * (ACCOUNT_PROFILE_* included) falls back to the generic AppErrorAlert, which
 * already localizes the concrete reason via errorSuggestion.*.
 */
export function continuationSourceStopFailed(code: ErrorCode): boolean {
  return code === 'CONFLICT' || code === 'COMMAND_TIMEOUT'
}
