import {
  APPROVAL_MODES,
  MESSAGE_DIRECTIVE_NAMES,
  type PublicAppError,
  type ResolvedRunDefaults,
  type RunDefaultReason,
  type SendTaskMessageOverrides,
  type SendTaskMessageRequest,
} from '@teskra/contracts'

import { hasTranslationKey, type Translation } from '../i18n'

/**
 * TASK-135 (Milestone 26 §12) — the pure model behind QuickStartInput: how
 * the resolved defaults render as the one-line gray summary, and how the
 * expandable editor's edits become the per-send `overrides` of the
 * `teskra:task:send-message` request.
 */

/** Edits from the expandable defaults row; they apply to the next send only. */
export interface QuickStartEdits {
  readonly agentType?: string | undefined
  /** Explicit account profile; undefined = auto (resolved default / CLI home). */
  readonly accountProfileId?: string | undefined
}

/**
 * A resolve-defaults VALIDATION_FAILED is the "no available Agent" answer
 * (TASK-134 fallback level 5): the input is disabled and the UI links to
 * Settings → Agents. Any other error leaves the input usable — the send
 * itself surfaces it.
 */
export function isNoAgentAvailable(error: PublicAppError): boolean {
  return error.code === 'VALIDATION_FAILED'
}

/**
 * The request assembled for one send. Note what is NOT here: `mode`,
 * `executionMode` and `approvalMode` never leave the Renderer — the
 * thread-mode hard constraints (exec / orchestrated / safe-auto) are applied
 * Main-side, so the attended + manual combination cannot be assembled from
 * this entry point.
 */
export function buildSendMessageRequest(input: {
  readonly workspaceId: string
  readonly taskId?: string | undefined
  readonly text: string
  readonly edits?: QuickStartEdits | undefined
}): SendTaskMessageRequest {
  const overrides: SendTaskMessageOverrides = {
    ...(input.edits?.agentType === undefined ? {} : { agentType: input.edits.agentType }),
    ...(input.edits?.accountProfileId === undefined
      ? {}
      : { accountProfileId: input.edits.accountProfileId }),
  }
  return {
    workspaceId: input.workspaceId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    text: input.text,
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
  }
}

/**
 * The gray defaults line: 「agent · 账号 · 模式 · 审批」. Mode and approval
 * are the fixed thread-mode values (design doc §12: isolated · safe-auto).
 */
export function formatRunDefaultsSummary(
  defaults: ResolvedRunDefaults,
  accountName: string | undefined,
  t: Translation['t'],
): string {
  const account =
    defaults.accountProfileId === undefined
      ? t('quickStart.account.auto')
      : (accountName ?? defaults.accountProfileId)
  return [
    defaults.agentType,
    account,
    t('quickStart.executionMode.orchestrated'),
    t('quickStart.approvalMode.safeAuto'),
  ].join(' · ')
}

/** One localized line per reason — the tooltip behind the defaults summary. */
export function runDefaultsReasonLines(
  reasons: readonly RunDefaultReason[],
  t: Translation['t'],
): string[] {
  return reasons.map((reason) =>
    hasTranslationKey(reason.key) ? t(reason.key, reason.params) : reason.key,
  )
}

// --------------------------------------------------------------------
// TASK-136 (Milestone 26 §7/§12): `/` and `@` directive completion.
// --------------------------------------------------------------------

/**
 * What the caret is currently completing. Candidates come ONLY from the known
 * sets (directive table, AgentRegistry ids, account aliases/profile ids) —
 * never from free text.
 */
export type DirectiveCompletionKind =
  'directive' | 'agent' | 'account' | 'mode' | 'approval' | 'workflow' | 'mention'

export interface DirectiveCompletion {
  readonly kind: DirectiveCompletionKind
  /** Start index of the token the selected value replaces. */
  readonly start: number
  /** End index of the replaced range (the caret). */
  readonly end: number
  /** The partial token (including the leading `/` / `@` for directive/mention). */
  readonly query: string
}

const COMPLETABLE_ARGUMENT_DIRECTIVES: Readonly<Record<string, DirectiveCompletionKind>> = {
  '/agent': 'agent',
  '/account': 'account',
  '/mode': 'mode',
  '/approval': 'approval',
  '/workflow': 'workflow',
}

