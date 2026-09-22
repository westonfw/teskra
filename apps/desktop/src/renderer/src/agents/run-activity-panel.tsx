import { Button, Collapse, Empty, Spin, Tag, Timeline, Typography } from 'antd'
import type { AgentObservation, AgentObservationRecord, AgentRun } from '@teskra/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation, type TranslationKey, type TranslationParams } from '../i18n'
import { formatCostUsdMicros, formatTokenCount } from '../usage/usage-view-model'
import { useRunFeed, type RunFeedSource } from './run-event-feed'
import {
  buildActivityItems,
  defaultRunDetailTab,
  RUN_FEED_PAGE_SIZE,
  type ActivityItem,
  type ToolCallObservation,
  type ToolResultObservation,
} from './run-activity-view-model'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

const observationSource: RunFeedSource<AgentObservationRecord> = {
  fetchPage: (runId, afterSeq) =>
    window.teskra.agent.listObservations({
      runId,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      limit: RUN_FEED_PAGE_SIZE,
    }),
  subscribeLive: (runId, handler) =>
    window.teskra.events.subscribe('agent.observation', (payload) => {
      if (payload.runId !== runId) return
      // Live broadcasts carry no createdAt; receipt time is display-only.
      handler({
        seq: payload.seq,
        observation: payload.observation,
        createdAt: new Date().toISOString(),
      })
    }),
}

/**
 * True once the run has at least one persisted observation. Probes
 * `list-observations` (limit 1) and then follows the live broadcast so an
 * exec run's first observation flips it without a reload. Only exec runs are
 * probed — the parser (TASK-123) never attaches to interactive runs.
 */
export function useHasObservations(run: AgentRun | undefined): boolean {
  const [has, setHas] = useState(false)
  const runId = run?.id
  const eligible = run?.mode === 'exec'
  useEffect(() => {
    setHas(false)
    if (!eligible || runId === undefined) return
    let active = true
    const stop = window.teskra.events.subscribe('agent.observation', (payload) => {
      if (payload.runId === runId) setHas(true)
    })
    window.teskra.agent
      .listObservations({ runId, limit: 1 })
      .then((result) => {
        if (active && result.ok && result.data.length > 0) setHas(true)
      })
      .catch(() => undefined)
    return () => {
      active = false
      stop()
    }
  }, [runId, eligible])
  return has
}

/**
 * The controlled tab state both Run detail drawers share: the raw-output tab
 * by default, switching to Activity once an exec run shows observations —
 * until the user picks a tab manually (reset when another run is opened).
 */
export function useRunDetailTab(run: AgentRun | undefined): {
  readonly activeTab: string
  readonly onTabChange: (key: string) => void
} {
  const [activeTab, setActiveTab] = useState('output')
  const touchedRef = useRef(false)
  const runId = run?.id
  const hasObservations = useHasObservations(run)
  useEffect(() => {
    touchedRef.current = false
    setActiveTab('output')
  }, [runId])
  useEffect(() => {
    if (!touchedRef.current && defaultRunDetailTab(run, hasObservations) === 'activity') {
      setActiveTab('activity')
    }
  }, [run, hasObservations])
  const onTabChange = useCallback((key: string) => {
    touchedRef.current = true
    setActiveTab(key)
  }, [])
  return { activeTab, onTabChange }
}

const KIND_COLORS: Partial<Record<AgentObservation['kind'], string>> = {
  session: 'blue',
  tool_call: 'geekblue',
  usage: 'purple',
  error: 'red',
}

function toolResultColor(ok: boolean): string {
  return ok ? 'green' : 'red'
}

