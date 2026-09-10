import { Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type {
  AcceptanceCriteriaSetDetail,
  CriteriaSetStatus,
  PublicAppError,
} from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'

/**
 * CriteriaPanel (TASK-048) — read-only view of a Task's acceptance criteria
 * versions. Editing (add / edit / remove / confirm) is TASK-049; this panel
 * only proves the domain + IPC path end-to-end.
 */

const statusColor: Record<CriteriaSetStatus, string> = {
  draft: 'default',
  confirmed: 'green',
  superseded: 'orange',
}

interface CriteriaPanelProps {
  readonly taskId: string
}

export function CriteriaPanel({ taskId }: CriteriaPanelProps) {
  const [details, setDetails] = useState<readonly AcceptanceCriteriaSetDetail[]>()
  const [error, setError] = useState<PublicAppError>()

  const load = useCallback(async () => {
    const sets = await window.teskra.criteria.listSets({ taskId })
    if (!sets.ok) {
      setError(sets.error)
      return
    }
    const resolved = await Promise.all(
      sets.data.map((set) => window.teskra.criteria.getSet({ setId: set.id })),
    )
    const failure = resolved.find((result) => !result.ok)
    if (failure !== undefined && !failure.ok) {
      setError(failure.error)
      return
    }
    setError(undefined)
    setDetails(
      resolved.flatMap((result) => (result.ok && result.data !== null ? [result.data] : [])),
    )
  }, [taskId])

  useEffect(() => {
    setDetails(undefined)
    void load()
  }, [load])

  useEffect(
    () =>
      window.teskra.events.subscribe('task.updated', (payload) => {
        if (payload.taskId === taskId) void load()
      }),
    [load, taskId],
  )

  return (
    <Card className="task-detail-card" title="Acceptance Criteria">
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={() => setError(undefined)} />
      )}
      {details === undefined ? (
        <Spin />
      ) : details.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No acceptance criteria yet" />
      ) : (
        <List
          dataSource={[...details]}
          renderItem={(detail) => (
            <List.Item>
              <div className="criteria-set">
                <Space>
                  <Typography.Text strong>v{detail.set.version}</Typography.Text>
                  <Tag color={statusColor[detail.set.status]}>{detail.set.status}</Tag>
                  {detail.set.confirmedAt !== undefined && (
                    <Typography.Text type="secondary">
                      confirmed {new Date(detail.set.confirmedAt).toLocaleString()}
                    </Typography.Text>
                  )}
                </Space>
                <List
                  size="small"
                  dataSource={detail.criteria}
                  locale={{ emptyText: 'No criteria in this version' }}
                  renderItem={(criterion) => (
                    <List.Item>
                      <Space>
                        <Typography.Text>
                          #{criterion.ordinal} {criterion.description}
                        </Typography.Text>
                        {criterion.category !== undefined && <Tag>{criterion.category}</Tag>}
                        {criterion.required && <Tag color="red">required</Tag>}
                      </Space>
                    </List.Item>
                  )}
                />
              </div>
            </List.Item>
          )}
        />
      )}
    </Card>
  )
}