/**
 * The completion context at `caret`, or undefined when the caret is not on a
 * completable token — body text, a `/model` argument, a second argument, or a
 * `/` line after the leading directive block (mirrors the parser's
 * positional rule: directives only live in the leading consecutive lines).
 */
export function getDirectiveCompletion(
  text: string,
  caret: number,
): DirectiveCompletion | undefined {
  const position = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\n', position - 1) + 1
  const segment = text.slice(lineStart, position)
  const leading = segment.length - segment.trimStart().length
  const trimmed = segment.trimStart()

  if (trimmed.startsWith('@')) {
    // The mention lives on the very first line only, as its first token.
    if (lineStart !== 0 || /\s/.test(trimmed)) return undefined
    return { kind: 'mention', start: lineStart + leading, end: position, query: trimmed }
  }
  if (!trimmed.startsWith('/')) return undefined
  // Positional rule: every line above must be a directive line too.
  const prior = text.slice(0, lineStart === 0 ? 0 : lineStart - 1)
  if (prior !== '' && !prior.split('\n').every((line) => line.trim().startsWith('/'))) {
    return undefined
  }

  const endsWithSpace = /\s$/.test(trimmed)
  const tokens = (endsWithSpace ? trimmed.trimEnd() : trimmed).split(/\s+/)
  if (tokens.length === 1 && !endsWithSpace) {
    return { kind: 'directive', start: lineStart + leading, end: position, query: trimmed }
  }
  // Argument completion: only the first argument of the known directives.
  const argumentPosition = endsWithSpace ? tokens.length : tokens.length - 1
  if (argumentPosition !== 1) return undefined
  const kind = COMPLETABLE_ARGUMENT_DIRECTIVES[tokens[0] ?? '']
  if (kind === undefined) return undefined
  const query = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '')
  return { kind, start: position - query.length, end: position, query }
}

export interface DirectiveCompletionCandidates {
  /** AgentRegistry ids. */
  readonly agentIds: readonly string[]
  /** Account aliases (TASK-111) + machine-local account profile ids. */
  readonly accounts: readonly string[]
}

export interface DirectiveCompletionOption {
  /** Full replacement text for the token under completion (keeps the trailing space). */
  readonly value: string
  readonly label: string
}

const MODE_COMPLETIONS = ['attended', 'isolated'] as const

/** Prefix-filtered candidates for one completion context; never free text. */
export function buildDirectiveCompletionOptions(
  completion: DirectiveCompletion,
  candidates: DirectiveCompletionCandidates,
  t: Translation['t'],
): DirectiveCompletionOption[] {
  const query = completion.query.toLowerCase()
  const match = (value: string): boolean => value.toLowerCase().startsWith(query)
  switch (completion.kind) {
    case 'directive':
      return MESSAGE_DIRECTIVE_NAMES.filter((name) => `/${name}`.startsWith(query)).map((name) => ({
        value: `/${name} `,
        label: `/${name} — ${t(`quickStart.completion.directive.${name}`)}`,
      }))
    case 'mention':
      return candidates.agentIds
        .filter((id) => `@${id}`.toLowerCase().startsWith(query))
        .map((id) => ({ value: `@${id} `, label: `@${id}` }))
    case 'agent':
      return candidates.agentIds.filter(match).map((id) => ({ value: `${id} `, label: id }))
    case 'account':
      return candidates.accounts
        .filter(match)
        .map((id) => ({ value: `${id} `, label: `${id} — ${t('quickStart.completion.account')}` }))
    case 'mode':
      return MODE_COMPLETIONS.filter(match).map((value) => ({
        value: `${value} `,
        label: t(`quickStart.completion.mode.${value}`),
      }))
    case 'approval':
      return APPROVAL_MODES.filter(match).map((value) => ({ value: `${value} `, label: value }))
    case 'workflow':
      return ['full'].filter(match).map((value) => ({
        value: `${value} `,
        label: `/workflow ${value}`,
      }))
  }
}

/** Splices the selected option into the text and reports the new caret. */
export function applyDirectiveCompletion(
  text: string,
  completion: DirectiveCompletion,
  value: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, completion.start) + value + text.slice(completion.end),
    caret: completion.start + value.length,
  }
}
