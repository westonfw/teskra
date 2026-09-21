import type { DecisionOption, IpcResult, PendingDecision, WorkbenchEvents } from '@teskra/contracts'

import type { DecisionService } from '../decisions/decision-service'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'

/**
 * ShellStepConfirmationService (TASK-118; code-review P0-3 suggestion 3;
 * migrated to the Decision Inbox in TASK-129, ADR-0014).
 *
 * A shell workflow step whose command originates from repo-controlled content
 * (`ShellWorkflowNode.requireConfirmation`) must not execute silently: the
 * executor parks on `request()`, which first persists a `shell_confirmation`
 * PendingDecision (`dedupeKey` = stepId) and then parks the in-memory promise;
 * the full command line also goes out as the compat
 * `workflow.shell_confirmation_required` event (alongside `decision.opened`).
 * The step only proceeds when the decision is resolved — through
 * `resolve()` (WorkflowPort.confirmShellStep compat alias) or straight
 * through the decision channel (`teskra:decision:resolve`, e.g. the Inbox):
 * the `onResolved('shell_confirmation', …)` subscription settles the parked
 * promise either way. There is no "always allow" (ADR-0014 §7).
 *
 * The persisted row is the source of truth; memory only holds what cannot
 * be persisted — the settle fn, the decision id and the fields the compat
 * alias still serves. Timeout (`decisions.shellConfirmationTimeoutMs > 0`)
 * closes the row as `expired` via the watchdog tick, whose default action
 * (reject) settles the step as refused; startup reconciliation expires every
 * row still open after a restart, so it can never be approved again (the
 * in-memory promise did not survive — `resolve()` then answers
 * VALIDATION_FAILED).
 *
 * Mirrors the engine's suspended-step pattern (checkpoint / criteria-gate)
 * but lives outside the DAG: a parked shell step is still `running`, so the
 * engine's cancel path reaches it via the executor's cancel hook, which must
 * settle the pending request (rejected) or the pass would hang.
 */

export interface ShellConfirmationDetails {
  readonly workspaceId: string
  readonly runId: string
  readonly stepId: string
  readonly nodeId: string
  /** The complete command line exactly as it will execute. */
  readonly command: string
  readonly cwd: string
}

export interface ShellConfirmationService {
  /** Opens the decision, emits the events and parks until resolved / cancelled. */
  request(details: ShellConfirmationDetails): Promise<boolean>
  /** User decision; false when no confirmation was pending for the step. */
  resolve(stepId: string, approved: boolean): IpcResult<boolean>
  /** Settles a pending request as rejected (executor cancel path). */
  cancel(stepId: string): void
  /**
   * Code-review P1-6: everything still parked, so a renderer that (re)subscribes
   * after the event already fired can pull the backlog instead of missing it.
   * TASK-129: the decision channel is the authority on what is still open;
   * the in-memory map supplies insertion order and the compat fields.
   */
  listPending(): readonly ShellConfirmationDetails[]
  /** Rejects everything pending; composition-root shutdown. */
  dispose(): void
}

export interface ShellConfirmationServiceDeps {
  readonly events: EventBus<WorkbenchEvents>
  readonly decisions: Pick<
    DecisionService,
    'open' | 'resolve' | 'list' | 'cancelBySource' | 'onResolved'
  >
  /**
   * Reads `decisions.shellConfirmationTimeoutMs` for the workspace at request
   * time; absent / 0 = the confirmation never expires (ADR-0014 §4).
   */
  readonly resolveTimeoutMs?: (workspaceId: string) => number
}

/** §9.2 vocabulary; no "remember my choice" option exists (ADR-0014 §7). */
const SHELL_CONFIRMATION_OPTIONS: readonly DecisionOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
]

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function isApproval(decision: PendingDecision): boolean {
  return decision.status === 'resolved' && decision.resolution?.optionId === 'approve'
}

