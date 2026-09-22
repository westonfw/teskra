import { Button, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  TASK_THREAD_MAX_LIMIT,
  type DecisionOption,
  type PublicAppError,
  type ThreadAgentProgressItem,
  type ThreadAgentReplyItem,
  type ThreadDecisionItem,
  type ThreadItem,
  type ThreadSystemItem,
  type ThreadUserMessageItem,
  type WorkflowRunDetail,
} from '@teskra/contracts'

import { ContinueWithAccountModal } from '../agents/continue-with-account-modal'
import { useContinuationStore } from '../agents/continuation-store'
import { AppErrorAlert } from '../components/app-error-alert'
import { DecisionOptionButton } from '../decisions/decision-option-button'
import { decisionOptionLabel } from '../decisions/decision-view-model'
import { transportError, useTranslation } from '../i18n'
import { mergeThreadItems, reconcileThreadItems } from './task-thread-view-model'

/**
 * TASK-140 (teskra-tasks.md; Milestone 26 design §5/§12) — the Task page
 * Thread tab: the read-only ThreadItem timeline (user_message / agent_reply /
 * agent_progress / decision / system) with in-thread decision resolution and
 * an expandable Workflow card.
 *
 * Live updates subscribe to `agent.*` / `decision.*` / `workflow.run_updated`
 * and re-read the projection ONLY when the event's Run id belongs to this
 * thread (or a new Run / WorkflowRun was just created); the fresh read is
 * merged into the rendered list by projection id (task-thread-view-model), so
 * a reply growing or a decision resolving updates its own card instead of
 * re-pulling and re-rendering the whole page.
 */

const MAX_THREAD_PAGES = 5
const REFRESH_DEBOUNCE_MS = 250

/** Agent events that can add or change thread items; all carry `runId`. */
const AGENT_REFRESH_EVENTS = [
  'agent.created',
  'agent.started',
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
  'agent.interrupted',
  'agent.observation',
  'agent.progress',
] as const

type ProjectionRead =
  | { readonly ok: true; readonly items: readonly ThreadItem[] }
  | { readonly ok: false; readonly error: PublicAppError }

function knownRunIds(items: readonly ThreadItem[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if ('runId' in item && item.runId !== undefined) ids.add(item.runId)
    if (item.kind === 'system' && item.workflowRunId !== undefined) ids.add(item.workflowRunId)
    if (item.kind === 'decision' && item.workflowRunId !== undefined) ids.add(item.workflowRunId)
  }
  return ids
}

function UserMessageRow({ item }: { readonly item: ThreadUserMessageItem }) {
  return (
    <div className="thread-item thread-user-message" data-thread-item-id={item.id}>
      <Typography.Paragraph className="thread-text">{item.text}</Typography.Paragraph>
      <Typography.Text type="secondary" className="thread-time">
        {new Date(item.createdAt).toLocaleString()}
      </Typography.Text>
    </div>
  )
}

function AgentReplyRow({ item }: { readonly item: ThreadAgentReplyItem }) {
  const { t } = useTranslation()
  return (
    <div className="thread-item thread-agent-reply" data-thread-item-id={item.id}>
      <Space size={8} wrap>
        <Typography.Text strong>{item.agentType}</Typography.Text>
        <Tag bordered={false}>{t(`thread.reply.source.${item.source}`)}</Tag>
        {item.truncated && <Tag color="gold">{t('thread.reply.truncated')}</Tag>}
        <Typography.Text type="secondary" className="thread-time">
          {new Date(item.createdAt).toLocaleString()}
        </Typography.Text>
      </Space>
      <Typography.Paragraph className="thread-text">{item.text}</Typography.Paragraph>
    </div>
  )
}

function AgentProgressRow({ item }: { readonly item: ThreadAgentProgressItem }) {
  const { t } = useTranslation()
  return (
    <div className="thread-item thread-agent-progress" data-thread-item-id={item.id}>
      <Space size={8} wrap>
        <Tag bordered={false}>{t(`thread.progress.kind.${item.event.kind}`)}</Tag>
        <Typography.Text type="secondary">{item.event.message}</Typography.Text>
        {item.event.percent !== undefined && (
          <Typography.Text type="secondary">{`${String(item.event.percent)}%`}</Typography.Text>
        )}
      </Space>
    </div>
  )
}

interface DecisionRowProps {
  readonly item: ThreadDecisionItem
  readonly resolving: boolean
  readonly onPick: (item: ThreadDecisionItem, option: DecisionOption) => void
}

