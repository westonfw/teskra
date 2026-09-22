import { randomUUID } from 'node:crypto'

import {
  IPC_NAME_MAX,
  type IpcResult,
  type MessageDirectiveError,
  type MessageDirectives,
  type SendTaskMessageRequest,
  type SendTaskMessageResult,
} from '@teskra/contracts'
import { parseMessageDirectives } from '@teskra/shared'

import type { AgentManager } from '../agents/agent-manager'
import type { DefaultSelectionService } from '../agents/default-selection-service'
import type { ProfileAliasManager } from '../agents/profile-alias-manager'
import type { ReviewerService } from '../agents/reviewer-service'
import type { AccountProfileRepository } from '../db/repositories'
import { type InternalAppError, toPublicError } from '../errors'
import type { WorktreeManager } from '../git/worktree-manager'
import { getLogger } from '../logger'
import type { FullWorkflowService } from '../workflows/full-workflow-service'
import type { TaskManager } from './task-manager'

/**
 * TASK-135/136 (Milestone 26 §7/§9/§11) — SendTaskMessageService: the Main
 * side of `teskra:task:send-message`, the thread-first quick-start entry
 * point.
 *
 * TASK-136 added the message directives (`parseMessageDirectives`,
 * @teskra/shared — pure, no IO). The message is parsed FIRST; a structured
 * parse error (unknown directive, illegal value, mixed `@` + `/`, …) is a
 * VALIDATION_FAILED with the 1-based line number and starts nothing. The
 * parsed directives then pick the branch:
 *
 * - **run** (no `/workflow`, no `@mention`): directives override the
 *   TASK-134 ResolvedRunDefaults for this send only — `/agent`, `/account`
 *   (alias → ProfileAliasManager, ADR-0011; a machine-local Profile id is
 *   accepted as-is), `/mode`, `/approval`, `/model`. `/mode attended` skips
 *   the worktree pre-build; `attended + manual` is rejected with an
 *   explanation (Milestone 26 §3 — the terminal launch card keeps that
 *   combination). An orchestrated Run still pre-builds its worktree with the
 *   FullWorkflowService pattern (ADR-0002) and discards it when the start
 *   fails.
 * - **review** (`@<agentId> <text>`): ReviewerService.startReview with the
 *   mention's agent as reviewer and the text as prompt (TASK-052).
 * - **workflow** (`/workflow full [--test "<cmd>"]`): FullWorkflowService.start
 *   with `--test` overriding the Build/Test command (TASK-063); `/agent`
 *   maps to the implementer. Like the launch dialog, the call settles when
 *   the workflow settles.
 *
 * In every branch an absent `taskId` is created from the message BODY (the
 * text after the directive block): first line (trimmed, truncated to
 * IPC_NAME_MAX) is the title, the remaining lines the description.
 */
export interface SendTaskMessageService {
  sendMessage(request: SendTaskMessageRequest): Promise<IpcResult<SendTaskMessageResult>>
}

