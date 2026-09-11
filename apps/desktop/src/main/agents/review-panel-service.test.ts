import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult, StartReviewRunRequest, WorkbenchEvents } from '@teskra/contracts'
import type { ReviewAggregationPolicy } from '@teskra/shared'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createCriteriaRepository,
  createHandoffRepository,
  createReviewRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import { createPromptTemplateService } from '../prompts/prompt-template-service'
import { createReviewPanelService, type ReviewPanelService } from './review-panel-service'

/**
 * TASK-060 acceptance: reviewers are mutually isolated (no reviewer prompt
 * contains another reviewer's products), reviews run in parallel, every
 * reviewer produces an independent result (own member row + own findings),
 * and a converged panel produces the aggregate record.
 */

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function requireRecord<T>(result: IpcResult<T | null>): T {
  const data = requireOk(result)
  if (data === null) throw new Error('expected a record, got null')
  return data
}

interface Fixture {
  readonly service: ReviewPanelService
  readonly events: EventBus<WorkbenchEvents>
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly reviews: ReturnType<typeof createReviewRepository>
  readonly handoffs: ReturnType<typeof createHandoffRepository>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly reviewerCalls: StartReviewRunRequest[]
  readonly cancel: ReturnType<typeof vi.fn>
  readonly failAgents: Set<string>
}

function setup(options: { policy?: ReviewAggregationPolicy } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-review-panel-'))
  directories.push(directory)
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(database)

  const workspaces = createWorkspaceRepository(database)
  const tasks = createTaskRepository(database)
  const runs = createAgentRunRepository(database)
  const reviews = createReviewRepository(database)
  const handoffs = createHandoffRepository(database)
  const criteria = createCriteriaRepository(database)
  const worktrees = createWorktreeRepository(database)
  requireOk(
    workspaces.create(
      {
        id: 'ws-1',
        name: 'Panel fixture',
        runtime: { kind: 'wsl', distro: 'Ubuntu' },
        path: directory,
      },
      '2026-09-10T00:00:00.000Z',
    ),
  )
  requireOk(
    tasks.create(
      { id: 'task-1', workspaceId: 'ws-1', title: 'Panel task', description: 'Review me' },
      '2026-09-10T00:00:01.000Z',
    ),
  )

  const events = createEventBus<WorkbenchEvents>()
  const paths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data-root') })
  const promptTemplates = createPromptTemplateService({ paths })
  const reviewerCalls: StartReviewRunRequest[] = []
  const failAgents = new Set<string>()
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, data: undefined as never }))

  const reviewer = {
    startReview: vi.fn(async (request: StartReviewRunRequest) => {
      reviewerCalls.push(request)
      if (failAgents.has(request.agentType)) {
        return {
          ok: false as const,
          error: {
            code: 'UNKNOWN' as const,
            message: `${request.agentType} refused to start.`,
            retryable: true,
          },
        }
      }
      const run = requireOk(
        runs.create({
          id: request.runId as string,
          workspaceId: request.workspaceId,
          agentType: request.agentType,
          executionMode: 'orchestrated',
          runDir: join(directory, 'runs', request.runId as string),
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          role: 'reviewer',
          status: 'running',
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        }),
      )
      return { ok: true as const, data: { run, isolation: 'shared-readonly' as const } }
    }),
  }

  let panelTick = 0
  let memberTick = 0
  let runTick = 0
  let clockTick = 0
  const service = createReviewPanelService({
    registry: { get: (id: string) => (id === 'ghost' ? undefined : ({ id }) as never) },
    reviewer,
    agents: { cancel },
    runs,
    worktrees,
    reviews,
    tasks,
    workspaces,
    criteria,
    handoffs,
    promptTemplates,
    paths,
    events,
    createPanelId: () => `panel-${String(++panelTick)}`,
    createMemberId: () => `member-${String(++memberTick)}`,
    createRunId: () => `review-run-${String(++runTick)}`,
    now: () => `2026-09-10T00:10:${String(clockTick++).padStart(2, '0')}.000Z`,
    ...(options.policy === undefined
      ? {}
      : { resolvePolicy: () => ({ ok: true as const, data: options.policy as ReviewAggregationPolicy }) }),
  })

  return { service, events, runs, reviews, handoffs, worktrees, reviewerCalls, cancel, failAgents }
}

