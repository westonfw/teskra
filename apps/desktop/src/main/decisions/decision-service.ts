import { randomUUID } from 'node:crypto'

import type {
  DecisionDecidedBy,
  DecisionDetail,
  DecisionKind,
  DecisionOption,
  DecisionResolution,
  IpcResult,
  PendingDecision,
  WorkbenchEvents,
} from '@teskra/contracts'

import { nowIso } from '../db/repositories/common'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type {
  DecisionListFilter,
  DecisionRepository,
  DecisionSourceRef,
} from './decision-repository'

/**
 * DecisionService (TASK-128, teskra-tasks.md; ADR-0014; design doc §9.1).
 *
 * The single persisted inbox for every moment that needs a human decision.
 * The service owns the lifecycle only — open / resolve / expire / cancel /
 * startup reconciliation — and broadcasts `decision.opened` /
 * `decision.resolved`. It NEVER executes the action behind a resolution and
 * never imports Git / AgentManager (ADR-0014 §3): source modules subscribe
 * per kind through `onResolved(kind, handler)` and act on their own.
 *
 * - `open()` is idempotent on `dedupeKey`: an already-open row is returned
 *   without re-emitting `decision.opened`; the partial unique index
 *   `idx_pending_decisions_open_dedupe` guards the insert race (ADR-0014 §2).
 * - `resolve()` is a CAS (`open → resolved`); a second resolution answers
 *   CONFLICT.
 * - `expire()` is driven by the RunWatchdogService tick (ADR-0014 §4 — the
 *   Main process has exactly one periodic timer). Expired rows close with the
 *   kind's non-destructive default option (§9.1: shell confirmation = reject,
 *   stalled run = keep waiting, agent blocker = no run action).
 * - Startup reconciliation expires every open `shell_confirmation`: after a
 *   restart the step's in-memory promise no longer exists, so it can never be
 *   approved again (ADR-0014 §5). The persisted transition (resolution with
 *   decidedBy 'system' + note) IS the audit record — decision rows survive
 *   their sources (ON DELETE SET NULL, ADR-0014 §6) — and each expired row is
 *   additionally written to the security log.
 */

/**
 * §9.1 default action per kind, expressed as the option id the timeout /
 * system resolution references (option ids are the §9.2 vocabulary). When a
 * source module opened the decision with different ids, the first option is
 * used as the fallback — the resolution must always reference a real option.
 */
export const DECISION_TIMEOUT_DEFAULT_OPTIONS: Readonly<Record<DecisionKind, string>> = {
  shell_confirmation: 'reject',
  agent_blocker: 'acknowledge',
  stalled_run: 'keep_waiting',
  merge_blocked: 'cancel',
  rate_limit: 'wait',
  handoff_degraded: 'dismiss',
}

export interface OpenDecisionInput {
  readonly workspaceId: string
  readonly kind: DecisionKind
  readonly severity: PendingDecision['severity']
  /** `${kind}:${sourceId}` — one open row per key (partial unique index). */
  readonly dedupeKey: string
  readonly title: string
  readonly detail: DecisionDetail
  readonly options: readonly DecisionOption[]
  readonly runId?: string
  readonly workflowRunId?: string
  readonly workflowStepId?: string
  readonly worktreeId?: string
  /**
   * Milliseconds from now after which the decision expires; `0` / undefined
   * (the default) means it never expires (decisions.*TimeoutMs semantics).
   */
  readonly timeoutMs?: number
}

/** Receives the closed decision (resolution included) after resolve() / expire(). */
export type DecisionResolvedHandler = (decision: PendingDecision) => void

export interface DecisionService {
  /** Idempotent on dedupeKey; emits decision.opened only for a genuinely new row. */
  open(input: OpenDecisionInput, now?: string): IpcResult<PendingDecision>
  get(id: string): IpcResult<PendingDecision | null>
  list(filter?: DecisionListFilter): IpcResult<readonly PendingDecision[]>
  /**
   * CAS `open → resolved`; the second call answers CONFLICT. `decidedBy` is
   * 'user' for IPC resolutions; 'system' is available to Main-side callers.
   */
  resolve(
    id: string,
    optionId: string,
    decidedBy: DecisionDecidedBy,
    note?: string,
    now?: string,
  ): IpcResult<PendingDecision>
  /** Watchdog-tick entry: expires every due open row; returns the expired ones. */
  expire(now?: string): IpcResult<readonly PendingDecision[]>
  /** Source teardown: every open row of the run / workflow run → cancelled. */
  cancelBySource(source: DecisionSourceRef, now?: string): IpcResult<readonly PendingDecision[]>
  /** Startup reconciliation (ADR-0014 §5): open shell confirmations → expired + audit. */
  reconcileOnStartup(now?: string): IpcResult<readonly PendingDecision[]>
  /** Source modules subscribe here; returns an idempotent unsubscribe. */
  onResolved(kind: DecisionKind, handler: DecisionResolvedHandler): () => void
  dispose(): void
}

