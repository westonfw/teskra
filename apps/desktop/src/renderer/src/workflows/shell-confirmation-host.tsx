import { Modal, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

import type { PendingDecision } from '@teskra/contracts'

import { useTranslation } from '../i18n'

/**
 * TASK-118 (code-review P0-3): a shell workflow step whose command came from
 * repo-controlled content parks in Main until the user confirms the full
 * command line here. The modal shows the exact command and cwd; approving
 * executes it once (there is no "always allow" — a repo file can change
 * between runs), rejecting fails the step.
 *
 * TASK-129 (ADR-0014): the data source is the persisted Decision Inbox —
 * `decision.list({ kind: 'shell_confirmation', status: 'open' })` plus the
 * `decision.opened` / `decision.resolved` events (a resolution or timeout
 * expiry from any source — this modal, the Inbox, the watchdog — drops the
 * item). Answering goes through `decision.resolve` with approve / reject.
 * The compat `workflow.shell_confirmation_required` event still fires; it is
 * only used as a re-pull trigger, never as a queue entry, so a payload
 * without a decision id can never strand an answer.
 *
 * P1-6: parked confirmations outlive this window — on (re)subscribe the host
 * pulls the Main-side backlog so a reload never strands a step in `running`
 * waiting on an event this window never saw. The backlog snapshot can race a
 * user answer (list read the row before resolve() closed it), so ids the user
 * already answered are suppressed on re-enqueue; the suppression expires
 * after ANSWERED_SUPPRESSION_MS so a step legitimately re-parked later
 * (retry / re-run) still prompts.
 */

/** How long an answered stepId stays suppressed against backlog re-enqueue. */
export const ANSWERED_SUPPRESSION_MS = 60_000

/** One queued modal entry, mapped from an open shell_confirmation decision. */
export interface ShellConfirmationItem {
  /** The PendingDecision id — answering goes through decision.resolve. */
  readonly decisionId: string
  readonly runId: string
  readonly stepId: string
  readonly command: string
  readonly cwd: string
}

/** The step a shell_confirmation decision parks; null for other kinds. */
export function shellDecisionStepId(decision: PendingDecision): string | null {
  if (decision.kind !== 'shell_confirmation') return null
  return decision.workflowStepId ?? decision.dedupeKey
}

/** Maps an open shell_confirmation decision to a modal item; null otherwise. */
export function decisionToConfirmationItem(
  decision: PendingDecision,
): ShellConfirmationItem | null {
  const stepId = shellDecisionStepId(decision)
  if (stepId === null || decision.detail.kind !== 'shell_confirmation') return null
  return {
    decisionId: decision.id,
    runId: decision.workflowRunId ?? '',
    stepId,
    command: decision.detail.command,
    cwd: decision.detail.cwd,
  }
}

export function mergePending<T extends { readonly stepId: string }>(
  queue: readonly T[],
  incoming: readonly T[],
  answered: ReadonlySet<string>,
): readonly T[] {
  const known = new Set(queue.map((entry) => entry.stepId))
  const fresh = incoming.filter((entry) => !known.has(entry.stepId) && !answered.has(entry.stepId))
  return fresh.length === 0 ? queue : [...queue, ...fresh]
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

export function ShellConfirmationHost() {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<readonly ShellConfirmationItem[]>([])
  const answeredRef = useRef<Set<string>>(new Set())
  const current = queue[0]

  useEffect(() => {
    const pullBacklog = (): void => {
      void window.teskra.decision
        .list({ kind: 'shell_confirmation', status: 'open' })
        .then((result) => {
          if (!result.ok) return
          const items = result.data.map(decisionToConfirmationItem).filter(isPresent)
          setQueue((pending) => mergePending(pending, items, answeredRef.current))
        })
    }
    const subscriptions = [
      window.teskra.events.subscribe('decision.opened', ({ decision }) => {
        const item = decisionToConfirmationItem(decision)
        if (item === null) return
        setQueue((pending) => mergePending(pending, [item], answeredRef.current))
      }),
      // A resolution from any source (this modal, the Inbox, a timeout
      // expiry, startup reconciliation) closes the parked step — drop it.
      window.teskra.events.subscribe('decision.resolved', ({ decision }) => {
        const stepId = shellDecisionStepId(decision)
        if (stepId === null) return
        setQueue((pending) => pending.filter((entry) => entry.stepId !== stepId))
      }),
      // TASK-129 compat: the legacy event fires alongside decision.opened;
      // re-pull instead of trusting the id-less payload.
      window.teskra.events.subscribe('workflow.shell_confirmation_required', () => {
        pullBacklog()
      }),
    ]
    pullBacklog()
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe()
    }
  }, [])

  const answer = (approved: boolean): void => {
    if (current === undefined) return
    answeredRef.current.add(current.stepId)
    const { decisionId, stepId } = current
    setTimeout(() => answeredRef.current.delete(stepId), ANSWERED_SUPPRESSION_MS)
    setQueue((pending) => pending.slice(1))
    void window.teskra.decision.resolve({
      id: decisionId,
      optionId: approved ? 'approve' : 'reject',
    })
  }

  return (
    <Modal
      open={current !== undefined}
      title={t('workflow.shellConfirm.title')}
      okText={t('workflow.shellConfirm.approve')}
      cancelText={t('workflow.shellConfirm.reject')}
      okButtonProps={{ danger: true }}
      onOk={() => answer(true)}
      onCancel={() => answer(false)}
      maskClosable={false}
    >
      <Typography.Paragraph>{t('workflow.shellConfirm.body')}</Typography.Paragraph>
      <Typography.Paragraph copyable code className="shell-confirm-command">
        {current?.command}
      </Typography.Paragraph>
      {current !== undefined && (
        <Typography.Text type="secondary">
          {t('workflow.shellConfirm.cwd', { cwd: current.cwd })}
        </Typography.Text>
      )}
    </Modal>
  )
}
