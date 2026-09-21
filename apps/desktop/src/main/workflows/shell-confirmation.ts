import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'

/**
 * ShellStepConfirmationService (TASK-118; code-review P0-3 suggestion 3).
 *
 * A shell workflow step whose command originates from repo-controlled content
 * (`ShellWorkflowNode.requireConfirmation`) must not execute silently: the
 * executor parks on `request()`, the full command line goes out as a
 * `workflow.shell_confirmation_required` event, and the step only proceeds
 * when the user answers through `resolve()` (WorkflowPort.confirmShellStep).
 *
 * Mirrors the engine's suspended-step pattern (checkpoint / criteria-gate)
 * but lives outside the DAG: a parked shell step is still `running`, so the
 * engine's cancel path reaches it via the executor's cancel hook, which must
 * settle the pending request (rejected) or the pass would hang.
 */

export interface ShellConfirmationDetails {
  readonly runId: string
  readonly stepId: string
  readonly nodeId: string
  /** The complete command line exactly as it will execute. */
  readonly command: string
  readonly cwd: string
}

export interface ShellConfirmationService {
  /** Emits the confirmation event and parks until resolve() / cancel(). */
  request(details: ShellConfirmationDetails): Promise<boolean>
  /** User decision; false when no confirmation was pending for the step. */
  resolve(stepId: string, approved: boolean): IpcResult<boolean>
  /** Settles a pending request as rejected (executor cancel path). */
  cancel(stepId: string): void
  /**
   * Code-review P1-6: everything still parked, so a renderer that (re)subscribes
   * after the event already fired can pull the backlog instead of missing it.
   */
  listPending(): readonly ShellConfirmationDetails[]
  /** Rejects everything pending; composition-root shutdown. */
  dispose(): void
}

export interface ShellConfirmationServiceDeps {
  readonly events: EventBus<WorkbenchEvents>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

export function createShellConfirmationService(
  deps: ShellConfirmationServiceDeps,
): ShellConfirmationService {
  const logger = getLogger('security')
  /** stepId → parked request: the details (for listPending) + its settle fn. */
  const pending = new Map<
    string,
    { details: ShellConfirmationDetails; settle: (approved: boolean) => void }
  >()

  const settle = (stepId: string, approved: boolean): boolean => {
    const parked = pending.get(stepId)
    if (parked === undefined) return false
    pending.delete(stepId)
    parked.settle(approved)
    return true
  }

  return {
    request(details) {
      logger.warn(
        {
          runId: details.runId,
          stepId: details.stepId,
          nodeId: details.nodeId,
          command: details.command,
          cwd: details.cwd,
        },
        'A repo-defined shell step awaits user confirmation before execution.',
      )
      deps.events.emit('workflow.shell_confirmation_required', {
        runId: details.runId,
        stepId: details.stepId,
        nodeId: details.nodeId,
        command: details.command,
        cwd: details.cwd,
      })
      return new Promise<boolean>((resolvePromise) => {
        pending.set(details.stepId, { details, settle: resolvePromise })
      })
    },

    resolve(stepId, approved) {
      if (!settle(stepId, approved)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'This shell step is not awaiting a confirmation.',
          retryable: false,
          detail: `confirmShellStep step=${stepId}: no pending shell confirmation`,
        })
      }
      logger.info({ stepId, approved }, 'Shell step confirmation resolved.')
      return { ok: true, data: true }
    },

    cancel(stepId) {
      settle(stepId, false)
    },

    listPending() {
      return [...pending.values()].map((parked) => parked.details)
    },

    dispose() {
      for (const stepId of [...pending.keys()]) {
        settle(stepId, false)
      }
    },
  }
}