export interface DecisionServiceDeps {
  readonly decisions: DecisionRepository
  readonly events: EventBus<WorkbenchEvents>
  /** Injectable for tests; defaults to randomUUID. */
  readonly createId?: () => string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function timeoutDefaultOption(decision: PendingDecision): string {
  const preferred = DECISION_TIMEOUT_DEFAULT_OPTIONS[decision.kind]
  if (decision.options.some((option) => option.id === preferred)) {
    return preferred
  }
  // options is min(1) by schema — the fallback always exists.
  return decision.options[0]?.id ?? preferred
}

export function createDecisionService(deps: DecisionServiceDeps): DecisionService {
  const logger = getLogger('runtime')
  const securityLogger = getLogger('security')
  const createId = deps.createId ?? randomUUID
  const handlers = new Map<DecisionKind, Set<DecisionResolvedHandler>>()
  let disposed = false

  const dispatch = (decision: PendingDecision): void => {
    const subscribed = handlers.get(decision.kind)
    if (subscribed === undefined) return
    for (const handler of [...subscribed]) {
      try {
        handler(decision)
      } catch (cause) {
        logger.error(
          { decisionId: decision.id, kind: decision.kind, cause },
          'A decision onResolved handler failed.',
        )
      }
    }
  }

  const emitResolved = (decision: PendingDecision, notifyHandlers: boolean): void => {
    deps.events.emit('decision.resolved', { decision })
    if (notifyHandlers) {
      dispatch(decision)
    }
  }

  const service: DecisionService = {
    open(input, now = nowIso()) {
      if (disposed) {
        return fail({
          code: 'UNKNOWN',
          message: 'The decision service is disposed.',
          retryable: false,
          detail: 'decision: open after dispose',
        })
      }
      if (input.detail.kind !== input.kind) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'The decision detail does not match its kind.',
          retryable: false,
          detail: `decision: open kind=${input.kind} detail.kind=${input.detail.kind}`,
        })
      }
      if (input.options.length === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'A decision needs at least one option.',
          retryable: false,
          detail: 'decision: open with empty options',
        })
      }
      const existing = deps.decisions.getOpenByDedupeKey(input.dedupeKey)
      if (!existing.ok) {
        return existing
      }
      if (existing.data !== null) {
        // ADR-0014 §2: same source already waiting — reuse, never re-notify.
        return { ok: true, data: existing.data }
      }
      const timeoutMs = input.timeoutMs ?? 0
      const expiresAt =
        timeoutMs > 0 ? new Date(Date.parse(now) + timeoutMs).toISOString() : undefined
      const inserted = deps.decisions.insert(
        {
          id: createId(),
          workspaceId: input.workspaceId,
          kind: input.kind,
          severity: input.severity,
          dedupeKey: input.dedupeKey,
          title: input.title,
          detail: input.detail,
          options: input.options,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.workflowRunId === undefined ? {} : { workflowRunId: input.workflowRunId }),
          ...(input.workflowStepId === undefined ? {} : { workflowStepId: input.workflowStepId }),
          ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        now,
      )
      if (!inserted.ok) {
        if (inserted.error.code !== 'CONFLICT') {
          return inserted
        }
        // Lost the insert race: the concurrent opener's row is the answer.
        const winner = deps.decisions.getOpenByDedupeKey(input.dedupeKey)
        if (!winner.ok) {
          return winner
        }
        if (winner.data === null) {
          return fail({
            code: 'UNKNOWN',
            message: 'Failed to open the decision.',
            retryable: true,
            detail: `decision: insert conflicted on dedupeKey=${input.dedupeKey} but no open row exists`,
          })
        }
        return { ok: true, data: winner.data }
      }
      deps.events.emit('decision.opened', { decision: inserted.data })
      return inserted
    },

    get(id) {
      return deps.decisions.getById(id)
    },

    list(filter = {}) {
      return deps.decisions.list(filter)
    },

    resolve(id, optionId, decidedBy, note, now = nowIso()): IpcResult<PendingDecision> {
      const current = deps.decisions.getById(id)
      if (!current.ok) {
        return current
      }
      if (current.data === null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'The decision does not exist.',
          messageKey: 'errorMessage.decisionNotFound',
          params: { id },
          retryable: false,
          detail: `decision: resolve id=${id} matched no row`,
        })
      }
      if (current.data.status !== 'open') {
        return fail({
          code: 'CONFLICT',
          message: 'This decision was already closed.',
          messageKey: 'errorMessage.decisionAlreadyClosed',
          retryable: false,
          detail: `decision: resolve id=${id} status=${current.data.status}`,
        })
      }
      if (!current.data.options.some((option) => option.id === optionId)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'The chosen option does not belong to this decision.',
          retryable: false,
          detail: `decision: resolve id=${id} unknown optionId=${optionId}`,
        })
      }
      const resolution: DecisionResolution = {
        optionId,
        decidedBy,
        decidedAt: now,
        ...(note === undefined ? {} : { note }),
      }
      const closed = deps.decisions.closeOpen(id, { status: 'resolved', resolution }, now)
      if (!closed.ok) {
        return closed
      }
      if (closed.data === null) {
        // Lost the CAS race with expire / cancel / another resolve.
        return fail({
          code: 'CONFLICT',
          message: 'This decision was already closed.',
          messageKey: 'errorMessage.decisionAlreadyClosed',
          retryable: false,
          detail: `decision: resolve id=${id} lost the open→resolved CAS`,
        })
      }
      emitResolved(closed.data, true)
      return { ok: true, data: closed.data }
    },

    expire(now = nowIso()) {
      const due = deps.decisions.listExpirable(now)
      if (!due.ok) {
        return due
      }
      const expired: PendingDecision[] = []
      for (const decision of due.data) {
        const resolution: DecisionResolution = {
          optionId: timeoutDefaultOption(decision),
          decidedBy: 'timeout',
          decidedAt: now,
        }
        const closed = deps.decisions.closeOpen(decision.id, { status: 'expired', resolution }, now)
        if (!closed.ok) {
          return closed
        }
        // null = a resolve/cancel won the race on this row; nothing to do.
        if (closed.data === null) continue
        expired.push(closed.data)
        emitResolved(closed.data, true)
      }
      return { ok: true, data: expired }
    },

    cancelBySource(source, now = nowIso()) {
      if (source.runId === undefined && source.workflowRunId === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'A runId or workflowRunId is required to cancel decisions by source.',
          retryable: false,
          detail: 'decision: cancelBySource without any source key would cancel nothing',
        })
      }
      const open = deps.decisions.listOpenBySource(source)
      if (!open.ok) {
        return open
      }
      const cancelled: PendingDecision[] = []
      for (const decision of open.data) {
        const closed = deps.decisions.closeOpen(decision.id, { status: 'cancelled' }, now)
        if (!closed.ok) {
          return closed
        }
        if (closed.data === null) continue
        cancelled.push(closed.data)
        // No handler dispatch: the source itself is tearing down — there is
        // no resolution action left to execute (ADR-0014 §3).
        emitResolved(closed.data, false)
      }
      return { ok: true, data: cancelled }
    },

    reconcileOnStartup(now = nowIso()) {
      const open = deps.decisions.listOpenByKind('shell_confirmation')
      if (!open.ok) {
        return open
      }
      const expired: PendingDecision[] = []
      for (const decision of open.data) {
        const resolution: DecisionResolution = {
          optionId: timeoutDefaultOption(decision),
          decidedBy: 'system',
          decidedAt: now,
          note: 'Teskra restarted while this confirmation was open; the parked step no longer exists and it can no longer be approved.',
        }
        const closed = deps.decisions.closeOpen(decision.id, { status: 'expired', resolution }, now)
        if (!closed.ok) {
          return closed
        }
        if (closed.data === null) continue
        expired.push(closed.data)
        // ADR-0014 §5: the persisted transition is the audit record; the
        // security log mirrors it for the ops trail. No handler dispatch —
        // the in-memory step promise did not survive the restart.
        securityLogger.warn(
          {
            decisionId: closed.data.id,
            dedupeKey: closed.data.dedupeKey,
            title: closed.data.title,
          },
          'Open shell confirmation expired by startup reconciliation.',
        )
        emitResolved(closed.data, false)
      }
      return { ok: true, data: expired }
    },

    onResolved(kind, handler) {
      let subscribed = handlers.get(kind)
      if (subscribed === undefined) {
        subscribed = new Set()
        handlers.set(kind, subscribed)
      }
      subscribed.add(handler)
      let active = true
      return () => {
        if (!active) return
        active = false
        subscribed.delete(handler)
      }
    },

    dispose() {
      disposed = true
      handlers.clear()
    },
  }

  return service
}
