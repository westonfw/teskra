import { dirname } from 'node:path'

import { getLogger } from '../logger'
import type { DecisionService } from './decision-service'

/**
 * HandoffDegradedActions (TASK-130, teskra-tasks.md; ADR-0014 §3; Milestone 25
 * design doc §9.2) — executes the resolution of a `handoff_degraded` decision.
 *
 * `open_raw` reveals the directory holding the preserved raw handoff through
 * the injected shell adapter (the composition root passes Electron's
 * shell.openPath — the Runtime never imports electron). `dismiss` is the
 * no-op, and also the §9.1 timeout default.
 */

export interface HandoffDegradedActionsDeps {
  readonly decisions: Pick<DecisionService, 'onResolved'>
  /** Electron shell.openPath adapter; absent outside the desktop shell. */
  readonly openPath?: ((path: string) => Promise<string>) | undefined
}

export interface HandoffDegradedActions {
  /** Detaches the decision subscription. */
  dispose(): void
}

export function createHandoffDegradedActions(
  deps: HandoffDegradedActionsDeps,
): HandoffDegradedActions {
  const logger = getLogger('agent')

  const unsubscribe = deps.decisions.onResolved('handoff_degraded', (decision) => {
    if (decision.resolution?.optionId !== 'open_raw') return
    if (decision.detail.kind !== 'handoff_degraded') return
    if (deps.openPath === undefined) {
      logger.warn(
        { decisionId: decision.id },
        'open_raw was resolved but no shell openPath adapter is available.',
      )
      return
    }
    const directory = dirname(decision.detail.rawPath)
    void deps.openPath(directory).then((failure) => {
      // shell.openPath resolves with '' on success, an error text otherwise.
      if (failure.length > 0) {
        logger.error(
          { decisionId: decision.id, directory, failure },
          'Failed to open the raw handoff directory.',
        )
      }
    })
  })

  return {
    dispose() {
      unsubscribe()
    },
  }
}
