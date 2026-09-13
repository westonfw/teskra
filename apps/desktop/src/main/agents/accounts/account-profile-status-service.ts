import type {
  AccountProfileStatus,
  AgentAccountProfile,
  IpcResult,
  WorkbenchEvents,
} from '@teskra/contracts'

import type { AccountProfileRepository, AgentRunRepository } from '../../db/repositories'
import type { EventBus } from '../../events/event-bus'
import { getLogger } from '../../logger'

/**
 * AccountProfileStatusService (TASK-097 skeleton, projection: TASK-106) —
 * §18 Profile Health and §18.0 "lazy degrade + light sweep".
 *
 * Projection (§18, TASK-106): a terminal Run outcome is projected onto its
 * account profile (start() subscribes to agent.completed / agent.failed):
 *
 *   completed                              → ready + lastSuccessfulAt
 *   failed + rate-limited                  → limited + limitedUntil (resetAt)
 *   failed + authentication-required       → login-required
 *   failed + authentication-expired        → expired
 *   failed + any other / no classification → health timestamps only
 *
 * `consecutiveFailures` from the §18 sketch is deliberately NOT persisted:
 * the table has no column for it and the first phase does not gate on it —
 * lastSuccessfulAt / lastFailureAt carry the same signal losslessly enough.
 *
 * §18.0 recovery of expired `limited` rows (degrade target: `unknown`,
 * never `ready` — only the official CLI may assert readiness):
 *
 * Lazy (main path): degradeExpiredLimited() is the write-through view every
 * reader (list / get / selector candidate) applies to a profile it touched.
 * Sweep (auxiliary): sweepExpiredLimited() rewrites stale rows in bulk — call
 * it at app startup and when Settings → Accounts opens. No timers anywhere.
 */

export interface AccountProfileStatusService {
  /** Read-side view: an expired `limited` reads as `unknown` (§18.0). */
  effectiveStatus(profile: AgentAccountProfile, now?: string): AccountProfileStatus
  /**
   * §18.0 lazy path, write-through: an expired `limited` row is degraded to
   * `unknown` with limitedUntil cleared (and persisted) the moment anyone
   * reads it; every other profile passes through untouched.
   */
  degradeExpiredLimited(profile: AgentAccountProfile, now?: string): IpcResult<AgentAccountProfile>
  /** Batch-degrades every expired `limited` row; returns how many changed. */
  sweepExpiredLimited(now?: string): Promise<IpcResult<number>>
  /**
   * §18 projection of one terminal Run (completed / failed) onto the account
   * profile it ran with. Runs without a profile (legacy), non-terminal runs,
   * and deleted profiles are no-ops. Status transitions emit
   * account.status_changed; limited / login-required additionally emit their
   * dedicated §42 events.
   */
  projectRunOutcome(runId: string): IpcResult<void>
  /** Starts the agent.completed / agent.failed projection subscriptions. */
  start(): void
  /** Detaches the projection subscriptions (shutdown, before the DB closes). */
  dispose(): void
}

export interface AccountProfileStatusServiceDeps {
  readonly profiles: AccountProfileRepository
  readonly runs: Pick<AgentRunRepository, 'getById'>
  readonly events: EventBus<WorkbenchEvents>
  readonly now?: () => string
}

export function isLimitedExpired(profile: AgentAccountProfile, now: string): boolean {
  return (
    profile.status === 'limited' &&
    profile.limitedUntil !== undefined &&
    profile.limitedUntil <= now
  )
}

