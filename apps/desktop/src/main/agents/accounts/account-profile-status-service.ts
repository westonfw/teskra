import type {
  AccountProfileStatus,
  AgentAccountProfile,
  IpcResult,
  WorkbenchEvents,
} from '@teskra/contracts'

import type { AccountProfileRepository } from '../../db/repositories'
import type { EventBus } from '../../events/event-bus'

/**
 * AccountProfileStatusService (TASK-097 skeleton; full projection is
 * TASK-106's) — §18.0 "lazy degrade + light sweep" for `limited` profiles.
 *
 * A `limited` profile whose `limitedUntil` has passed must not stay excluded
 * from the selector forever ("quota recovered long ago but Teskra still says
 * unavailable"). It degrades to `unknown` — never directly to `ready`,
 * because only the official CLI can assert readiness.
 *
 * Lazy (main path): effectiveStatus() is the read-side view every consumer
 * (list / selector / switch list) should use.
 * Sweep (auxiliary): sweepExpiredLimited() rewrites stale rows in bulk — call
 * it at app startup and when Settings → Accounts opens.
 */

export interface AccountProfileStatusService {
  /** Read-side view: an expired `limited` reads as `unknown` (§18.0). */
  effectiveStatus(profile: AgentAccountProfile, now?: string): AccountProfileStatus
  /** Batch-degrades every expired `limited` row; returns how many changed. */
  sweepExpiredLimited(now?: string): Promise<IpcResult<number>>
}

export interface AccountProfileStatusServiceDeps {
  readonly profiles: AccountProfileRepository
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
  const now = deps.now ?? ((): string => new Date().toISOString())

  return {
    effectiveStatus(profile, at) {
      return isLimitedExpired(profile, at ?? now()) ? 'unknown' : profile.status
    },

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
        const updated = deps.profiles.setStatus(profile.id, {
          status: 'unknown',
          limitedUntil: null,
        })
        if (!updated.ok) {
          return Promise.resolve(updated)
        }
        swept += 1
        deps.events.emit('account.status_changed', {
          profileId: profile.id,
          agentId: profile.agentId,
          status: 'unknown',
          previousStatus: 'limited',
        })
      }
      return Promise.resolve({ ok: true, data: swept })
    },
  }
}