export interface SendTaskMessageServiceDeps {
  readonly tasks: Pick<TaskManager, 'create' | 'get'>
  readonly defaults: Pick<DefaultSelectionService, 'resolveDefaults'>
  readonly worktreeManager: Pick<WorktreeManager, 'create' | 'discard'>
  readonly agents: Pick<AgentManager, 'start'>
  readonly reviewer: Pick<ReviewerService, 'startReview'>
  readonly fullWorkflow: Pick<FullWorkflowService, 'start'>
  readonly profileAliases: Pick<ProfileAliasManager, 'resolveAgentNodeProfiles'>
  readonly accountProfiles: Pick<AccountProfileRepository, 'getById'>
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

/** Parse failure → keyed VALIDATION_FAILED; nothing has been started yet. */
function directiveFailure<T>(error: MessageDirectiveError): IpcResult<T> {
  const params: Record<string, string | number> = {
    line: error.line,
    ...(error.directive === undefined ? {} : { directive: error.directive }),
    ...(error.value === undefined ? {} : { value: error.value }),
  }
  const base = {
    code: 'VALIDATION_FAILED' as const,
    retryable: false,
    detail: `send-message directive parse failed at line ${String(error.line)}: ${error.reason}`,
  }
  switch (error.reason) {
    case 'directive-line-too-long':
      return fail({
        ...base,
        message: error.message,
        messageKey: 'errorMessage.messageDirectiveLineTooLong',
        params,
      })
    case 'unknown-directive':
      return fail({
        ...base,
        message: error.message,
        messageKey: 'errorMessage.messageDirectiveUnknown',
        params,
      })
    case 'invalid-value':
      return fail({
        ...base,
        message: error.message,
        messageKey: 'errorMessage.messageDirectiveInvalidValue',
        params,
      })
    case 'duplicate-directive':
      return fail({
        ...base,
        message: error.message,
        messageKey: 'errorMessage.messageDirectiveDuplicate',
        params,
      })
    case 'mixed-mention':
      return fail({
        ...base,
        message: error.message,
        messageKey: 'errorMessage.messageDirectiveMixedMention',
        params,
      })
    case 'incompatible-directive':
      return fail({
        ...base,
        message: error.message,
        messageKey: 'errorMessage.messageDirectiveIncompatible',
        params,
      })
    case 'missing-body':
      return fail({
        ...base,
        message: error.message,
        messageKey: 'errorMessage.messageDirectiveMissingBody',
        params,
      })
  }
}

export function createSendTaskMessageService(
  deps: SendTaskMessageServiceDeps,
): SendTaskMessageService {
  const logger = getLogger('runtime')
  const createAgentRunId = deps.createAgentRunId ?? randomUUID

  /**
   * `/account <alias|id>`: a machine-local AccountProfile id is used as-is
   * (AgentManager validates the agent match at start); anything else goes
   * through the ADR-0011 alias binding table and fails closed when unbound.
   */
  const resolveAccount = (agentType: string, value: string): IpcResult<string> => {
    const byId = deps.accountProfiles.getById(value)
    if (!byId.ok) return byId
    if (byId.data !== null) return { ok: true, data: byId.data.id }
    const resolved = deps.profileAliases.resolveAgentNodeProfiles({
      agentId: agentType,
      accountProfileAlias: value,
      source: 'send-message /account directive',
    })
    if (!resolved.ok) return resolved
    if (resolved.data.accountProfileId === undefined) {
      return invalid(
        `Account "${value}" could not be resolved.`,
        `send-message /account: alias resolution returned no accountProfileId for ${JSON.stringify(value)}`,
      )
    }
    return { ok: true, data: resolved.data.accountProfileId }
  }

  return {
    async sendMessage(request) {
      // Parse before ANY side effect: a directive error starts nothing.
      const parsed = parseMessageDirectives(request.text)
      if (!parsed.ok) return directiveFailure(parsed.error)
      const directives = parsed.directives

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

      /** Absent taskId → create the Task from the message body. */
      const ensureTask = (bodyText: string): IpcResult<string> => {
        if (taskId !== undefined) return { ok: true, data: taskId }
        const draft = splitTaskMessageText(bodyText)
        if (draft.title === '') {
          return invalid(
            'The first line of the message must name the Task.',
            `SendTaskMessageService got an empty first line (text length=${bodyText.length})`,
          )
        }
        const created = deps.tasks.create({
          workspaceId: request.workspaceId,
          title: draft.title,
          ...(draft.description === undefined ? {} : { description: draft.description }),
        })
        if (!created.ok) return created
        taskId = created.data.id
        return { ok: true, data: taskId }
      }

      if (directives.branch === 'review') {
        return startReview(request, directives, ensureTask)
      }
      if (directives.branch === 'workflow') {
        return startWorkflow(request, directives, ensureTask)
      }
      return startRun(request, directives, ensureTask)

      async function startReview(
        req: SendTaskMessageRequest,
        parsed1: MessageDirectives,
        ensure: (bodyText: string) => IpcResult<string>,
      ): Promise<IpcResult<SendTaskMessageResult>> {
        const ensured = ensure(parsed1.prompt)
        if (!ensured.ok) return ensured
        const started = await deps.reviewer.startReview({
          workspaceId: req.workspaceId,
          agentType: parsed1.reviewerAgentId ?? '',
          taskId: ensured.data,
          prompt: parsed1.prompt,
        })
        if (!started.ok) return started
        return { ok: true, data: { taskId: ensured.data, kind: 'review', id: started.data.run.id } }
      }

      async function startWorkflow(
        req: SendTaskMessageRequest,
        parsed1: MessageDirectives,
        ensure: (bodyText: string) => IpcResult<string>,
      ): Promise<IpcResult<SendTaskMessageResult>> {
        if (taskId === undefined && parsed1.prompt === '') {
          return fail({
            code: 'VALIDATION_FAILED',
            message:
              'The /workflow directive needs a task: send it from a Task page, or add a body line to create one.',
            messageKey: 'errorMessage.messageDirectiveWorkflowNeedsTask',
            retryable: false,
            detail: 'send-message /workflow full without taskId and without a message body',
          })
        }
        const ensured = ensure(parsed1.prompt)
        if (!ensured.ok) return ensured
        const started = await deps.fullWorkflow.start({
          workspaceId: req.workspaceId,
          taskId: ensured.data,
          ...(parsed1.agentType === undefined ? {} : { implementer: parsed1.agentType }),
          ...(parsed1.testCommand === undefined ? {} : { testCommand: parsed1.testCommand }),
          ...(parsed1.model === undefined ? {} : { model: parsed1.model }),
        })
        if (!started.ok) return started
        return {
          ok: true,
          data: { taskId: ensured.data, kind: 'workflow', id: started.data.run.id },
        }
      }

      async function startRun(
        req: SendTaskMessageRequest,
        parsed1: MessageDirectives,
        ensure: (bodyText: string) => IpcResult<string>,
      ): Promise<IpcResult<SendTaskMessageResult>> {
        // Resolve before any side effect: with no available Agent the send
        // fails clean (the UI disables the input on this VALIDATION_FAILED).
        const defaults = await deps.defaults.resolveDefaults({ workspaceId: req.workspaceId })
        if (!defaults.ok) return defaults

        const agentType = parsed1.agentType ?? req.overrides?.agentType ?? defaults.data.agentType
        let accountProfileId: string | undefined
        if (parsed1.account !== undefined) {
          const resolved = resolveAccount(agentType, parsed1.account)
          if (!resolved.ok) return resolved
          accountProfileId = resolved.data
        } else {
          accountProfileId = req.overrides?.accountProfileId ?? defaults.data.accountProfileId
        }
        const executionProfileId =
          req.overrides?.executionProfileId ?? defaults.data.executionProfileId
        const executionMode = parsed1.executionMode ?? defaults.data.executionMode
        const approvalMode = parsed1.approvalMode ?? defaults.data.approvalMode

        // Milestone 26 §3: attended + manual stays exclusive to the terminal
        // launch card — the thread has no terminal to answer a manual prompt.
        if (executionMode === 'attended' && approvalMode === 'manual') {
          return fail({
            code: 'VALIDATION_FAILED',
            message:
              'An attended run cannot require manual approval from the thread input — there is no terminal to answer it. Drop /approval manual, or launch from the terminal card on the Runs tab.',
            messageKey: 'errorMessage.attendedManualRejected',
            retryable: false,
            detail: 'send-message rejected /mode attended + /approval manual',
          })
        }

        const ensured = ensure(parsed1.prompt)
        if (!ensured.ok) return ensured
        const ensuredTaskId = ensured.data

        // `/mode attended`: no worktree — the run shares the main workspace
        // (the UI's attended banner covers the ADR-0002 isolation story).
        if (executionMode === 'attended') {
          const started = await deps.agents.start({
            workspaceId: req.workspaceId,
            taskId: ensuredTaskId,
            agentType,
            mode: defaults.data.mode,
            executionMode,
            approvalMode,
            ...(accountProfileId === undefined ? {} : { accountProfileId }),
            ...(executionProfileId === undefined ? {} : { executionProfileId }),
            ...(parsed1.model === undefined ? {} : { model: parsed1.model }),
            prompt: parsed1.prompt,
          })
          if (!started.ok) return started
          return { ok: true, data: { taskId: ensuredTaskId, kind: 'run', id: started.data.id } }
        }

        const runId = createAgentRunId()
        const worktree = await deps.worktreeManager.create({
          workspaceId: req.workspaceId,
          runId,
          taskId: ensuredTaskId,
          agentId: agentType,
          isolation: defaults.data.isolation,
        })
        if (!worktree.ok) return worktree

        const started = await deps.agents.start({
          workspaceId: req.workspaceId,
          taskId: ensuredTaskId,
          agentType,
          runId,
          worktreeId: worktree.data.id,
          ...(accountProfileId === undefined ? {} : { accountProfileId }),
          ...(executionProfileId === undefined ? {} : { executionProfileId }),
          mode: defaults.data.mode,
          executionMode,
          approvalMode,
          ...(parsed1.model === undefined ? {} : { model: parsed1.model }),
          prompt: parsed1.prompt,
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
              logger.error(
                { worktreeId: worktree.data.id, cause },
                'Thread worktree discard threw.',
              )
            })
          return started
        }

        return { ok: true, data: { taskId: ensuredTaskId, kind: 'run', id: started.data.id } }
      }
    },
  }
}
