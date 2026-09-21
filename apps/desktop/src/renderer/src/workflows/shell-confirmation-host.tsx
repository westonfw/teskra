import { Modal, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

import type { PendingShellConfirmation } from '@teskra/contracts'

import { useTranslation } from '../i18n'

/**
 * TASK-118 (code-review P0-3): a shell workflow step whose command came from
 * repo-controlled content parks in Main until the user confirms the full
 * command line here. The modal shows the exact command and cwd; approving
 * executes it once (there is no "always allow" — a repo file can change
 * between runs), rejecting fails the step.
 *
 * P1-6: parked confirmations outlive this window — on (re)subscribe the host
 * pulls the Main-side backlog so a reload never strands a step in `running`
 * waiting on an event this window never saw. The backlog snapshot can race a
 * user answer (listPending read the map before resolve() removed the entry),
 * so ids the user already answered are suppressed on re-enqueue; the
 * suppression expires after ANSWERED_SUPPRESSION_MS so a step legitimately
 * re-parked later (retry / re-run) still prompts.
 */

/** How long an answered stepId stays suppressed against backlog re-enqueue. */
export const ANSWERED_SUPPRESSION_MS = 60_000

export function mergePending(
  queue: readonly PendingShellConfirmation[],
  incoming: readonly PendingShellConfirmation[],
  answered: ReadonlySet<string>,
): readonly PendingShellConfirmation[] {
  const known = new Set(queue.map((entry) => entry.stepId))
  const fresh = incoming.filter((entry) => !known.has(entry.stepId) && !answered.has(entry.stepId))
  return fresh.length === 0 ? queue : [...queue, ...fresh]
}

export function ShellConfirmationHost() {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<readonly PendingShellConfirmation[]>([])
  const answeredRef = useRef<Set<string>>(new Set())
  const current = queue[0]

  useEffect(() => {
    const unsubscribe = window.teskra.events.subscribe(
      'workflow.shell_confirmation_required',
      (payload) => {
        setQueue((pending) => mergePending(pending, [payload], answeredRef.current))
      },
    )
    void window.teskra.workflow.listPendingShellConfirmations().then((result) => {
      if (result.ok) setQueue((pending) => mergePending(pending, result.data, answeredRef.current))
    })
    return unsubscribe
  }, [])

  const answer = (approved: boolean): void => {
    if (current === undefined) return
    answeredRef.current.add(current.stepId)
    const stepId = current.stepId
    setTimeout(() => answeredRef.current.delete(stepId), ANSWERED_SUPPRESSION_MS)
    setQueue((pending) => pending.slice(1))
    void window.teskra.workflow.confirmShellStep({ stepId, approved })
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