/** Implement run + handoff the panel reviews (the ONLY handoff reviewers may see). */
function implementRun(fixture: Fixture, runId = 'impl-run'): string {
  requireOk(
    fixture.runs.create({
      id: runId,
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'orchestrated',
      runDir: `/tmp/${runId}`,
      taskId: 'task-1',
      role: 'implementer',
      status: 'completed',
    }),
  )
  requireOk(
    fixture.handoffs.save({
      id: `handoff-${runId}`,
      runId,
      type: 'implementation',
      payload: { runId, type: 'implementation', summary: 'IMPLEMENT-SUMMARY-MARKER' },
      parseStatus: 'ok',
    }),
  )
  return runId
}

function completeReviewer(fixture: Fixture, runId: string): void {
  fixture.events.emit('agent.completed', { runId, exitCode: 0 })
}

function failReviewer(fixture: Fixture, runId: string): void {
  fixture.events.emit('agent.failed', {
    runId,
    error: { code: 'UNKNOWN', message: 'crashed', retryable: false },
  })
}

function callFor(fixture: Fixture, agentType: string, offset = 0): StartReviewRunRequest {
  const call = fixture.reviewerCalls.filter((request) => request.agentType === agentType)[offset]
  if (call === undefined) throw new Error(`no startReview call for ${agentType}`)
  return call
}