function ObservationBody({ item, t }: { readonly item: ActivityItem; readonly t: Translate }) {
  const observation = item.observation
  switch (observation.kind) {
    case 'session':
      return <Typography.Text code>{observation.sessionId}</Typography.Text>
    case 'assistant_text':
      return (
        <Typography.Paragraph className="run-observation-text">
          {observation.text}
        </Typography.Paragraph>
      )
    case 'tool_call':
      return <ToolCallBody observation={observation} result={item.pairedResult} t={t} />
    case 'tool_result':
      return <ToolResultBody result={observation} t={t} />
    case 'usage': {
      let label = t('runs.observation.usage', {
        input: formatTokenCount(observation.inputTokens),
        output: formatTokenCount(observation.outputTokens),
      })
      if (observation.costUsdMicros !== undefined) {
        label += ` ${t('runs.observation.usageCost', {
          cost: formatCostUsdMicros(observation.costUsdMicros, t),
        })}`
      }
      if (observation.model !== undefined) label += ` · ${observation.model}`
      return <Typography.Text>{label}</Typography.Text>
    }
    case 'error':
      return (
        <Typography.Text type="danger">
          {observation.message}
          {observation.code === undefined ? '' : ` (${observation.code})`}
        </Typography.Text>
      )
    case 'result': {
      const parts = [
        observation.ok ? t('runs.observation.resultOk') : t('runs.observation.resultFailed'),
      ]
      if (observation.durationMs !== undefined) {
        parts.push(
          t('runs.observation.duration', { duration: (observation.durationMs / 1000).toFixed(1) }),
        )
      }
      if (observation.turns !== undefined) {
        parts.push(t('runs.observation.turns', { turns: observation.turns }))
      }
      return <Typography.Text>{parts.join(' · ')}</Typography.Text>
    }
  }
}

function ToolCallBody({
  observation,
  result,
  t,
}: {
  readonly observation: ToolCallObservation
  readonly result: ToolResultObservation | undefined
  readonly t: Translate
}) {
  return (
    <>
      {observation.command !== undefined && (
        <Typography.Text code className="run-observation-text">
          {observation.command}
        </Typography.Text>
      )}
      <Collapse
        ghost
        size="small"
        items={[
          {
            key: 'input',
            label: t('runs.observation.toolInput'),
            children: <pre className="run-observation-payload">{observation.input}</pre>,
          },
          ...(result === undefined
            ? []
            : [
                {
                  key: 'result',
                  label: (
                    <Typography.Text {...(result.ok ? {} : { type: 'danger' as const })}>
                      {t('runs.observation.toolOutput')}
                    </Typography.Text>
                  ),
                  children: <pre className="run-observation-payload">{result.output}</pre>,
                },
              ]),
        ]}
      />
    </>
  )
}

function ToolResultBody({
  result,
  t,
}: {
  readonly result: ToolResultObservation
  readonly t: Translate
}) {
  return (
    <Collapse
      ghost
      size="small"
      items={[
        {
          key: 'result',
          label: (
            <Typography.Text {...(result.ok ? {} : { type: 'danger' as const })}>
              {t('runs.observation.toolOutput')}
            </Typography.Text>
          ),
          children: <pre className="run-observation-payload">{result.output}</pre>,
        },
      ]}
    />
  )
}

function itemColor(item: ActivityItem): string | undefined {
  const observation = item.observation
  if (observation.kind === 'tool_result') return toolResultColor(observation.ok)
  if (observation.kind === 'result') return toolResultColor(observation.ok)
  if (observation.kind === 'tool_call' && item.pairedResult !== undefined) {
    return toolResultColor(item.pairedResult.ok)
  }
  return KIND_COLORS[observation.kind]
}

/**
 * TASK-125 (§14): the Activity tab — a read-only timeline of the run's
 * parsed observations (ADR-0013), paged via list-observations and extended
 * live via the agent.observation broadcast.
 */
export function RunActivityPanel({ runId }: { readonly runId: string }) {
  const { t } = useTranslation()
  const feed = useRunFeed(runId, observationSource)
  const items = buildActivityItems(feed.records)

  return (
    <div className="run-activity-panel">
      {feed.error !== undefined && <AppErrorAlert error={feed.error} />}
      {feed.status === 'loading' ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('runs.observation.empty')} />
      ) : (
        <Timeline
          items={items.map((item) => {
            const color = itemColor(item)
            const kindColor = KIND_COLORS[item.observation.kind]
            return {
              key: item.seq,
              ...(color === undefined ? {} : { color }),
              children: (
                <div className="run-observation">
                  <div className="run-observation-heading">
                    <Tag
                      {...(kindColor === undefined ? {} : { color: kindColor })}
                      bordered={false}
                    >
                      {t(`runs.observation.kind.${item.observation.kind}`)}
                    </Tag>
                    {item.observation.kind === 'tool_call' && (
                      <Typography.Text strong>{item.observation.toolName}</Typography.Text>
                    )}
                    {item.observation.kind === 'tool_result' &&
                      item.observation.toolName !== undefined && (
                        <Typography.Text strong>{item.observation.toolName}</Typography.Text>
                      )}
                    <Typography.Text type="secondary" className="run-observation-time">
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </Typography.Text>
                  </div>
                  <ObservationBody item={item} t={t} />
                </div>
              ),
            }
          })}
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
