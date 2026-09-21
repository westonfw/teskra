import type { AgentProgressEvent, DecisionOption } from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { DecisionService } from '../decisions/decision-service'
import { getLogger } from '../logger'
import type { AgentManager } from './agent-manager'

/**
 * AgentBlockerDecisionBridge (TASK-130, teskra-tasks.md; ADR-0014 §3; Milestone
 * 25 design doc §9.2) — the agent_blocker decision source.
 *
 * The TASK-126 ProgressFollower reports every persisted blocker / question
 * progress event through `report()` (its `onBlocker` hook); the bridge opens a
 * persisted `agent_blocker` PendingDecision — `blocker` with severity
 * 'warning', `question` with 'info'. Progress stays observation-only
 * (ADR-0012/ADR-0013): opening the decision never touches the Run's status.
 *
 * The resolution actions live here (ADR-0014 §3): `stop` cancels the run
 * through AgentManager.cancel; `acknowledge` (also the §9.1 timeout default)
 * is the no-op — the closed row is the acknowledgement.
 */

export interface AgentBlockerDecisionBridgeDeps {
  readonly decisions: Pick<DecisionService, 'open' | 'onResolved'>
  /** Supplies the decision's workspaceId; the reporting run may already be gone. */
  readonly runs: Pick<AgentRunRepository, 'getById'>
  readonly agents: Pick<AgentManager, 'cancel'>
}

export interface AgentBlockerDecisionBridge {
  /** ProgressFollower `onBlocker` entry; never throws, never blocks progress. */
  report(runId: string, event: AgentProgressEvent): void
  /** Detaches the decision subscription; idempotent via DecisionService. */
  dispose(): void
}

/** §9.2 vocabulary; no "remember my choice" option exists (ADR-0014 §7). */
const AGENT_BLOCKER_OPTIONS: readonly DecisionOption[] = [
  { id: 'acknowledge', label: 'Acknowledge' },
  { id: 'stop', label: 'Stop the run' },
]

export function createAgentBlockerDecisionBridge(
  deps: AgentBlockerDecisionBridgeDeps,
): AgentBlockerDecisionBridge {
  const logger = getLogger('agent')

  const unsubscribe = deps.decisions.onResolved('agent_blocker', (decision) => {
    if (decision.resolution?.optionId !== 'stop') return
    const runId = decision.runId
    if (runId === undefined) return
    void deps.agents.cancel(runId).then((cancelled) => {
      if (!cancelled.ok) {
        logger.warn(
          { runId, error: cancelled.error },
          'Failed to cancel a run from an agent-blocker decision.',
        )
      }
    })
  })

  return {
    report(runId, event) {
      if (event.kind !== 'blocker' && event.kind !== 'question') return
      const run = deps.runs.getById(runId)
      if (!run.ok) {
        logger.error(
          { runId, error: run.error },
          'Failed to read the reporting run; no agent_blocker decision opened.',
        )
        return
      }
      if (run.data === null) {
        // The run is already gone (retention) — nothing left to decide about.
        logger.warn({ runId }, 'A blocker/question arrived for an unknown run; no decision opened.')
        return
      }
      // One open row per distinct reported text (ADR-0014 §2): an agent
      // repeating the same blocker does not re-notify while it is still open.
      const opened = deps.decisions.open({
        workspaceId: run.data.workspaceId,
        kind: 'agent_blocker',
        severity: event.kind === 'blocker' ? 'warning' : 'info',
        dedupeKey: `agent_blocker:${runId}:${event.kind}:${event.message}`,
        title:
          event.kind === 'blocker' ? 'The Agent reported a blocker' : 'The Agent asked a question',
        detail: { kind: 'agent_blocker', text: event.message },
        options: AGENT_BLOCKER_OPTIONS,
        runId,
      })
      if (!opened.ok) {
        logger.error({ runId, error: opened.error }, 'Failed to open the agent-blocker decision.')
      }
    },
    dispose() {
      unsubscribe()
    },
  }
}
