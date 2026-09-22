import { randomUUID } from 'node:crypto'

import {
  IPC_NAME_MAX,
  type IpcResult,
  type SendTaskMessageRequest,
  type SendTaskMessageResult,
} from '@teskra/contracts'

import type { AgentManager } from '../agents/agent-manager'
import type { DefaultSelectionService } from '../agents/default-selection-service'
import { type InternalAppError, toPublicError } from '../errors'
import type { WorktreeManager } from '../git/worktree-manager'
import { getLogger } from '../logger'
import type { TaskManager } from './task-manager'

/**
 * TASK-135 (Milestone 26 §9/§11) — SendTaskMessageService: the Main side of
 * `teskra:task:send-message`, the thread-first quick-start entry point.
 *
 * TASK-135 implements the `kind: 'run'` branch only (the 'review' /
 * 'workflow' kinds arrive with the TASK-136 message directives; the result
 * schema already carries them):
 *
 * 1. `taskId` given → the Task must exist and belong to the request's
 *    workspace; absent → the Task is created from the message: first line
 *    (trimmed, truncated to IPC_NAME_MAX) is the title, the remaining lines
 *    the description.
 * 2. Defaults come from DefaultSelectionService (TASK-134); per-send
 *    `overrides` replace only the Agent / account / execution profile. The
 *    thread-mode hard constraints are NOT overridable — the assembled
 *    StartAgentRunRequest always launches `exec` / `orchestrated` /
 *    `safe-auto`, so the attended + manual combination cannot be reached
 *    through this entry point (Milestone 26 §3).
 * 3. The worktree is pre-built with the FullWorkflowService pattern
 *    (ADR-0002: an orchestrated Run without a worktree must be refused):
 *    pre-allocate the Run id, create the worktree bound to it, start the
 *    Run inside it, and discard the worktree (best-effort) when the start
 *    fails so no orphan is left behind.
 */
export interface SendTaskMessageService {
  sendMessage(request: SendTaskMessageRequest): Promise<IpcResult<SendTaskMessageResult>>
}

export interface SendTaskMessageServiceDeps {
  readonly tasks: Pick<TaskManager, 'create' | 'get'>
  readonly defaults: Pick<DefaultSelectionService, 'resolveDefaults'>
  readonly worktreeManager: Pick<WorktreeManager, 'create' | 'discard'>
  readonly agents: Pick<AgentManager, 'start'>
  readonly createAgentRunId?: () => string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

/**
 * Message → Task draft: the first line (trimmed, truncated to IPC_NAME_MAX)
 * becomes the title, the remaining lines the description. An empty first
 * line yields an empty title — the caller refuses the send.
 */
export function splitTaskMessageText(text: string): { title: string; description?: string } {
  const [firstLine, ...rest] = text.split('\n')
  const title = (firstLine ?? '').trim().slice(0, IPC_NAME_MAX)
  const description = rest.join('\n').trim()
  return description === '' ? { title } : { title, description }
}

export function createSendTaskMessageService(
  deps: SendTaskMessageServiceDeps,
): SendTaskMessageService {
  const logger = getLogger('runtime')
  const createAgentRunId = deps.createAgentRunId ?? randomUUID

  return {
    async sendMessage(request) {
      let taskId = request.taskId
      if (taskId !== undefined) {
        const task = deps.tasks.get(taskId)
        if (!task.ok) return task
        if (task.data === null) {
          return invalid(
            `Task "${taskId}" was not found.`,
            `SendTaskMessageService could not resolve task id=${JSON.stringify(taskId)}`,
          )
        }
        if (task.data.workspaceId !== request.workspaceId) {
          return invalid(
            'The task belongs to a different workspace.',
            `task workspace=${task.data.workspaceId} send workspace=${request.workspaceId}`,
          )
        }
      }

      // Resolve before any side effect: with no available Agent the send
      // fails clean (the UI disables the input on this VALIDATION_FAILED).
      const defaults = await deps.defaults.resolveDefaults({ workspaceId: request.workspaceId })
      if (!defaults.ok) return defaults

      if (taskId === undefined) {
        const draft = splitTaskMessageText(request.text)
        if (draft.title === '') {
          return invalid(
            'The first line of the message must name the Task.',
            `SendTaskMessageService got an empty first line (text length=${request.text.length})`,
          )
        }
        const created = deps.tasks.create({
          workspaceId: request.workspaceId,
          title: draft.title,
          ...(draft.description === undefined ? {} : { description: draft.description }),
        })
        if (!created.ok) return created
        taskId = created.data.id
      }

      const agentType = request.overrides?.agentType ?? defaults.data.agentType
      const accountProfileId = request.overrides?.accountProfileId ?? defaults.data.accountProfileId
      const executionProfileId =
        request.overrides?.executionProfileId ?? defaults.data.executionProfileId

      const runId = createAgentRunId()
      const worktree = await deps.worktreeManager.create({
        workspaceId: request.workspaceId,
        runId,
        taskId,
        agentId: agentType,
        isolation: defaults.data.isolation,
      })
      if (!worktree.ok) return worktree

      const started = await deps.agents.start({
        workspaceId: request.workspaceId,
        taskId,
        agentType,
        runId,
        worktreeId: worktree.data.id,
        ...(accountProfileId === undefined ? {} : { accountProfileId }),
        ...(executionProfileId === undefined ? {} : { executionProfileId }),
        // Thread-mode hard constraints (Milestone 26 §3): never attended,
        // never manual — the attended + manual combination stays exclusive
        // to the terminal launch card.
        mode: defaults.data.mode,
        executionMode: defaults.data.executionMode,
        approvalMode: defaults.data.approvalMode,
        prompt: request.text.trim(),
      })
      if (!started.ok) {
        // FullWorkflowService failure hygiene: never leave an orphan
        // worktree behind when the Run could not be started.
        void deps.worktreeManager
          .discard({ worktreeId: worktree.data.id, confirm: true })
          .then((discarded) => {
            if (!discarded.ok) {
              logger.error(
                { worktreeId: worktree.data.id, error: discarded.error },
                'Failed to discard the thread worktree after a run-start failure.',
              )
            }
          })
          .catch((cause: unknown) => {
            logger.error({ worktreeId: worktree.data.id, cause }, 'Thread worktree discard threw.')
          })
        return started
      }

      return { ok: true, data: { taskId, kind: 'run', id: started.data.id } }
    },
  }
}