export function createShellConfirmationService(
  deps: ShellConfirmationServiceDeps,
): ShellConfirmationService {
  const logger = getLogger('security')
  /** stepId → parked request: settle fn + decision id + compat details. */
  const pending = new Map<
    string,
    { details: ShellConfirmationDetails; decisionId: string; settle: (approved: boolean) => void }
  >()

  const settle = (stepId: string, approved: boolean): boolean => {
    const parked = pending.get(stepId)
    if (parked === undefined) return false
    pending.delete(stepId)
    parked.settle(approved)
    return true
  }

  // The decision channel is the resolution path (ADR-0014 §3): a resolution
  // from any source — the compat IPC alias below, the Inbox, or a watchdog
  // expiry — settles the parked step promise here.
  const unsubscribeResolved = deps.decisions.onResolved('shell_confirmation', (decision) => {
    settle(decision.workflowStepId ?? decision.dedupeKey, isApproval(decision))
  })

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
      const opened = deps.decisions.open({
        workspaceId: details.workspaceId,
        kind: 'shell_confirmation',
        severity: 'blocking',
        dedupeKey: details.stepId,
        title: `Shell step "${details.nodeId}" requires confirmation`,
        detail: { kind: 'shell_confirmation', command: details.command, cwd: details.cwd },
        options: SHELL_CONFIRMATION_OPTIONS,
        workflowRunId: details.runId,
        workflowStepId: details.stepId,
        timeoutMs: deps.resolveTimeoutMs?.(details.workspaceId) ?? 0,
      })
      if (!opened.ok) {
        // A missing gate must never silently execute: refuse the step.
        logger.error(
          { stepId: details.stepId, error: opened.error },
          'Failed to open the shell confirmation decision; refusing to execute the step.',
        )
        return Promise.resolve(false)
      }
      deps.events.emit('workflow.shell_confirmation_required', {
        runId: details.runId,
        stepId: details.stepId,
        nodeId: details.nodeId,
        command: details.command,
        cwd: details.cwd,
      })
      return new Promise<boolean>((resolvePromise) => {
        // A duplicate request for the same step must never strand the earlier
        // parked promise (the dedupeKey made open() reuse the same row).
        settle(details.stepId, false)
        pending.set(details.stepId, {
          details,
          decisionId: opened.data.id,
          settle: resolvePromise,
        })
      })
    },

    resolve(stepId, approved) {
      const parked = pending.get(stepId)
      if (parked === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'This shell step is not awaiting a confirmation.',
          retryable: false,
          detail: `confirmShellStep step=${stepId}: no pending shell confirmation`,
        })
      }
      // Route through the decision channel; the onResolved subscription above
      // settles the parked promise synchronously on success.
      const resolved = deps.decisions.resolve(
        parked.decisionId,
        approved ? 'approve' : 'reject',
        'user',
      )
      if (!resolved.ok) {
        return { ok: false, error: resolved.error }
      }
      logger.info({ stepId, approved }, 'Shell step confirmation resolved.')
      return { ok: true, data: true }
    },

    cancel(stepId) {
      const parked = pending.get(stepId)
      if (parked === undefined) return
      settle(stepId, false)
      // Source teardown: close the row too (no handler dispatch — already
      // settled locally). Engine cancel reaches every parked step of the run,
      // so cancelling by workflow run covers the whole teardown.
      const cancelled = deps.decisions.cancelBySource({ workflowRunId: parked.details.runId })
      if (!cancelled.ok) {
        logger.error(
          { stepId, error: cancelled.error },
          'Failed to cancel the shell confirmation decision; startup reconciliation will close it.',
        )
      }
    },

    listPending() {
      const open = deps.decisions.list({ kind: 'shell_confirmation', status: 'open' })
      if (!open.ok) {
        logger.error({ error: open.error }, 'Failed to list open shell confirmations.')
        return []
      }
      const openDedupeKeys = new Set(open.data.map((decision) => decision.dedupeKey))
      return [...pending.values()]
        .filter((parked) => openDedupeKeys.has(parked.details.stepId))
        .map((parked) => parked.details)
    },

    dispose() {
      unsubscribeResolved()
      for (const stepId of [...pending.keys()]) {
        settle(stepId, false)
      }
      // Rows stay open in the DB on purpose: the next startup's
      // reconcileOnStartup() expires them with the system audit note
      // (ADR-0014 §5) — the audit trail must say "interrupted by restart",
      // not "cancelled by source".
    },
  }
}