function DecisionRow({ item, resolving, onPick }: DecisionRowProps) {
  const { t } = useTranslation()
  const resolvedOption = item.options.find((option) => option.id === item.resolution?.optionId)
  return (
    <div className="thread-item thread-decision" data-thread-item-id={item.id}>
      <Space size={8} wrap>
        <Typography.Text strong>{item.title}</Typography.Text>
        <Tag bordered={false}>{t(`inbox.kind.${item.decisionKind}`)}</Tag>
        <Tag bordered={false}>{t(`inbox.severity.${item.severity}`)}</Tag>
        <Typography.Text type="secondary" className="thread-time">
          {new Date(item.createdAt).toLocaleString()}
        </Typography.Text>
      </Space>
      {item.status === 'open' ? (
        <Space size={8} wrap className="thread-decision-actions">
          {item.options.map((option) => (
            <DecisionOptionButton
              key={option.id}
              option={option}
              resolving={resolving}
              onPick={(picked) => onPick(item, picked)}
            />
          ))}
        </Space>
      ) : (
        item.resolution !== undefined && (
          <Typography.Text type="secondary">
            {t('thread.decision.resolved', {
              option:
                resolvedOption === undefined
                  ? item.resolution.optionId
                  : decisionOptionLabel(resolvedOption, t),
            })}
            {item.resolution.note !== undefined ? ` — ${item.resolution.note}` : ''}
          </Typography.Text>
        )
      )}
    </div>
  )
}

interface SystemRowProps {
  readonly item: ThreadSystemItem
  readonly workflowDetail?: WorkflowRunDetail | undefined
  readonly workflowLoading: boolean
  readonly onToggleWorkflow: (workflowRunId: string) => void
  readonly onOpenRun: (runId: string) => void
  readonly onOpenTerminal: (runId: string) => void
}

