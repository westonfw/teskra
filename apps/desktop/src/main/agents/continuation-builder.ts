import type { AgentContinuation, AgentContinuationReason, AgentRun } from '@teskra/contracts'
import { CONTINUATION_PROMPT_MAX } from '@teskra/contracts'
import { buildHandoffContext } from '@teskra/shared'

import type { Handoff } from '../db/repositories/handoff-repository'

/**
 * ContinuationBuilder (TASK-107, Milestone 24 §20) — builds the
 * AgentContinuation context package from the source run and its collected
 * handoff (ADR-0004), then renders it as the target run's prompt. Pure
 * functions: the caller (AgentManager.continueWithProfile) supplies every
 * repository read.
 */

/** Bounded tail of the source run's terminal output folded into the prompt. */
const CONTINUATION_OUTPUT_CONTEXT_CHARS = 4_000
/** Prompt-side cap for a single handoff/context block. */
const CONTINUATION_BLOCK_MAX_CHARS = 8_000

export interface BuildAgentContinuationInput {
  readonly sourceRun: AgentRun
  readonly reason: AgentContinuationReason
  /** HandoffRepository.getByRunId(sourceRunId) — null when none was collected. */
  readonly handoff?: Handoff | null | undefined
  readonly artifactIds?: readonly string[] | undefined
  readonly acceptanceCriteria?: readonly unknown[] | undefined
  /** Bounded tail of the source run's terminal output (fallback summary). */
  readonly outputTail?: string | undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/**
 * §20: the context package. `summary` prefers the Agent-declared handoff
 * summary and falls back to the rendered handoff block, then to the output
 * tail — a continuation never carries an empty summary.
 */
export function buildAgentContinuation(input: BuildAgentContinuationInput): AgentContinuation {
  const { sourceRun, handoff } = input
  const payload = handoff?.payload ?? {}
  const declaredSummary = typeof payload['summary'] === 'string' ? payload['summary'] : undefined
  const handoffContext = buildHandoffContext(handoff ?? undefined)
  const outputTail = (input.outputTail ?? '').trim()
  const summary =
    declaredSummary ??
    (handoffContext !== undefined && handoffContext.length > 0
      ? clamp(handoffContext, CONTINUATION_BLOCK_MAX_CHARS)
      : outputTail.length > 0
        ? clamp(outputTail, CONTINUATION_OUTPUT_CONTEXT_CHARS)
        : 'The source run produced no summary.')
  const changedFiles = stringList(payload['filesChanged'])
  return {
    sourceRunId: sourceRun.id,
    reason: input.reason,
    ...(sourceRun.taskId === undefined ? {} : { taskId: sourceRun.taskId }),
    workspaceId: sourceRun.workspaceId,
    ...(sourceRun.worktreeId === undefined ? {} : { worktreeId: sourceRun.worktreeId }),
    summary,
    ...(changedFiles.length === 0 ? {} : { changedFiles }),
    ...(input.artifactIds === undefined || input.artifactIds.length === 0
      ? {}
      : { artifactIds: [...input.artifactIds] }),
    ...(input.acceptanceCriteria === undefined || input.acceptanceCriteria.length === 0
      ? {}
      : { acceptanceCriteria: [...input.acceptanceCriteria] }),
    previousAgentId: sourceRun.agentType,
    ...(sourceRun.accountProfileId === undefined
      ? {}
      : { previousAccountProfileId: sourceRun.accountProfileId }),
  }
}

/**
 * Renders the continuation as the target run's prompt (§19.2 / §39 — Context
 * / Handoff continuation, never a native session resume). Same shape as the
 * resume context: original request, handoff, recent output, and the standing
 * instruction to inspect before writing. TASK-139: the thread's new user
 * message joins as its own section right after the Handoff summary, and the
 * whole prompt is capped at CONTINUATION_PROMPT_MAX (the user message shrinks
 * first so the carried context survives).
 */
export function buildContinuationPrompt(
  continuation: AgentContinuation,
  options: {
    originalPrompt?: string | undefined
    outputTail?: string | undefined
    userMessage?: string | undefined
  } = {},
): string {
  const output = (options.outputTail ?? '').slice(-CONTINUATION_OUTPUT_CONTEXT_CHARS).trim()
  const changedFiles = continuation.changedFiles ?? []
  const artifacts = continuation.artifactIds ?? []
  const criteria = continuation.acceptanceCriteria ?? []
  const header =
    continuation.reason === 'user-message'
      ? `Continue Teskra Run ${continuation.sourceRunId} — this is the SAME task continued with a new message from the user, not a new task. The previous Agent's changes are already in the workspace; build on them.`
      : `Continue Teskra Run ${continuation.sourceRunId} — this is the SAME task continued under a new Agent account (${continuation.reason}), not a new task. The previous Agent's changes are already in the workspace; build on them.`
  const render = (userMessageSection: string | undefined): string =>
    [
      header,
      options.originalPrompt === undefined
        ? undefined
        : `Original request:\n${options.originalPrompt}`,
      `Handoff summary:\n${continuation.summary}`,
      userMessageSection,
      changedFiles.length === 0 ? undefined : `Files changed so far:\n${changedFiles.join('\n')}`,
      artifacts.length === 0
        ? undefined
        : `Artifact ids from the previous run:\n${artifacts.join('\n')}`,
      criteria.length === 0
        ? undefined
        : `Acceptance criteria:\n${criteria.map((criterion) => JSON.stringify(criterion)).join('\n')}`,
      output.length === 0 ? undefined : `Recent Agent output:\n${output}`,
      'Inspect the current files before changing them and continue the unfinished work.',
    ]
      .filter((part): part is string => part !== undefined)
      .join('\n\n')

  const userMessage = options.userMessage?.trim()
  const USER_MESSAGE_HEADER = "The user's new message:\n"
  let userMessageSection: string | undefined
  if (userMessage !== undefined && userMessage.length > 0) {
    // §19.2: the continuation prompt never exceeds the normal IPC text
    // budget — the user message absorbs the clamp before anything else.
    const budget =
      CONTINUATION_PROMPT_MAX - render(undefined).length - 2 - USER_MESSAGE_HEADER.length
    if (budget > 0) {
      userMessageSection = USER_MESSAGE_HEADER + userMessage.slice(0, budget)
    }
  }
  const prompt = render(userMessageSection)
  return prompt.length <= CONTINUATION_PROMPT_MAX
    ? prompt
    : prompt.slice(0, CONTINUATION_PROMPT_MAX)
}
