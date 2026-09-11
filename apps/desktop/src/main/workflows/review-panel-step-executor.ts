import type { WorkbenchEvents } from '@teskra/contracts'

import type { ReviewPanelService } from '../agents/review-panel-service'
import type { EventBus } from '../events/event-bus'
import type { WorkflowStepExecution, WorkflowStepExecutor } from './workflow-engine'

/**
 * ReviewPanelStepExecutor (TASK-060) — drives a workflow definition's
 * `review-panel` node through ReviewPanelService instead of parking the step
 * for an external resolveStep: the node's `agents` become the panel's
 * reviewers, the pass context's worktree (when present) becomes the review
 * target, and the step settles when the panel converges.
 *
 * Cancel routing: startPanel settles only AFTER the panel converges, but it
 * emits 'review.panel_updated' synchronously when the panel row is created.
 * The executor captures the panel id from that event (matched through
 * getPanel's workflowRunId link) so WorkflowEngine.cancel reaches the panel's
 * reviewer runs while they are still in flight — waiting for startPanel to
 * resolve would make every cancel a no-op.
 *
 * Outcome mapping (WORKFLOW_CONDITION_OUTCOMES allows 'approve' |
 * 'changes_requested' for review-panel nodes): a panel whose consensus is
 * 'approve' yields 'approve'; 'changes_requested' / 'mixed' yield
 * 'changes_requested'; a panel that failed to converge fails the step.
 * Review panels review a Task's implementation, so a task-less WorkflowRun
 * (ADR-0006) cannot execute this node.
 */
export function createReviewPanelStepExecutor(deps: {
  readonly panel: Pick<ReviewPanelService, 'startPanel' | 'cancelPanel' | 'getPanel'>
  readonly events: EventBus<WorkbenchEvents>
}): WorkflowStepExecutor {
  /** stepId → panelId, for cancel routing. */
  const panels = new Map<string, string>()
  /** Panel ids already bound to a step — a panel must not be claimed twice. */
  const claimed = new Set<string>()
  /** stepIds cancelled before their panel id was captured. */
  const cancelRequested = new Set<string>()

  return {
    async execute({ run, step, node, context }: WorkflowStepExecution) {
      if (node.type !== 'review-panel') {
        return {
          outcome: 'failure',
          result: { error: 'review-panel executor received a non-review-panel node' },
        }
      }
      if (run.taskId === undefined) {
        return {
          outcome: 'failure',
          result: { error: 'A review-panel node requires a task-bound workflow run.' },
        }
      }
      const capture = deps.events.subscribe('review.panel_updated', ({ panelId }) => {
        if (panels.has(step.id) || claimed.has(panelId)) return
        const found = deps.panel.getPanel(panelId)
        if (!found.ok || found.data === null) return
        if (found.data.panel.workflowRunId !== run.id) return
        claimed.add(panelId)
        panels.set(step.id, panelId)
        // The engine already cancelled this step: forward it immediately.
        if (cancelRequested.has(step.id)) {
          deps.panel.cancelPanel(panelId)
        }
      })
      try {
        const started = await deps.panel.startPanel({
          workspaceId: context.workspaceId,
          taskId: run.taskId,
          reviewers: node.agents,
          workflowRunId: run.id,
          ...(context.worktreeId === undefined ? {} : { targetWorktreeId: context.worktreeId }),
        })
        if (!started.ok) {
          return { outcome: 'failure', result: { error: started.error.message } }
        }
        const { panel } = started.data
        panels.set(step.id, panel.id)
        if (panel.status !== 'completed') {
          return {
            outcome: 'failure',
            result: { panelId: panel.id, error: 'The review panel did not converge.' },
          }
        }
        const consensus = panel.consensus ?? 'mixed'
        const verdict = panel.aggregate?.verdict
        return {
          outcome: consensus === 'approve' ? 'approve' : 'changes_requested',
          result: { panelId: panel.id, consensus, ...(verdict === undefined ? {} : { verdict }) },
        }
      } finally {
        capture()
        const captured = panels.get(step.id)
        if (captured !== undefined) claimed.delete(captured)
        panels.delete(step.id)
        cancelRequested.delete(step.id)
      }
    },

    cancel(stepId) {
      const panelId = panels.get(stepId)
      if (panelId === undefined) {
        cancelRequested.add(stepId)
        return
      }
      deps.panel.cancelPanel(panelId)
    },
  }
}