function SystemRow({
  item,
  workflowDetail,
  workflowLoading,
  onToggleWorkflow,
  onOpenRun,
  onOpenTerminal,
}: SystemRowProps) {
  const { t } = useTranslation()
  return (
    <div
      className="thread-item thread-system"
      data-thread-item-id={item.id}
      data-system-kind={item.systemKind}
    >
      <Space size={8} wrap>
        <Tag bordered={false}>{t(`thread.systemKind.${item.systemKind}`)}</Tag>
        <Typography.Text type="secondary">
          {item.systemKind === 'terminal' ? t('thread.terminal.running') : item.text}
        </Typography.Text>
        <Tag>{item.status.replaceAll('_', ' ')}</Tag>
        {item.systemKind === 'terminal' && item.runId !== undefined && (
          <Button
            size="small"
            type="link"
            className="thread-terminal-link"
            onClick={() => onOpenTerminal(item.runId ?? '')}
          >
            {t('thread.terminal.open')}
          </Button>
        )}
        {item.systemKind === 'review' && item.runId !== undefined && (
          <Button
            size="small"
            type="link"
            className="thread-review-link"
            onClick={() => onOpenRun(item.runId ?? '')}
          >
            {t('thread.review.openRun')}
          </Button>
        )}
        {item.systemKind === 'workflow' && item.workflowRunId !== undefined && (
          <Button
            size="small"
            type="link"
            className="thread-workflow-toggle"
            onClick={() => onToggleWorkflow(item.workflowRunId ?? '')}
          >
            {workflowDetail === undefined
              ? t('thread.workflow.expand')
              : t('thread.workflow.collapse')}
          </Button>
        )}
      </Space>
      {item.systemKind === 'workflow' && workflowDetail !== undefined && (
        <Spin spinning={workflowLoading}>
          <List
            size="small"
            className="thread-workflow-steps"
            dataSource={[...workflowDetail.steps].sort(
              (a, b) => a.iteration - b.iteration || a.createdAt.localeCompare(b.createdAt),
            )}
            renderItem={(step) => (
              <List.Item>
                <Space size={8} wrap>
                  <Typography.Text code>{step.nodeId}</Typography.Text>
                  <Tag>{step.nodeType}</Tag>
                  <Tag>{step.status}</Tag>
                  <Typography.Text type="secondary">
                    {t('workflow.roundSingle', { n: step.iteration + 1 })}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </Spin>
      )}
    </div>
  )
}

interface TaskThreadPanelProps {
  readonly taskId: string
  /** Opens the Run's detail drawer (review system items). */
  readonly onOpenRun: (runId: string) => void
  /** Switches the Task page to the Terminal tab focused on this Run. */
  readonly onOpenTerminal: (runId: string) => void
}

export function TaskThreadPanel({ taskId, onOpenRun, onOpenTerminal }: TaskThreadPanelProps) {
  const { t } = useTranslation()
  const openContinuation = useContinuationStore((state) => state.openFor)
  const [items, setItems] = useState<readonly ThreadItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<PublicAppError>()
  const [resolvingId, setResolvingId] = useState<string>()
  const [continuedDecisionId, setContinuedDecisionId] = useState<string>()
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowRunDetail>()
  const [workflowLoading, setWorkflowLoading] = useState(false)
  // Mirrors for event handlers, which must read the newest state outside setState.
  const itemsRef = useRef<readonly ThreadItem[]>(items)
  itemsRef.current = items
  const workflowDetailRef = useRef<WorkflowRunDetail | undefined>(undefined)
  workflowDetailRef.current = workflowDetail
  const refreshTimerRef = useRef<number | undefined>(undefined)

  /** Reads the whole projection (paging forward) — the thread is short. */
  const fetchProjection = useCallback(async (): Promise<ProjectionRead> => {
    const collected: ThreadItem[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const result = await window.teskra.task.thread({
        taskId,
        limit: TASK_THREAD_MAX_LIMIT,
        ...(cursor === undefined ? {} : { afterCursor: cursor }),
      })
      if (!result.ok) return { ok: false, error: result.error }
      collected.push(...result.data.items)
      if (result.data.nextCursor === undefined) break
      cursor = result.data.nextCursor
    }
    return { ok: true, items: collected }
  }, [taskId])

  useEffect(() => {
    let active = true
    let generation = 0
    setItems([])
    setStatus('loading')
    setError(undefined)
    setWorkflowDetail(undefined)

    const refresh = async (): Promise<void> => {
      const ticket = ++generation
      let projection: ProjectionRead
      try {
        projection = await fetchProjection()
      } catch {
        if (active && ticket === generation) {
          setStatus('error')
          setError(transportError())
        }
        return
      }
      if (!active || ticket !== generation) return
      if (!projection.ok) {
        setStatus('error')
        setError(projection.error)
        return
      }
      setItems((current) => reconcileThreadItems(current, projection.items))
      setStatus('ready')
      setError(undefined)
    }

    /** Debounced: an event storm during a run coalesces into one re-read. */
    const scheduleRefresh = (): void => {
      window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = window.setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS)
    }

    /** Refreshes the expanded Workflow card's steps in place. */
    const refreshWorkflowDetail = async (runId: string): Promise<void> => {
      setWorkflowLoading(true)
      try {
        const result = await window.teskra.workflow.getRun({ runId })
        if (!active) return
        if (result.ok) {
          setWorkflowDetail((current) =>
            current?.run.id === runId ? (result.data ?? undefined) : current,
          )
        } else {
          setError(result.error)
        }
      } catch {
        if (active) setError(transportError())
      } finally {
        if (active) setWorkflowLoading(false)
      }
    }

    const stops = [
      ...AGENT_REFRESH_EVENTS.map((name) =>
        window.teskra.events.subscribe(name, ({ runId }) => {
          // Refresh per affected Run id: unknown runs only matter when they
          // are new (agent.created) — everything else belongs to another task.
          if (name === 'agent.created' || knownRunIds(itemsRef.current).has(runId)) {
            scheduleRefresh()
          }
        }),
      ),
      window.teskra.events.subscribe('decision.opened', ({ decision }) => {
        const ids = knownRunIds(itemsRef.current)
        if (
          (decision.runId !== undefined && ids.has(decision.runId)) ||
          (decision.workflowRunId !== undefined && ids.has(decision.workflowRunId))
        ) {
          scheduleRefresh()
        }
      }),
      window.teskra.events.subscribe('decision.resolved', ({ decision }) => {
        const ids = knownRunIds(itemsRef.current)
        if (
          (decision.runId !== undefined && ids.has(decision.runId)) ||
          (decision.workflowRunId !== undefined && ids.has(decision.workflowRunId))
        ) {
          scheduleRefresh()
        }
      }),
      window.teskra.events.subscribe('workflow.run_updated', ({ runId }) => {
        // A Workflow card is created before its run id is known to the
        // thread, so run updates always re-read the projection; the expanded
        // card additionally refreshes its steps.
        scheduleRefresh()
        if (workflowDetailRef.current?.run.id === runId) void refreshWorkflowDetail(runId)
      }),
      window.teskra.events.subscribe('workflow.step_updated', ({ runId }) => {
        if (workflowDetailRef.current?.run.id === runId) void refreshWorkflowDetail(runId)
      }),
    ]

    void refresh()
    return () => {
      active = false
      window.clearTimeout(refreshTimerRef.current)
      for (const stop of stops) stop()
    }
  }, [taskId, fetchProjection])

  const toggleWorkflow = (workflowRunId: string): void => {
    if (workflowDetail?.run.id === workflowRunId) {
      setWorkflowDetail(undefined)
      return
    }
    setWorkflowLoading(true)
    void window.teskra.workflow
      .getRun({ runId: workflowRunId })
      .then((result) => {
        if (result.ok) {
          setWorkflowDetail(result.data ?? undefined)
        } else {
          setError(result.error)
        }
      })
      .catch(() => setError(transportError()))
      .finally(() => setWorkflowLoading(false))
  }

  const resolveDecision = async (decisionId: string, optionId: string): Promise<void> => {
    setResolvingId(decisionId)
    try {
      const result = await window.teskra.decision.resolve({ id: decisionId, optionId })
      if (!result.ok) {
        setError(result.error)
        return
      }
      // The decision.resolved event refreshes the item; update eagerly too so
      // the buttons collapse without waiting for the debounce.
      const decision = result.data
      setItems((current) =>
        mergeThreadItems(current, [
          {
            kind: 'decision',
            id: `decision:${decision.id}`,
            createdAt: decision.createdAt,
            decisionId: decision.id,
            ...(decision.runId === undefined ? {} : { runId: decision.runId }),
            ...(decision.workflowRunId === undefined
              ? {}
              : { workflowRunId: decision.workflowRunId }),
            decisionKind: decision.kind,
            severity: decision.severity,
            status: decision.status,
            title: decision.title,
            options: decision.options,
            ...(decision.resolution === undefined ? {} : { resolution: decision.resolution }),
          },
        ]),
      )
    } catch {
      setError(transportError())
    } finally {
      setResolvingId(undefined)
    }
  }

  const pick = async (item: ThreadDecisionItem, option: DecisionOption): Promise<void> => {
    // Same special case as the Inbox: continue_with_account is a recorded
    // no-op on the Main side; the renderer runs the account-pick flow first.
    if (item.decisionKind === 'rate_limit' && option.id === 'continue_with_account') {
      if (item.runId === undefined) return
      const result = await window.teskra.agent.get({ runId: item.runId })
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.data === null) return
      setContinuedDecisionId(item.decisionId)
      openContinuation(result.data)
      return
    }
    await resolveDecision(item.decisionId, option.id)
  }

  const onContinued = (): void => {
    if (continuedDecisionId !== undefined) {
      void resolveDecision(continuedDecisionId, 'continue_with_account')
      setContinuedDecisionId(undefined)
    }
  }

  return (
    <div className="task-thread-panel">
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={() => setError(undefined)} />
      )}
      <Spin spinning={status === 'loading' && items.length === 0}>
        {items.length === 0 && status !== 'loading' ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('thread.empty')} />
        ) : (
          <div className="thread-timeline">
            {items.map((item) => {
              switch (item.kind) {
                case 'user_message':
                  return <UserMessageRow key={item.id} item={item} />
                case 'agent_reply':
                  return <AgentReplyRow key={item.id} item={item} />
                case 'agent_progress':
                  return <AgentProgressRow key={item.id} item={item} />
                case 'decision':
                  return (
                    <DecisionRow
                      key={item.id}
                      item={item}
                      resolving={resolvingId === item.decisionId}
                      onPick={(target, option) => void pick(target, option)}
                    />
                  )
                case 'system':
                  return (
                    <SystemRow
                      key={item.id}
                      item={item}
                      workflowDetail={
                        workflowDetail?.run.id === item.workflowRunId ? workflowDetail : undefined
                      }
                      workflowLoading={workflowLoading}
                      onToggleWorkflow={toggleWorkflow}
                      onOpenRun={onOpenRun}
                      onOpenTerminal={onOpenTerminal}
                    />
                  )
              }
            })}
          </div>
        )}
      </Spin>
      <ContinueWithAccountModal onContinued={onContinued} />
    </div>
  )
}
