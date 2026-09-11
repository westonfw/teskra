import type {
  BuildContextRequest,
  BuiltContext,
  ContextPart,
  IpcResult,
  Memory,
  MemoryType,
} from '@teskra/contracts'
import { buildHandoffContext } from '@teskra/shared'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import { type InternalAppError, toPublicError } from '../errors'
import type { MemoryManager } from './memory-manager'

/**
 * ContextBuilder (TASK-068, plan §47) — assembles the prompt context an
 * Agent Run starts with:
 *
 *   Task + Role + Acceptance Criteria + Workspace Memory + Previous Handoff
 *
 * It deliberately does NOT inject the whole history: candidate sections are
 * prioritized (task > role > confirmed criteria > previous handoff > memory
 * by type), then greedily packed under `budgetChars`; whatever does not fit
 * is dropped lowest-priority-first and counted in `omittedCount`.
 *
 * The assembled `content` is the single final artifact: PromptTemplateService
 * consumes the memory section as the `{{memory}}` variable (see
 * DispatchService) and Agent Adapters only ever receive the rendered final
 * prompt — they never gather context themselves.
 */

export const DEFAULT_CONTEXT_BUDGET_CHARS = 8000

const PRIORITY_TASK = 100
const PRIORITY_ROLE = 90
const PRIORITY_CRITERIA = 80
const PRIORITY_PREVIOUS_HANDOFF = 70

/** Memory type weights: operational pitfalls and architecture outrank notes. */
const MEMORY_TYPE_PRIORITY: Readonly<Record<MemoryType, number>> = {
  known_issue: 60,
  architecture: 55,
  decision: 50,
  convention: 40,
  preference: 30,
  command: 20,
  summary: 10,
}

interface Candidate {
  readonly key: string
  readonly priority: number
  /** Tiebreak within a priority: newer memories first. */
  readonly tiebreak: string
  readonly content: string
}

export interface ContextBuilder {
  buildContext(request: BuildContextRequest): IpcResult<BuiltContext>
}

export interface ContextBuilderDeps {
  readonly tasks: TaskRepository
  readonly criteria: CriteriaRepository
  readonly runs: AgentRunRepository
  readonly handoffs: HandoffRepository
  readonly memory: Pick<MemoryManager, 'list'>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function memoryPart(memory: Memory): string {
  return `### Memory · ${memory.type}\n${memory.content}`
}

/**
 * Greedy budget packing. The separator between assembled sections ("\n\n")
 * is accounted per included part so `totalChars` (the real content length)
 * never exceeds the budget.
 */
function packCandidates(
  candidates: readonly Candidate[],
  budgetChars: number,
): { parts: ContextPart[]; omittedCount: number } {
  const ordered = [...candidates].sort(
    (left, right) =>
      right.priority - left.priority || right.tiebreak.localeCompare(left.tiebreak),
  )
  const included: Candidate[] = []
  let used = 0
  let omittedCount = 0
  for (const candidate of ordered) {
    const cost = candidate.content.length + (included.length > 0 ? 2 : 0)
    if (used + cost <= budgetChars) {
      included.push(candidate)
      used += cost
    } else {
      omittedCount += 1
    }
  }
  // Assemble in reading order, not packing order.
  const assemblyRank = (candidate: Candidate): number => {
    if (candidate.key === 'task') return 0
    if (candidate.key === 'role') return 1
    if (candidate.key === 'criteria') return 2
    if (candidate.key.startsWith('memory:')) return 3
    return 4
  }
  included.sort(
    (left, right) =>
      assemblyRank(left) - assemblyRank(right) ||
      right.priority - left.priority ||
      right.tiebreak.localeCompare(left.tiebreak),
  )
  return {
    parts: included.map(({ key, content }) => ({ key, content, chars: content.length })),
    omittedCount,
  }
}

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  return {
    buildContext({ workspaceId, taskId, role, budgetChars }) {
      const budget = budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
      const candidates: Candidate[] = []

      if (taskId !== undefined) {
        const task = deps.tasks.getById(taskId)
        if (!task.ok) {
          return task
        }
        if (task.data === null) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: `Task "${taskId}" was not found.`,
            retryable: false,
            detail: `ContextBuilder could not resolve task id=${JSON.stringify(taskId)}`,
          })
        }
        const description = task.data.description ?? ''
        candidates.push({
          key: 'task',
          priority: PRIORITY_TASK,
          tiebreak: '',
          content: `## Task: ${task.data.title}${description.length > 0 ? `\n${description}` : ''}`,
        })

        const sets = deps.criteria.listSetsByTask(taskId)
        if (!sets.ok) {
          return sets
        }
        const confirmed = sets.data
          .filter((set) => set.status === 'confirmed')
          .sort((left, right) => right.version - left.version)[0]
        if (confirmed !== undefined) {
          const rows = deps.criteria.listCriteria(confirmed.id)
          if (!rows.ok) {
            return rows
          }
          if (rows.data.length > 0) {
            candidates.push({
              key: 'criteria',
              priority: PRIORITY_CRITERIA,
              tiebreak: '',
              content: `## Acceptance Criteria\n${rows.data
                .map((criterion) => `- ${criterion.description}`)
                .join('\n')}`,
            })
          }
        }

        const runs = deps.runs.listByTask(taskId)
        if (!runs.ok) {
          return runs
        }
        const newestFirst = [...runs.data].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )
        for (const run of newestFirst) {
          const handoff = deps.handoffs.getByRunId(run.id)
          if (!handoff.ok) {
            return handoff
          }
          const rendered = buildHandoffContext(handoff.data)
          if (rendered !== undefined) {
            candidates.push({
              key: 'previousHandoff',
              priority: PRIORITY_PREVIOUS_HANDOFF,
              tiebreak: run.createdAt,
              content: `## Previous Handoff\n${rendered}`,
            })
            break
          }
        }
      }

      if (role !== undefined) {
        candidates.push({
          key: 'role',
          priority: PRIORITY_ROLE,
          tiebreak: '',
          content: `## Role\n${role}`,
        })
      }

      const memories = deps.memory.list({ workspaceId })
      if (!memories.ok) {
        return memories
      }
      for (const memory of memories.data) {
        candidates.push({
          key: `memory:${memory.id}`,
          priority: MEMORY_TYPE_PRIORITY[memory.type],
          tiebreak: memory.updatedAt,
          content: memoryPart(memory),
        })
      }

      const { parts, omittedCount } = packCandidates(candidates, budget)
      const content = parts.map((part) => part.content).join('\n\n')
      return {
        ok: true,
        data: {
          workspaceId,
          ...(taskId === undefined ? {} : { taskId }),
          ...(role === undefined ? {} : { role }),
          budgetChars: budget,
          totalChars: content.length,
          omittedCount,
          parts,
          content,
        },
      }
    },
  }
}
