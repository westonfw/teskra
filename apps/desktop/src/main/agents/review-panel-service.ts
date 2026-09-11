import { randomUUID } from 'node:crypto'

import type {
  AgentRun,
  IpcResult,
  ReviewConsensus,
  ReviewDisagreement,
  ReviewFindingRecord,
  ReviewIsolation,
  ReviewPanel,
  ReviewPanelMemberResult,
  ReviewPanelResult,
  ReviewReviewerSummary,
  ReviewSeverity,
  ReviewVerdict,
  StartReviewPanelRequest,
  WorkbenchEvents,
} from '@teskra/contracts'
import { reviewAggregateSchema } from '@teskra/contracts'
import {
  buildHandoffContext,
  computeReviewVerdict,
  DEFAULT_REVIEW_AGGREGATION_POLICY,
  type ReviewAggregationPolicy,
} from '@teskra/shared'

import type { AgentManager } from './agent-manager'
import type { AgentRegistry } from './agent-registry'
import type { ReviewerService } from './reviewer-service'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type {
  ReviewPanel as ReviewPanelRow,
  ReviewRepository,
} from '../db/repositories/review-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import type { PromptTemplateService } from '../prompts/prompt-template-service'

/**
 * ReviewPanelService (TASK-060, teskra-tasks.md; plan §141/§142) — the Review
 * Panel orchestration primitive:
 *
 *   Diff ├→ Claude Review ├→ Codex Review └→ Future Reviewer
 *
 * For every requested reviewer the service launches ONE independent reviewer
 * Run through ReviewerService (TASK-052 isolation tiers apply unchanged), all
 * in parallel, then waits for every Run to reach a terminal state and
 * converges the panel:
 *
 * - one `review_panels` row per panel, one `review_panel_members` row per
 *   reviewer (the per-reviewer independent review record), each reviewer's
 *   findings stay on its own Run and are back-linked to the panel;
 * - every member gets a verdict ('approve' when the Run completed with no
 *   findings, 'changes_requested' when it reported any, 'unable_to_review'
 *   when the Run did not complete);
 * - the panel row's `aggregate_json` receives the plan §141 ReviewAggregate —
 *   per-reviewer summaries, all findings most-severe-first, and explicitly
 *   preserved disagreements (never majority-collapsed). The TASK-061 Review
 *   Aggregator is the consumer of this record (it adds the severity-policy
 *   verdict on top of the same carrier).
 *
 * Mutual isolation guarantee: every reviewer's prompt is rendered BEFORE any
 * reviewer Run is started, from exactly the same inputs — the task, the
 * confirmed acceptance criteria, and the IMPLEMENT run's handoff only
 * (reviewer runs are excluded from handoff resolution, so no reviewer can
 * ever receive another reviewer's findings/handoff/scores in its context).
 * The per-reviewer prompt differs only in that reviewer's own ADR-0004 env
 * paths, derived from its pre-allocated Run id.
 *
 * Launch-failure hygiene: if any reviewer fails to START, the reviewers that
 * did start are cancelled best-effort and the panel is marked 'failed' — a
 * panel never silently runs short of its requested reviewers.
 */
export interface ReviewPanelService {
  /**
   * Settles only when EVERY reviewer Run is terminal — the returned promise
   * can take as long as the slowest reviewer. A reviewer that fails is NOT an
   * IPC error: its member verdict becomes 'unable_to_review' and the panel
   * still converges. Only when every reviewer is unable to review does the
   * panel end 'failed'.
   */
  startPanel(request: StartReviewPanelRequest): Promise<IpcResult<ReviewPanelResult>>
  getPanel(panelId: string): IpcResult<ReviewPanelResult | null>
  listPanels(taskId: string): IpcResult<ReviewPanel[]>
  /** Best-effort: cancels every still-active reviewer Run of the panel. */
  cancelPanel(panelId: string): void
  dispose(): void
}

