import { Descriptions, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { AgentRunUsage } from '@teskra/contracts'

import { useTranslation } from '../i18n'
import { runUsageLabel } from './usage-view-model'

/**
 * TASK-124 (Milestone 25 §7): loads the run's accumulated usage row once,
 * then follows `usage.updated` so Run details refresh live while the run is
 * working. `undefined` = still loading / query failed (render nothing);
 * `null` = the run has not reported any usage yet.
 */
export function useRunUsage(runId: string): AgentRunUsage | null | undefined {
  const [usage, setUsage] = useState<AgentRunUsage | null>()

  useEffect(() => {
    let active = true
    void window.teskra.usage.getByRun({ runId }).then((result) => {
      // A failed query just leaves the header without the usage line.
      if (active && result.ok) setUsage(result.data)
    })
    const unsubscribe = window.teskra.events.subscribe('usage.updated', (payload) => {
      if (payload.runId === runId) setUsage(payload.usage)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [runId])

  return usage
}

/** The Run detail header's usage line (Runs page drawer). */
export function RunUsageItem({ runId }: { readonly runId: string }) {
  const { t } = useTranslation()
  const label = runUsageLabel(useRunUsage(runId), t)
  if (label === undefined) return null
  return <Descriptions.Item label={t('runs.field.usage')}>{label}</Descriptions.Item>
}

/** The plain-text variant for the Task page's run drawer header. */
export function RunUsageText({ runId }: { readonly runId: string }) {
  const { t } = useTranslation()
  const label = runUsageLabel(useRunUsage(runId), t)
  if (label === undefined) return null
  return <Typography.Text type="secondary">{label}</Typography.Text>
}