describe('ReviewPanelService', () => {
  it('launches every reviewer in parallel; the panel settles only after all are terminal', async () => {
    const fixture = setup()
    implementRun(fixture)
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(2))

    // Parallel: both reviewer runs exist in a non-terminal state at once.
    const first = requireRecord(fixture.runs.getById(callFor(fixture, 'claude').runId as string))
    const second = requireRecord(fixture.runs.getById(callFor(fixture, 'codex').runId as string))
    expect(first.status).toBe('running')
    expect(second.status).toBe('running')
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    completeReviewer(fixture, first.id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    completeReviewer(fixture, second.id)
    const result = requireOk(await pending)
    expect(result.panel.status).toBe('completed')
    expect(result.members).toHaveLength(2)
  })

  it('keeps reviewers mutually isolated: prompts carry only the implement handoff', async () => {
    const fixture = setup()
    implementRun(fixture)
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(2))
    const claude = callFor(fixture, 'claude')
    const codex = callFor(fixture, 'codex')
    completeReviewer(fixture, claude.runId as string)
    completeReviewer(fixture, codex.runId as string)
    requireOk(await pending)

    for (const call of [claude, codex]) {
      // The implement run's handoff is the only upstream context.
      expect(call.prompt).toContain('IMPLEMENT-SUMMARY-MARKER')
      // Each reviewer sees only its own ADR-0004 paths …
      expect(call.prompt).toContain(call.runId as string)
    }
    // … and never anything belonging to the other reviewer.
    expect(claude.prompt).not.toContain(codex.runId as string)
    expect(codex.prompt).not.toContain(claude.runId as string)
  })

  it('never feeds a previous panel reviewer’s findings or handoff to the next panel', async () => {
    const fixture = setup()
    implementRun(fixture)
    const first = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(1))
    const reviewerRunId = callFor(fixture, 'claude').runId as string
    requireOk(
      fixture.reviews.addFinding({
        id: 'finding-1',
        runId: reviewerRunId,
        severity: 'high',
        title: 'PANEL1-FINDING-MARKER',
      }),
    )
    requireOk(
      fixture.handoffs.save({
        id: 'handoff-reviewer-1',
        runId: reviewerRunId,
        type: 'review',
        payload: { runId: reviewerRunId, type: 'review', summary: 'REVIEWER1-HANDOFF-MARKER' },
        parseStatus: 'ok',
      }),
    )
    completeReviewer(fixture, reviewerRunId)
    requireOk(await first)

    const second = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['codex'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(2))
    const codex = callFor(fixture, 'codex')
    completeReviewer(fixture, codex.runId as string)
    requireOk(await second)

    expect(codex.prompt).toContain('IMPLEMENT-SUMMARY-MARKER')
    expect(codex.prompt).not.toContain('PANEL1-FINDING-MARKER')
    expect(codex.prompt).not.toContain('REVIEWER1-HANDOFF-MARKER')
    expect(codex.prompt).not.toContain(reviewerRunId)
  })

  it('resolves the previous handoff from the implement run, never from a reviewer run', async () => {
    const fixture = setup()
    // Both runs are worktree-bound; the reviewer run is NEWER, so a naive
    // "latest run with a worktree" lookup would pick it — the panel must not.
    requireOk(
      fixture.worktrees.create({
        id: 'wt-impl',
        workspaceId: 'ws-1',
        branch: 'agent/task-1/impl',
        baseBranch: 'main',
        path: '/tmp/wt-impl',
        isolation: 'worktree',
        runId: 'impl-run',
        state: 'ready',
      }),
    )
    requireOk(
      fixture.worktrees.create({
        id: 'wt-review',
        workspaceId: 'ws-1',
        branch: 'agent/task-1/review',
        baseBranch: 'main',
        path: '/tmp/wt-review',
        isolation: 'disposable-snapshot',
        runId: 'old-reviewer-run',
        state: 'ready',
      }),
    )
    requireOk(
      fixture.runs.create({
        id: 'impl-run',
        workspaceId: 'ws-1',
        agentType: 'codex',
        executionMode: 'orchestrated',
        runDir: '/tmp/impl-run',
        taskId: 'task-1',
        role: 'implementer',
        status: 'completed',
        worktreeId: 'wt-impl',
      }),
    )
    requireOk(
      fixture.handoffs.save({
        id: 'handoff-impl',
        runId: 'impl-run',
        type: 'implementation',
        payload: { runId: 'impl-run', type: 'implementation', summary: 'IMPLEMENT-SUMMARY-MARKER' },
        parseStatus: 'ok',
      }),
    )
    requireOk(
      fixture.runs.create({
        id: 'old-reviewer-run',
        workspaceId: 'ws-1',
        agentType: 'claude',
        executionMode: 'orchestrated',
        runDir: '/tmp/old-reviewer-run',
        taskId: 'task-1',
        role: 'reviewer',
        status: 'completed',
        worktreeId: 'wt-review',
      }),
    )
    requireOk(
      fixture.handoffs.save({
        id: 'handoff-old-reviewer',
        runId: 'old-reviewer-run',
        type: 'review',
        payload: {
          runId: 'old-reviewer-run',
          type: 'review',
          summary: 'OLD-REVIEWER-HANDOFF-MARKER',
        },
        parseStatus: 'ok',
      }),
    )

    // No explicit target: the panel resolves the latest worktree-bound run of
    // the task, skipping reviewer runs.
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['codex'],
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(1))
    const codex = callFor(fixture, 'codex')
    completeReviewer(fixture, codex.runId as string)
    requireOk(await pending)

    expect(codex.prompt).toContain('IMPLEMENT-SUMMARY-MARKER')
    expect(codex.prompt).not.toContain('OLD-REVIEWER-HANDOFF-MARKER')
    // The reviewer run's own worktree was not passed as the review target.
    expect(codex.targetWorktreeId).toBeUndefined()
    expect(codex.targetRunId).toBeUndefined()
  })

  it('produces independent per-reviewer results and a converged aggregate', async () => {
    const fixture = setup()
    implementRun(fixture)
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(2))
    const claude = callFor(fixture, 'claude')
    const codex = callFor(fixture, 'codex')
    requireOk(
      fixture.reviews.addFinding({
        id: 'finding-critical',
        runId: claude.runId as string,
        severity: 'critical',
        title: 'SQL injection',
        file: 'src/db.ts',
        line: 10,
      }),
    )
    completeReviewer(fixture, claude.runId as string)
    completeReviewer(fixture, codex.runId as string)
    const result = requireOk(await pending)

    // One panel row, one member row per reviewer, findings stay per-run.
    expect(result.panel.status).toBe('completed')
    expect(result.panel.consensus).toBe('mixed')
    const claudeMember = result.members.find((entry) => entry.member.agentId === 'claude')
    const codexMember = result.members.find((entry) => entry.member.agentId === 'codex')
    expect(claudeMember?.member.verdict).toBe('changes_requested')
    expect(codexMember?.member.verdict).toBe('approve')
    expect(claudeMember?.findings.map((finding) => finding.id)).toEqual(['finding-critical'])
    expect(codexMember?.findings).toEqual([])

    // The aggregate carrier: per-reviewer summaries, all findings,
    // disagreements preserved (verdict split is NOT majority-collapsed).
    const aggregate = result.panel.aggregate
    expect(aggregate).toBeDefined()
    expect(aggregate?.panelId).toBe(result.panel.id)
    expect(aggregate?.reviewers).toHaveLength(2)
    expect(
      aggregate?.reviewers.find((reviewer) => reviewer.agentId === 'claude')?.findings,
    ).toEqual({ critical: 1, high: 0, medium: 0, low: 0 })
    expect(aggregate?.findings.map((finding) => finding.id)).toEqual(['finding-critical'])
    expect(aggregate?.disagreements).toContainEqual(
      expect.objectContaining({ kind: 'verdict', subject: 'panel' }),
    )

    // Findings are back-linked to the panel; getPanel/listPanels read back.
    expect(
      requireOk(fixture.reviews.listFindingsByPanel(result.panel.id)).map((finding) => finding.id),
    ).toEqual(['finding-critical'])
    const reread = requireRecord(fixture.service.getPanel(result.panel.id))
    expect(reread.panel.aggregate?.reviewers).toHaveLength(2)
    expect(requireOk(fixture.service.listPanels('task-1'))).toHaveLength(1)
  })

  it('preserves location disagreements when reviewers rate the same file differently', async () => {
    const fixture = setup()
    implementRun(fixture)
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(2))
    const claude = callFor(fixture, 'claude')
    const codex = callFor(fixture, 'codex')
    requireOk(
      fixture.reviews.addFinding({
        id: 'finding-a',
        runId: claude.runId as string,
        severity: 'critical',
        title: 'Race condition',
        file: 'src/queue.ts',
      }),
    )
    requireOk(
      fixture.reviews.addFinding({
        id: 'finding-b',
        runId: codex.runId as string,
        severity: 'low',
        title: 'Queue naming',
        file: 'src/queue.ts',
      }),
    )
    completeReviewer(fixture, claude.runId as string)
    completeReviewer(fixture, codex.runId as string)
    const result = requireOk(await pending)

    const disagreement = result.panel.aggregate?.disagreements.find(
      (entry) => entry.kind === 'location',
    )
    expect(disagreement).toBeDefined()
    expect(disagreement?.subject).toBe('src/queue.ts')
    expect(disagreement?.positions).toHaveLength(2)
    expect(disagreement?.positions.map((position) => position.position)).toEqual([
      'critical',
      'low',
    ])
  })

  it('fails the panel and cancels started reviewers when a reviewer cannot launch', async () => {
    const fixture = setup()
    implementRun(fixture)
    fixture.failAgents.add('codex')
    const result = await fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      targetRunId: 'impl-run',
    })
    expect(result.ok).toBe(false)
    expect(fixture.cancel).toHaveBeenCalledWith(callFor(fixture, 'claude').runId as string)
    const panels = requireOk(fixture.service.listPanels('task-1'))
    expect(panels).toHaveLength(1)
    expect(panels[0]?.status).toBe('failed')
  })

  it('marks the panel failed when every reviewer is unable to review', async () => {
    const fixture = setup()
    implementRun(fixture)
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(2))
    failReviewer(fixture, callFor(fixture, 'claude').runId as string)
    failReviewer(fixture, callFor(fixture, 'codex').runId as string)
    const result = requireOk(await pending)

    expect(result.panel.status).toBe('failed')
    expect(result.members.every((entry) => entry.member.verdict === 'unable_to_review')).toBe(true)
  })

  it('rejects an unregistered reviewer before creating anything', async () => {
    const fixture = setup()
    implementRun(fixture)
    const result = await fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'ghost'],
      targetRunId: 'impl-run',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a validation failure')
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(fixture.reviewerCalls).toHaveLength(0)
    expect(requireOk(fixture.service.listPanels('task-1'))).toHaveLength(0)
  })
})

