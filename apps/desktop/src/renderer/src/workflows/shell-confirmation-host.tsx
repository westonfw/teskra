import { Modal, Typography } from 'antd'
import { useEffect, useState } from 'react'

import { useTranslation } from '../i18n'

/**
 * TASK-118 (code-review P0-3): a shell workflow step whose command came from
 * repo-controlled content parks in Main until the user confirms the full
 * command line here. The modal shows the exact command and cwd; approving
 * executes it once (there is no "always allow" — a repo file can change
 * between runs), rejecting fails the step.
 */
interface PendingShellConfirmation {
  readonly runId: string
  readonly stepId: string
  readonly nodeId: string
  readonly command: string
  readonly cwd: string
}

export function ShellConfirmationHost() {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<readonly PendingShellConfirmation[]>([])
  const current = queue[0]

  useEffect(
    () =>
      window.teskra.events.subscribe('workflow.shell_confirmation_required', (payload) => {
        setQueue((pending) =>
          pending.some((entry) => entry.stepId === payload.stepId)
            ? pending
            : [...pending, payload],
        )
      }),
    [],
  )

  const answer = (approved: boolean): void => {
    if (current === undefined) return
    setQueue((pending) => pending.slice(1))
    void window.teskra.workflow.confirmShellStep({ stepId: current.stepId, approved })
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
