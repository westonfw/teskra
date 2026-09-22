import { Button, Popconfirm } from 'antd'

import type { DecisionOption } from '@teskra/contracts'

import { useTranslation } from '../i18n'
import { decisionOptionLabel, decisionOptionNeedsConfirm } from './decision-view-model'

interface DecisionOptionButtonProps {
  readonly option: DecisionOption
  readonly resolving: boolean
  readonly onPick: (option: DecisionOption) => void
}

/**
 * The Decision option button shared by the Inbox (TASK-131) and the thread
 * (TASK-140): known option ids get a localized label, danger options confirm
 * twice through a Popconfirm before `onPick` fires (design doc §9.3).
 */
export function DecisionOptionButton({ option, resolving, onPick }: DecisionOptionButtonProps) {
  const { t } = useTranslation()
  if (!decisionOptionNeedsConfirm(option)) {
    return (
      <Button size="small" disabled={resolving} onClick={() => onPick(option)}>
        {decisionOptionLabel(option, t)}
      </Button>
    )
  }
  // danger options confirm twice (§9.3): the Popconfirm owns the action.
  return (
    <Popconfirm
      title={t('inbox.confirm.dangerTitle')}
      description={t('inbox.confirm.dangerBody', { action: decisionOptionLabel(option, t) })}
      okText={t('inbox.confirm.dangerOk')}
      cancelText={t('inbox.confirm.cancel')}
      okButtonProps={{ danger: true }}
      onConfirm={() => onPick(option)}
    >
      <Button size="small" type="primary" danger disabled={resolving}>
        {decisionOptionLabel(option, t)}
      </Button>
    </Popconfirm>
  )
}