describe('ReviewPanelService aggregation (TASK-061)', () => {
  async function runPanel(
    fixture: Fixture,
    findings: { agent: string; severity: 'critical' | 'high' | 'medium' | 'low'; title: string }[],
    reviewers = ['claude', 'codex', 'gemini'],
  ) {
    implementRun(fixture)
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers,
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(reviewers.length))
    findings.forEach((finding, index) => {
      requireOk(
        fixture.reviews.addFinding({
          id: `policy-finding-${String(index)}`,
          runId: callFor(fixture, finding.agent).runId as string,
          severity: finding.severity,
          title: finding.title,
        }),
      )
    })
    for (const reviewer of reviewers) {
      completeReviewer(fixture, callFor(fixture, reviewer).runId as string)
    }
    return requireOk(await pending)
  }

  it('blocks on one critical finding even when the majority approves (no majority voting)', async () => {
    const fixture = setup()
    // 3 reviewers: 2 find nothing (approve), 1 reports a single critical.
    const result = await runPanel(fixture, [
      { agent: 'gemini', severity: 'critical', title: 'SQL injection' },
    ])
    expect(result.panel.consensus).toBe('mixed')
    expect(result.panel.aggregate?.verdict).toBe('block')
    expect(result.panel.aggregate?.reasons?.join(' ')).toContain('critical')
    // The verdict split stays visible as a preserved disagreement.
    expect(result.panel.aggregate?.disagreements).toContainEqual(
      expect.objectContaining({ kind: 'verdict' }),
    )
  })

  it('blocks on high findings and passes with only low/none', async () => {
    const high = await runPanel(setup(), [{ agent: 'claude', severity: 'high', title: 'XSS' }])
    expect(high.panel.aggregate?.verdict).toBe('block')

    const low = await runPanel(setup(), [{ agent: 'codex', severity: 'low', title: 'naming' }])
    expect(low.panel.aggregate?.verdict).toBe('pass')

    const none = await runPanel(setup(), [])
    expect(none.panel.aggregate?.verdict).toBe('pass')
  })

  it('applies the configured medium threshold from the resolved policy', async () => {
    const below = await runPanel(
      setup({ policy: { mediumBlockThreshold: 2 } }),
      [{ agent: 'claude', severity: 'medium', title: 'dup' }],
    )
    expect(below.panel.aggregate?.verdict).toBe('pass')

    const at = await runPanel(setup({ policy: { mediumBlockThreshold: 2 } }), [
      { agent: 'claude', severity: 'medium', title: 'dup' },
      { agent: 'codex', severity: 'medium', title: 'dead code' },
    ])
    expect(at.panel.aggregate?.verdict).toBe('block')
    expect(at.panel.aggregate?.reasons?.join(' ')).toContain('threshold')

    // Default policy (threshold 0): mediums never block.
    const defaults = await runPanel(setup(), [
      { agent: 'claude', severity: 'medium', title: 'a' },
      { agent: 'codex', severity: 'medium', title: 'b' },
      { agent: 'gemini', severity: 'medium', title: 'c' },
    ])
    expect(defaults.panel.aggregate?.verdict).toBe('pass')
  })

  it('notes partial coverage when a reviewer cannot complete, without flipping the verdict', async () => {
    const fixture = setup()
    implementRun(fixture)
    const pending = fixture.service.startPanel({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      targetRunId: 'impl-run',
    })
    await vi.waitFor(() => expect(fixture.reviewerCalls).toHaveLength(2))
    completeReviewer(fixture, callFor(fixture, 'claude').runId as string)
    failReviewer(fixture, callFor(fixture, 'codex').runId as string)
    const result = requireOk(await pending)

    expect(result.panel.aggregate?.verdict).toBe('pass')
    expect(result.panel.aggregate?.reasons?.join(' ')).toContain('could not complete')
  })
})
