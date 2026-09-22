import { Button, Empty, List, Progress, Space, Spin, Tag, Typography } from 'antd'
import type { AgentProgressKind, AgentProgressRecord } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useRunFeed, type RunFeedSource } from './run-event-feed'
import { RUN_FEED_PAGE_SIZE } from './run-activity-view-model'

const progressSource: RunFeedSource<AgentProgressRecord> = {
  fetchPage: (runId, afterSeq) =>
    window.teskra.agent.listProgress({
      runId,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      limit: RUN_FEED_PAGE_SIZE,
    }),
  subscribeLive: (runId, handler) =>
    window.teskra.events.subscribe('agent.progress', (payload) => {
      if (payload.runId !== runId) return
      // Live broadcasts carry no createdAt; receipt time is display-only.
      handler({ seq: payload.seq, event: payload.event, createdAt: new Date().toISOString() })
    }),
}

const KIND_COLORS: Record<AgentProgressKind, string> = {
  progress: 'blue',
  blocker: 'red',
  question: 'orange',
  note: 'default',
}

/**
 * TASK-125 (§14): the Progress tab — the run's progress-file events
 * (ADR-0012) with their declared percent, paged via list-progress and
 * extended live via the agent.progress broadcast.
 */
export function RunProgressPanel({ runId }: { readonly runId: string }) {
  const { t } = useTranslation()
  const feed = useRunFeed(runId, progressSource)

  return (
    <div className="run-progress-panel">
      {feed.error !== undefined && <AppErrorAlert error={feed.error} />}
      {feed.status === 'loading' ? (
        <Spin />
      ) : feed.records.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('runs.progress.empty')} />
      ) : (
        <List
          size="small"
          dataSource={[...feed.records]}
          renderItem={(record) => (
            <List.Item>
              <Space direction="vertical" size={4} className="run-progress-event">
                <Space wrap>
                  <Tag color={KIND_COLORS[record.event.kind]} bordered={false}>
                    {t(`runs.progress.kind.${record.event.kind}`)}
                  </Tag>
                  <Typography.Text type="secondary">
                    {new Date(record.event.at ?? record.createdAt).toLocaleString()}
                  </Typography.Text>
                </Space>
                <Typography.Text className="run-observation-text">
                  {record.event.message}
                </Typography.Text>
                {record.event.percent !== undefined && (
                  <Progress percent={record.event.percent} size="small" />
                )}
              </Space>
            </List.Item>
          )}
        />
      )}
      {feed.hasMore && (
        <Button size="small" loading={feed.loadingMore} onClick={feed.loadMore}>
          {t('runs.feed.loadMore')}
        </Button>
      )}
    </div>
  )
}