export interface ReviewPanelServiceDeps {
  readonly registry: Pick<AgentRegistry, 'get'>
  readonly reviewer: Pick<ReviewerService, 'startReview'>
  readonly agents: Pick<AgentManager, 'cancel'>
  readonly runs: Pick<AgentRunRepository, 'getById' | 'listByTask'>
  readonly worktrees: Pick<WorktreeRepository, 'getById'>
  readonly reviews: ReviewRepository
  readonly tasks: Pick<TaskRepository, 'getById'>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly criteria: Pick<CriteriaRepository, 'listSetsByTask' | 'listCriteria'>
  readonly handoffs: Pick<HandoffRepository, 'getByRunId'>
  readonly promptTemplates: Pick<PromptTemplateService, 'render'>
  readonly paths: TeskraPaths
  readonly events: EventBus<WorkbenchEvents>
  /**
   * TASK-061: resolves the severity policy for the Review Aggregator from the
   * config layers (TASK-080); defaults to the built-in policy when absent. A
   * resolution failure degrades to "no verdict" (logged), never blocks panel
   * convergence.
   */
  readonly resolvePolicy?: (workspaceId: string) => IpcResult<ReviewAggregationPolicy>
  readonly createPanelId?: () => string
  readonly createMemberId?: () => string
  readonly createRunId?: () => string
  readonly now?: () => string
}

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRun['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

const SEVERITY_ORDER: readonly ReviewSeverity[] = ['critical', 'high', 'medium', 'low']

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

function countSeverities(findings: readonly ReviewFindingRecord[]) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

/** Most severe first; stable within one severity by creation order. */
function sortFindings(findings: readonly ReviewFindingRecord[]): ReviewFindingRecord[] {
  return [...findings].sort(
    (left, right) =>
      SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity) ||
      left.createdAt.localeCompare(right.createdAt),
  )
}

interface MemberConvergence {
  readonly memberId: string
  readonly runId: string
  readonly agentId: string
  readonly isolation: ReviewIsolation
  readonly terminal: AgentRun['status']
  readonly findings: readonly ReviewFindingRecord[]
  readonly verdict: ReviewVerdict
}

/**
 * Explicitly preserves every point where reviewers disagree (plan §141/§142):
 * differing member verdicts, and findings on the same criterion or file
 * reported with differing severities by different reviewers.
 */
function computeDisagreements(members: readonly MemberConvergence[]): ReviewDisagreement[] {
  const disagreements: ReviewDisagreement[] = []
  const agentOf = new Map(members.map((member) => [member.runId, member.agentId]))

  if (new Set(members.map((member) => member.verdict)).size > 1) {
    disagreements.push({
      kind: 'verdict',
      subject: 'panel',
      positions: members.map((member) => ({
        runId: member.runId,
        agentId: member.agentId,
        position: member.verdict,
      })),
    })
  }

  const groups = new Map<string, ReviewFindingRecord[]>()
  for (const member of members) {
    for (const finding of member.findings) {
      const subject =
        finding.criterionId !== undefined
          ? `criterion:${finding.criterionId}`
          : finding.file !== undefined
            ? `location:${finding.file}`
            : undefined
      if (subject === undefined) continue
      const group = groups.get(subject) ?? []
      group.push(finding)
      groups.set(subject, group)
    }
  }
  for (const [subject, findings] of groups) {
    const runIds = new Set(findings.map((finding) => finding.runId))
    const severities = new Set(findings.map((finding) => finding.severity))
    if (runIds.size < 2 || severities.size < 2) continue
    const [kind, ...rest] = subject.split(':')
    disagreements.push({
      kind: kind === 'criterion' ? 'criterion' : 'location',
      subject: rest.join(':'),
      positions: findings.map((finding) => ({
        runId: finding.runId,
        agentId: agentOf.get(finding.runId) ?? finding.runId,
        position:
          finding.line === undefined
            ? finding.severity
            : `${finding.severity} (line ${String(finding.line)})`,
      })),
    })
  }
  return disagreements
}

function computeConsensus(members: readonly MemberConvergence[]): ReviewConsensus {
  const verdicts = members.map((member) => member.verdict)
  if (verdicts.every((verdict) => verdict === 'approve')) return 'approve'
  if (verdicts.every((verdict) => verdict === 'changes_requested')) return 'changes_requested'
  return 'mixed'
}

