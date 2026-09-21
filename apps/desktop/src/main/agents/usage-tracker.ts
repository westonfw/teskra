import type { AgentUsageObservation, UsageSource, WorkbenchEvents } from '@teskra/contracts'

import type { UsageRepository } from '../db/repositories/usage-repository'
import type { EventBus } from '../events/event-bus'
import { getLogger } from '../logger'

export interface UsageTrackerDeps {
  readonly usage: Pick<UsageRepository, 'upsertAdd'>
  readonly events: EventBus<WorkbenchEvents>
  readonly now?: () => string
}

/**
 * TASK-124 (Milestone 25 §7 / ADR-0013): the consumption side of the
 * ObservationRecorder's `onUsage` hook. Every usage observation — Claude's
 * single `result`-carried report or one per Codex `turn.completed` —
 * accumulates into the run's single `agent_run_usage` row and broadcasts
 * `usage.updated` so the Run detail / account cards refresh live.
 *
 * Observation-only, same discipline as the recorder itself: a persistence
 * failure is logged and swallowed, never thrown back into the parser path,
 * and usage never feeds rate-limit decisions (ADR-0010).
 */
export interface UsageTracker {
  record(runId: string, observation: AgentUsageObservation, source: UsageSource): void
}

export function createUsageTracker(deps: UsageTrackerDeps): UsageTracker {
  const logger = getLogger('agent')
  return {
    record(runId, observation, source) {
      const added = deps.usage.upsertAdd(
        {
          runId,
          source,
          ...(observation.model === undefined ? {} : { model: observation.model }),
          inputTokens: observation.inputTokens,
          outputTokens: observation.outputTokens,
          cacheReadTokens: observation.cacheReadTokens,
          cacheWriteTokens: observation.cacheWriteTokens,
          ...(observation.costUsdMicros === undefined
            ? {}
            : { costUsdMicros: observation.costUsdMicros }),
        },
        deps.now?.(),
      )
      if (!added.ok) {
        logger.error(
          { runId, error: added.error },
          'Failed to accumulate a usage observation; the row update is dropped.',
        )
        return
      }
      deps.events.emit('usage.updated', { runId, usage: added.data })
    },
  }
}