export function createAccountProfileStatusService(
  deps: AccountProfileStatusServiceDeps,
): AccountProfileStatusService {
  const logger = getLogger('agent')
  const now = deps.now ?? ((): string => new Date().toISOString())
  let stopProjection: (() => void) | undefined

  const emitStatusChanged = (profile: AgentAccountProfile, status: AccountProfileStatus): void => {
    if (status !== profile.status) {
      deps.events.emit('account.status_changed', {
        profileId: profile.id,
        agentId: profile.agentId,
        status,
        previousStatus: profile.status,
      })
    }
  }

  const degradeExpiredLimited = (
    profile: AgentAccountProfile,
    at?: string,
  ): IpcResult<AgentAccountProfile> => {
    if (!isLimitedExpired(profile, at ?? now())) {
      return { ok: true, data: profile }
    }
    const updated = deps.profiles.setStatus(profile.id, {
      status: 'unknown',
      limitedUntil: null,
    })
    if (!updated.ok) {
      return updated
    }
    // The row vanished between read and degrade: keep serving what was read.
    if (updated.data === null) {
      return { ok: true, data: profile }
    }
    emitStatusChanged(profile, 'unknown')
    return { ok: true, data: updated.data }
  }

  const projectRunOutcome = (runId: string): IpcResult<void> => {
    const run = deps.runs.getById(runId)
    if (!run.ok) {
      return run
    }
    const record = run.data
    if (
      record === null ||
      record.accountProfileId === undefined ||
      (record.status !== 'completed' && record.status !== 'failed')
    ) {
      return { ok: true, data: undefined }
    }
    const found = deps.profiles.getById(record.accountProfileId)
    if (!found.ok) {
      return found
    }
    const profile = found.data
    // §47 soft-disable keeps the row, but a hard-deleted one is simply gone.
    if (profile === null) {
      return { ok: true, data: undefined }
    }
    const at = now()

    if (record.status === 'completed') {
      // §18.0: a successful Run is one of the two writers of `ready`.
      const updated = deps.profiles.setStatus(profile.id, {
        status: 'ready',
        limitedUntil: null,
        lastUsedAt: at,
        lastSuccessfulAt: at,
      })
      if (!updated.ok) {
        return updated
      }
      emitStatusChanged(profile, 'ready')
      return { ok: true, data: undefined }
    }

    const health = { lastUsedAt: at, lastFailureAt: at } as const
    const classification = record.failureClassification
    switch (classification?.kind) {
      case 'rate-limited': {
        const updated = deps.profiles.setStatus(profile.id, {
          status: 'limited',
          ...(classification.resetAt === undefined ? {} : { limitedUntil: classification.resetAt }),
          ...health,
        })
        if (!updated.ok) {
          return updated
        }
        emitStatusChanged(profile, 'limited')
        deps.events.emit('account.limited', {
          profileId: profile.id,
          agentId: profile.agentId,
          ...(classification.resetAt === undefined ? {} : { limitedUntil: classification.resetAt }),
        })
        return { ok: true, data: undefined }
      }
      case 'authentication-required': {
        const updated = deps.profiles.setStatus(profile.id, {
          status: 'login-required',
          ...health,
        })
        if (!updated.ok) {
          return updated
        }
        emitStatusChanged(profile, 'login-required')
        deps.events.emit('account.login_required', {
          profileId: profile.id,
          agentId: profile.agentId,
        })
        return { ok: true, data: undefined }
      }
      case 'authentication-expired': {
        const updated = deps.profiles.setStatus(profile.id, {
          status: 'expired',
          ...health,
        })
        if (!updated.ok) {
          return updated
        }
        emitStatusChanged(profile, 'expired')
        return { ok: true, data: undefined }
      }
      default: {
        // network / permission / process-crash / unknown / unclassified:
        // account-agnostic failures only move the health timestamps.
        const updated = deps.profiles.setStatus(profile.id, {
          status: profile.status,
          ...health,
        })
        if (!updated.ok) {
          return updated
        }
        return { ok: true, data: undefined }
      }
    }
  }

  return {
    effectiveStatus(profile, at) {
      return isLimitedExpired(profile, at ?? now()) ? 'unknown' : profile.status
    },

    degradeExpiredLimited,

    sweepExpiredLimited(at) {
      const clock = at ?? now()
      const limited = deps.profiles.list({ status: 'limited' })
      if (!limited.ok) {
        return Promise.resolve(limited)
      }
      let swept = 0
      for (const profile of limited.data) {
        if (!isLimitedExpired(profile, clock)) {
          continue
        }
        const degraded = degradeExpiredLimited(profile, clock)
        if (!degraded.ok) {
          return Promise.resolve(degraded)
        }
        swept += 1
      }
      return Promise.resolve({ ok: true, data: swept })
    },

    projectRunOutcome,

    start() {
      if (stopProjection !== undefined) {
        return
      }
      const onTerminal = (runId: string): void => {
        const projected = projectRunOutcome(runId)
        if (!projected.ok) {
          logger.error(
            { runId, error: projected.error },
            'Failed to project the Run outcome onto the account profile.',
          )
        }
      }
      const stopCompleted = deps.events.subscribe('agent.completed', ({ runId }) =>
        onTerminal(runId),
      )
      const stopFailed = deps.events.subscribe('agent.failed', ({ runId }) => onTerminal(runId))
      stopProjection = () => {
        stopCompleted()
        stopFailed()
      }
    },

    dispose() {
      stopProjection?.()
      stopProjection = undefined
    },
  }
}