export function createReviewPanelService(deps: ReviewPanelServiceDeps): ReviewPanelService {
  const logger = getLogger('agent')
  const createPanelId = deps.createPanelId ?? randomUUID
  const createMemberId = deps.createMemberId ?? randomUUID
  const createRunId = deps.createRunId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())

  /** runId → terminal status listener, for panels waiting on convergence. */
  const waiters = new Map<string, (status: AgentRun['status']) => void>()
  /** panelId → reviewer run ids, for cancelPanel. */
  const activeRuns = new Map<string, Set<string>>()

  const subscriptions = [
    deps.events.subscribe('agent.completed', ({ runId }) => waiters.get(runId)?.('completed')),
    deps.events.subscribe('agent.failed', ({ runId }) => waiters.get(runId)?.('failed')),
    deps.events.subscribe('agent.cancelled', ({ runId }) => waiters.get(runId)?.('cancelled')),
    deps.events.subscribe('agent.interrupted', ({ runId }) => waiters.get(runId)?.('interrupted')),
  ]

  const emitPanel = (panel: ReviewPanelRow): void => {
    deps.events.emit('review.panel_updated', {
      panelId: panel.id,
      taskId: panel.taskId,
      status: panel.status,
    })
  }

  /**
   * Storage keeps `aggregate_json` opaque; the public projection re-validates
   * it against the contracts schema. A malformed blob degrades to "no
   * aggregate" with a warning instead of breaking the whole panel read (the
   * IPC router response validation would reject it anyway).
   */
  const toPublicPanel = (panel: ReviewPanelRow): ReviewPanel => {
    let aggregate = undefined
    if (panel.aggregate !== undefined) {
      const parsed = reviewAggregateSchema.safeParse(panel.aggregate)
      if (parsed.success) {
        aggregate = parsed.data
      } else {
        logger.warn({ panelId: panel.id }, 'Persisted panel aggregate failed validation; dropping it.')
      }
    }
    return {
      id: panel.id,
      taskId: panel.taskId,
      ...(panel.workflowRunId === undefined ? {} : { workflowRunId: panel.workflowRunId }),
      ...(panel.targetArtifactId === undefined ? {} : { targetArtifactId: panel.targetArtifactId }),
      ...(panel.criteriaSetId === undefined ? {} : { criteriaSetId: panel.criteriaSetId }),
      status: panel.status,
      ...(panel.consensus === undefined ? {} : { consensus: panel.consensus }),
      ...(aggregate === undefined ? {} : { aggregate }),
      createdAt: panel.createdAt,
      ...(panel.completedAt === undefined ? {} : { completedAt: panel.completedAt }),
    }
  }

  /**
   * The implement run whose handoff feeds `{{previousHandoff}}`. Reviewer
   * runs are deliberately EXCLUDED — a reviewer's handoff carries findings
   * and scores, and feeding those to another reviewer would break the mutual
   * isolation the panel exists for.
   */
  const resolveImplementRunId = (request: StartReviewPanelRequest): IpcResult<string | undefined> => {
    if (request.targetRunId !== undefined) {
      const run = deps.runs.getById(request.targetRunId)
      if (!run.ok) return run
      if (run.data === null) {
        return invalid(
          `Agent run "${request.targetRunId}" was not found.`,
          `ReviewPanelService could not resolve target run id=${JSON.stringify(request.targetRunId)}`,
        )
      }
      return { ok: true, data: run.data.id }
    }
    if (request.targetWorktreeId !== undefined) {
      const worktree = deps.worktrees.getById(request.targetWorktreeId)
      if (!worktree.ok) return worktree
      if (worktree.data === null) {
        return invalid(
          `Worktree "${request.targetWorktreeId}" was not found.`,
          `ReviewPanelService could not resolve worktree id=${JSON.stringify(request.targetWorktreeId)}`,
        )
      }
      return { ok: true, data: worktree.data.runId }
    }
    const taskRuns = deps.runs.listByTask(request.taskId)
    if (!taskRuns.ok) return taskRuns
    const latest = taskRuns.data
      .filter(
        (run) =>
          run.workspaceId === request.workspaceId &&
          run.worktreeId !== undefined &&
          run.role !== 'reviewer',
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return { ok: true, data: latest?.id }
  }

  /** Waits for every run to reach a terminal state; seeds from current state. */
  const waitForTerminal = (runIds: readonly string[]): Promise<Map<string, AgentRun['status']>> => {
    const outcomes = new Map<string, AgentRun['status']>()
    return new Promise((resolve) => {
      const pending = new Set<string>()
      for (const runId of runIds) {
        const run = deps.runs.getById(runId)
        if (run.ok && run.data !== null && TERMINAL_RUN_STATUSES.has(run.data.status)) {
          outcomes.set(runId, run.data.status)
          continue
        }
        pending.add(runId)
        waiters.set(runId, (status) => {
          outcomes.set(runId, status)
          waiters.delete(runId)
          pending.delete(runId)
          if (pending.size === 0) resolve(outcomes)
        })
      }
      if (pending.size === 0) resolve(outcomes)
    })
  }

  const assemble = (row: ReviewPanelRow): IpcResult<ReviewPanelResult> => {
    const members = deps.reviews.listMembers(row.id)
    if (!members.ok) return members
    const panel = toPublicPanel(row)
    const isolationByRun = new Map(
      panel.aggregate?.reviewers.map((reviewer) => [reviewer.runId, reviewer.isolation]) ?? [],
    )
    const results: ReviewPanelMemberResult[] = []
    for (const member of members.data) {
      const findings = deps.reviews.listFindingsByRun(member.runId)
      if (!findings.ok) return findings
      const isolation = isolationByRun.get(member.runId)
      results.push({
        member,
        ...(isolation === undefined ? {} : { isolation }),
        findings: findings.data,
      })
    }
    return { ok: true, data: { panel, members: results } }
  }

  return {
    async startPanel(request) {
      const task = deps.tasks.getById(request.taskId)
      if (!task.ok) return task
      if (task.data === null) {
        return invalid(
          `Task "${request.taskId}" was not found.`,
          `ReviewPanelService could not resolve task id=${JSON.stringify(request.taskId)}`,
        )
      }
      if (task.data.workspaceId !== request.workspaceId) {
        return invalid(
          'The task belongs to a different workspace.',
          `task workspace=${task.data.workspaceId} panel workspace=${request.workspaceId}`,
        )
      }
      const workspace = deps.workspaces.getById(request.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) {
        return invalid(
          `Workspace "${request.workspaceId}" was not found.`,
          `ReviewPanelService could not resolve workspace id=${JSON.stringify(request.workspaceId)}`,
        )
      }
      const taskRow = task.data
      const repoRoot = workspace.data.path
      for (const agentId of request.reviewers) {
        if (deps.registry.get(agentId) === undefined) {
          return invalid(
            `Agent "${agentId}" is not registered.`,
            `ReviewPanelService could not resolve reviewer agent=${JSON.stringify(agentId)}`,
          )
        }
      }

      const sets = deps.criteria.listSetsByTask(request.taskId)
      if (!sets.ok) return sets
      const confirmed = sets.data
        .filter((set) => set.status === 'confirmed')
        .sort((a, b) => b.version - a.version)[0]
      let criteriaDescriptions: string[] | undefined
      if (confirmed !== undefined) {
        const rows = deps.criteria.listCriteria(confirmed.id)
        if (!rows.ok) return rows
        criteriaDescriptions = rows.data.map((criterion) => criterion.description)
      }

      const implementRunId = resolveImplementRunId(request)
      if (!implementRunId.ok) return implementRunId
      let previousHandoff: string | undefined
      if (implementRunId.data !== undefined) {
        const handoff = deps.handoffs.getByRunId(implementRunId.data)
        if (!handoff.ok) return handoff
        previousHandoff = buildHandoffContext(handoff.data)
      }

      const panelId = createPanelId()
      const created = deps.reviews.createPanel({
        id: panelId,
        taskId: request.taskId,
        ...(request.workflowRunId === undefined ? {} : { workflowRunId: request.workflowRunId }),
        ...(confirmed === undefined ? {} : { criteriaSetId: confirmed.id }),
      })
      if (!created.ok) return created
      emitPanel(created.data)

      // Launch every reviewer in parallel. All prompts are rendered here —
      // before ANY reviewer Run exists — from identical inputs, so no reviewer
      // can observe another reviewer's output (see the file-level comment).
      // Run ids are pre-allocated and their terminal-state waiters registered
      // BEFORE any launch, so a reviewer that terminates within milliseconds
      // of starting can never race past the convergence wait.
      const runIds = request.reviewers.map(() => createRunId())
      const terminal = waitForTerminal(runIds)
      interface Launched {
        readonly agentId: string
        readonly runId: string
        readonly isolation: ReviewIsolation
      }
      const launched: Launched[] = []
      let launchError: IpcResult<never> | undefined
      await Promise.all(
        request.reviewers.map(async (agentId, index) => {
          if (launchError !== undefined) return
          const runId = runIds[index] as string
          const runFiles = deps.paths.runFiles(runId)
          if (!runFiles.ok) {
            launchError = runFiles
            return
          }
          let prompt = request.prompt
          if (prompt === undefined) {
            const rendered = deps.promptTemplates.render(
              {
                name: 'review',
                context: {
                  task: {
                    title: taskRow.title,
                    description: taskRow.description ?? '',
                  },
                  ...(criteriaDescriptions === undefined ? {} : { criteria: criteriaDescriptions }),
                  role: 'reviewer',
                  ...(previousHandoff === undefined ? {} : { previousHandoff }),
                  env: {
                    TESKRA_HANDOFF_PATH: runFiles.data.handoff,
                    TESKRA_ARTIFACT_DIR: runFiles.data.artifacts,
                  },
                },
              },
              repoRoot,
            )
            if (!rendered.ok) {
              launchError = rendered
              return
            }
            prompt = rendered.data.content
          }
          const started = await deps.reviewer.startReview({
            workspaceId: request.workspaceId,
            agentType: agentId,
            runId,
            taskId: request.taskId,
            ...(request.targetRunId === undefined ? {} : { targetRunId: request.targetRunId }),
            ...(request.targetWorktreeId === undefined
              ? {}
              : { targetWorktreeId: request.targetWorktreeId }),
            prompt,
          })
          if (!started.ok) {
            launchError = started
            return
          }
          launched.push({ agentId, runId: started.data.run.id, isolation: started.data.isolation })
        }),
      )

      if (launchError !== undefined) {
        // Compensating action: never let a partial panel run short of its
        // requested reviewers — cancel whoever started, then fail the panel.
        for (const runId of runIds) waiters.delete(runId)
        for (const entry of launched) {
          void deps.agents.cancel(entry.runId).catch((cause: unknown) => {
            logger.error({ runId: entry.runId, cause }, 'Panel reviewer cancel threw.')
          })
        }
        const failed = deps.reviews.updatePanel(panelId, {
          status: 'failed',
          completedAt: now(),
        })
        if (failed.ok && failed.data !== null) emitPanel(failed.data)
        return launchError
      }

      const memberRuns = new Set<string>()
      activeRuns.set(panelId, memberRuns)
      const members: { id: string; agentId: string; runId: string; isolation: ReviewIsolation }[] =
        []
      for (const entry of launched) {
        const added = deps.reviews.addMember({
          id: createMemberId(),
          panelId,
          runId: entry.runId,
          agentId: entry.agentId,
        })
        if (!added.ok) return added
        memberRuns.add(entry.runId)
        members.push({
          id: added.data.id,
          agentId: entry.agentId,
          runId: entry.runId,
          isolation: entry.isolation,
        })
      }

      const outcomes = await terminal
      activeRuns.delete(panelId)

      // Converge: per-reviewer verdicts, panel-link the findings, consensus,
      // then the plan §141 aggregate carrier the TASK-061 aggregator consumes.
      const convergence: MemberConvergence[] = []
      for (const member of members) {
        const terminal = outcomes.get(member.runId) ?? 'interrupted'
        const findings = deps.reviews.listFindingsByRun(member.runId)
        if (!findings.ok) return findings
        const verdict: ReviewVerdict =
          terminal !== 'completed'
            ? 'unable_to_review'
            : findings.data.length === 0
              ? 'approve'
              : 'changes_requested'
        const updated = deps.reviews.setMemberVerdict(member.id, verdict)
        if (!updated.ok) return updated
        const linked = deps.reviews.assignFindingsToPanel(panelId, member.runId)
        if (!linked.ok) return linked
        convergence.push({
          memberId: member.id,
          runId: member.runId,
          agentId: member.agentId,
          isolation: member.isolation,
          terminal,
          findings: findings.data,
          verdict,
        })
      }

      if (convergence.every((member) => member.verdict === 'unable_to_review')) {
        const failed = deps.reviews.updatePanel(panelId, {
          status: 'failed',
          completedAt: now(),
        })
        if (!failed.ok) return failed
        if (failed.data !== null) emitPanel(failed.data)
        return failed.data === null
          ? invalid('The review panel vanished while converging.', `panel ${panelId} update missed`)
          : assemble(failed.data)
      }

      const consensus = computeConsensus(convergence)
      const reviewers: ReviewReviewerSummary[] = convergence.map((member) => ({
        runId: member.runId,
        agentId: member.agentId,
        verdict: member.verdict,
        isolation: member.isolation,
        findings: countSeverities(member.findings),
      }))
      const findings = sortFindings(convergence.flatMap((member) => member.findings))
      // TASK-061: the Review Aggregator evaluates the converged panel against
      // the configured severity policy (never majority voting); disagreements
      // stay untouched in the same aggregate record. A policy-resolution
      // failure degrades to "no verdict" — it never blocks convergence.
      let policy: ReviewAggregationPolicy | undefined = DEFAULT_REVIEW_AGGREGATION_POLICY
      if (deps.resolvePolicy !== undefined) {
        const resolved = deps.resolvePolicy(request.workspaceId)
        if (resolved.ok) {
          policy = resolved.data
        } else {
          policy = undefined
          logger.warn(
            { panelId, error: resolved.error },
            'Review aggregation policy unavailable; recording no verdict.',
          )
        }
      }
      const computation =
        policy === undefined ? undefined : computeReviewVerdict({ findings, reviewers }, policy)
      const aggregate = {
        panelId,
        consensus,
        reviewers,
        findings,
        disagreements: computeDisagreements(convergence),
        ...(computation === undefined
          ? {}
          : { verdict: computation.verdict, reasons: computation.reasons }),
      }
      const completed = deps.reviews.updatePanel(panelId, {
        status: 'completed',
        consensus,
        aggregate,
        completedAt: now(),
      })
      if (!completed.ok) return completed
      if (completed.data === null) {
        return invalid('The review panel vanished while converging.', `panel ${panelId} update missed`)
      }
      emitPanel(completed.data)
      return assemble(completed.data)
    },

    getPanel(panelId) {
      const panel = deps.reviews.getPanelById(panelId)
      if (!panel.ok) return panel
      if (panel.data === null) return { ok: true, data: null }
      return assemble(panel.data)
    },

    listPanels(taskId) {
      const panels = deps.reviews.listPanelsByTask(taskId)
      if (!panels.ok) return panels
      return { ok: true, data: panels.data.map(toPublicPanel) }
    },

    cancelPanel(panelId) {
      const runIds = activeRuns.get(panelId)
      if (runIds === undefined) return
      for (const runId of runIds) {
        void deps.agents.cancel(runId).catch((cause: unknown) => {
          logger.error({ panelId, runId, cause }, 'Panel reviewer cancel threw.')
        })
      }
    },

    dispose() {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
      waiters.clear()
      activeRuns.clear()
    },
  }
}
