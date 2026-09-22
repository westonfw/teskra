import type { ApprovalMode, ExecutionMode } from './agent'

/**
 * TASK-136 (Milestone 26 §7) — message directives for the thread-first input.
 *
 * The parser itself is the pure function `parseMessageDirectives` in
 * `@teskra/shared` (no IO, unit-testable); this module carries the structured
 * result types so both the parser and the Main-side send-message mapping
 * share one definition. The result never crosses IPC as-is — Main maps it
 * onto the existing Start requests (`StartAgentRunRequest` /
 * `StartReviewRunRequest` / `StartFullWorkflowRequest`).
 */

/** Slash directives recognized at the start of a message. */
export const MESSAGE_DIRECTIVE_NAMES = [
  'agent',
  'account',
  'mode',
  'approval',
  'model',
  'workflow',
] as const
export type MessageDirectiveName = (typeof MESSAGE_DIRECTIVE_NAMES)[number]

/** Which Start request the message assembles into (`/workflow` → workflow, `@<agentId>` → review). */
export const MESSAGE_DIRECTIVE_BRANCHES = ['run', 'review', 'workflow'] as const
export type MessageDirectiveBranch = (typeof MESSAGE_DIRECTIVE_BRANCHES)[number]

/**
 * Structured parse result. Every field is an override of the resolved run
 * defaults (Milestone 26 §7); absent fields keep the default.
 */
export interface MessageDirectives {
  readonly branch: MessageDirectiveBranch
  /** `/agent <id>` — run branch: agentType; workflow branch: implementer. */
  readonly agentType?: string | undefined
  /**
   * `/account <alias|id>` — unresolved: Main decides whether the value is a
   * machine-local AccountProfile id or an alias to resolve through
   * ProfileAliasManager (ADR-0011).
   */
  readonly account?: string | undefined
  /** `/mode attended|isolated` — attended = 无 worktree; isolated = orchestrated + worktree. */
  readonly executionMode?: ExecutionMode | undefined
  /** `/approval read-only|manual|safe-auto|full-auto`. */
  readonly approvalMode?: ApprovalMode | undefined
  /** `/model <name>`. */
  readonly model?: string | undefined
  /** `@<agentId> <text>` (review branch): the reviewer agent id. */
  readonly reviewerAgentId?: string | undefined
  /** `/workflow full --test "<cmd>"` (workflow branch): overrides the Build/Test step command. */
  readonly testCommand?: string | undefined
  /**
   * The message body after the leading directive block (trimmed). Guaranteed
   * non-empty for the run and review branches; the workflow branch allows an
   * empty body only when the caller already has a taskId (Main enforces).
   */
  readonly prompt: string
}

export const MESSAGE_DIRECTIVE_ERROR_REASONS = [
  /** A directive line exceeded the IPC_NAME_MAX directive-area budget (Milestone 26 §9). */
  'directive-line-too-long',
  /** `/foo` — `foo` is not a known directive. */
  'unknown-directive',
  /** Known directive with an illegal argument (bad enum value, extra/missing args, unterminated quote). */
  'invalid-value',
  /** The same directive appeared twice in the leading block. */
  'duplicate-directive',
  /** `@<agentId>` mixed with `/` directives (the mention must be the whole directive block). */
  'mixed-mention',
  /** `/mode` / `/approval` / `/account` combined with `/workflow full` — the workflow has no field for them. */
  'incompatible-directive',
  /** Directives but no message body (run / review branch). */
  'missing-body',
] as const
export type MessageDirectiveErrorReason = (typeof MESSAGE_DIRECTIVE_ERROR_REASONS)[number]

/** A structured parse failure; `line` is 1-based so Main can report 带行号的错误. */
export interface MessageDirectiveError {
  readonly line: number
  readonly reason: MessageDirectiveErrorReason
  /** The directive name (without `/`) when one was involved. */
  readonly directive?: string | undefined
  /** The offending value when one was involved. */
  readonly value?: string | undefined
  /** English fallback message (the Renderer localizes via the error's messageKey). */
  readonly message: string
}

export type ParseMessageDirectivesResult =
  | { readonly ok: true; readonly directives: MessageDirectives }
  | { readonly ok: false; readonly error: MessageDirectiveError }
