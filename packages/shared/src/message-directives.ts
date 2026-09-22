import {
  APPROVAL_MODES,
  IPC_NAME_MAX,
  MESSAGE_DIRECTIVE_NAMES,
  type ApprovalMode,
  type ExecutionMode,
  type MessageDirectiveError,
  type MessageDirectiveErrorReason,
  type ParseMessageDirectivesResult,
} from '@teskra/contracts'

/**
 * TASK-136 (Milestone 26 §7) — `parseMessageDirectives(text)`: the pure
 * parser behind the thread-first message directives.
 *
 * Grammar:
 *
 * ```text
 * /agent <id>                     → agentType
 * /account <alias|id>             → account (Main resolves alias → Profile id, ADR-0011)
 * /mode attended|isolated         → executionMode
 * /approval read-only|manual|safe-auto|full-auto
 * /model <name>
 * /workflow full [--test "<cmd>"] → workflow branch (FullWorkflowStartRequest)
 * @<agentId> <text>               → review branch (StartReviewRunRequest)
 * ```
 *
 * Rules (§7):
 *
 * - Directives only live in the message's LEADING CONSECUTIVE lines; the rest
 *   is the prompt. A `/...` line after the first non-directive line is body
 *   text, never a directive and never an error.
 * - An `@<agentId>` mention is only recognized on the very first line and is
 *   the whole directive block — combining it with `/` directives is a
 *   `mixed-mention` error.
 * - Unknown directives, illegal values, duplicates and missing bodies are
 *   structured errors with a 1-based `line` — Main turns them into a
 *   VALIDATION_FAILED and starts nothing.
 * - `/mode` / `/approval` / `/account` have no counterpart on
 *   FullWorkflowStartRequest, so combining them with `/workflow full` is an
 *   `incompatible-directive` error (`/agent` → implementer and `/model` are
 *   allowed).
 * - The directive area is budgeted: each slash-directive line and the mention
 *   token are capped at IPC_NAME_MAX (Milestone 26 §9).
 */

const DIRECTIVE_NAME_SET: ReadonlySet<string> = new Set(MESSAGE_DIRECTIVE_NAMES)
const APPROVAL_MODE_SET: ReadonlySet<string> = new Set(APPROVAL_MODES)

/** `/mode` surface values → ExecutionMode ('isolated' = orchestrated + worktree). */
const MODE_VALUES: Readonly<Record<string, ExecutionMode>> = {
  attended: 'attended',
  isolated: 'orchestrated',
}

/** Directives that have no field on FullWorkflowStartRequest. */
const WORKFLOW_INCOMPATIBLE = ['mode', 'approval', 'account'] as const

function fail(
  line: number,
  reason: MessageDirectiveErrorReason,
  message: string,
  extra?: { directive?: string; value?: string },
): ParseMessageDirectivesResult {
  const error: MessageDirectiveError = { line, reason, message, ...extra }
  return { ok: false, error }
}

/**
 * Quote-aware tokenizer for one directive line: double quotes group a token
 * that contains spaces (`--test "npm run test:unit"`). Returns undefined on
 * an unterminated quote.
 */
function tokenizeDirectiveLine(line: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let tokenStarted = false
  const flush = (): void => {
    if (tokenStarted || current.length > 0) tokens.push(current)
    current = ''
    tokenStarted = false
  }
  for (const ch of line) {
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
      tokenStarted = true
    } else if (ch === ' ' || ch === '\t') {
      flush()
    } else {
      current += ch
    }
  }
  if (inQuotes) return undefined
  flush()
  return tokens
}

/** `@<agentId> <text>` — the mention is line 1; every later line is body text. */
function parseMention(lines: readonly string[]): ParseMessageDirectivesResult {
  const line = (lines[0] ?? '').trim()
  const rest = line.slice(1)
  const spaceIndex = rest.search(/\s/)
  const agentId = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
  if (agentId === '') {
    return fail(1, 'invalid-value', 'Line 1: the `@` mention needs an agent id, e.g. `@codex …`.')
  }
  if (agentId.length > IPC_NAME_MAX) {
    return fail(
      1,
      'directive-line-too-long',
      `Line 1: the mention exceeds the ${String(IPC_NAME_MAX)}-character directive budget.`,
    )
  }
  const firstLineText = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1)
  const prompt = [firstLineText, ...lines.slice(1)].join('\n').trim()
  if (prompt === '') {
    return fail(1, 'missing-body', 'Line 1: an `@` mention needs review instructions after it.')
  }
  return { ok: true, directives: { branch: 'review', reviewerAgentId: agentId, prompt } }
}

interface SlashState {
  agentType?: string
  account?: string
  executionMode?: ExecutionMode
  approvalMode?: ApprovalMode
  model?: string
  testCommand?: string
  workflow: boolean
  /** Directive name → 1-based line it appeared on (duplicate / incompatibility reports). */
  readonly seen: Map<string, number>
}

function parseSlashDirective(
  state: SlashState,
  tokens: readonly string[],
  line: number,
): ParseMessageDirectivesResult | undefined {
  const name = tokens[0]?.slice(1) ?? ''
  if (!DIRECTIVE_NAME_SET.has(name)) {
    return fail(line, 'unknown-directive', `Line ${String(line)}: unknown directive "/${name}".`, {
      directive: name,
    })
  }
  if (state.seen.has(name)) {
    return fail(
      line,
      'duplicate-directive',
      `Line ${String(line)}: duplicate directive "/${name}".`,
      { directive: name },
    )
  }
  state.seen.set(name, line)
  const args = tokens.slice(1)
  const invalid = (detail: string, value?: string): ParseMessageDirectivesResult =>
    fail(line, 'invalid-value', `Line ${String(line)}: ${detail}`, {
      directive: name,
      ...(value === undefined ? {} : { value }),
    })

  switch (name) {
    case 'agent':
    case 'account':
    case 'model': {
      if (args.length !== 1 || args[0] === '') {
        return invalid(`"/${name}" takes exactly one value.`)
      }
      const value = args[0] as string
      if (name === 'agent') state.agentType = value
      else if (name === 'account') state.account = value
      else state.model = value
      return undefined
    }
    case 'mode': {
      const value = args.length === 1 ? args[0] : undefined
      const mode = value === undefined ? undefined : MODE_VALUES[value]
      if (mode === undefined) {
        return invalid(
          `"/mode" takes "attended" or "isolated".`,
          args.length === 1 ? args[0] : undefined,
        )
      }
      state.executionMode = mode
      return undefined
    }
    case 'approval': {
      const value = args.length === 1 ? args[0] : undefined
      if (value === undefined || !APPROVAL_MODE_SET.has(value)) {
        return invalid(
          `"/approval" takes one of: ${APPROVAL_MODES.join(', ')}.`,
          args.length === 1 ? args[0] : undefined,
        )
      }
      state.approvalMode = value as ApprovalMode
      return undefined
    }
    case 'workflow': {
      if (args[0] !== 'full') {
        return invalid(`"/workflow" currently only supports "full".`, args[0])
      }
      let index = 1
      while (index < args.length) {
        const flag = args[index]
        const command = args[index + 1]
        if (flag !== '--test' || command === undefined || command === '') {
          return invalid(`"/workflow full" only takes --test "<cmd>".`, flag)
        }
        state.testCommand = command
        index += 2
      }
      state.workflow = true
      return undefined
    }
    default:
      return invalid(`"/${name}" is not supported here.`)
  }
}

export function parseMessageDirectives(text: string): ParseMessageDirectivesResult {
  const lines = text.split('\n')
  if ((lines[0] ?? '').trim().startsWith('@')) {
    return parseMention(lines)
  }

  const state: SlashState = { workflow: false, seen: new Map() }
  let index = 0
  for (; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim()
    if (!trimmed.startsWith('/')) break
    const line = index + 1
    if (trimmed.length > IPC_NAME_MAX) {
      return fail(
        line,
        'directive-line-too-long',
        `Line ${String(line)}: directive lines are capped at ${String(IPC_NAME_MAX)} characters.`,
      )
    }
    const tokens = tokenizeDirectiveLine(trimmed)
    if (tokens === undefined || tokens.length === 0) {
      return fail(line, 'invalid-value', `Line ${String(line)}: unterminated quote.`)
    }
    const error = parseSlashDirective(state, tokens, line)
    if (error !== undefined) return error
  }

  // The directive block ended; the remainder is the prompt. An `@` mention on
  // the first body line is a mix attempt, not prose.
  const firstBodyIndex = lines.findIndex(
    (line, lineIndex) => lineIndex >= index && line.trim() !== '',
  )
  if (firstBodyIndex !== -1 && (lines[firstBodyIndex] ?? '').trim().startsWith('@')) {
    return fail(
      firstBodyIndex + 1,
      'mixed-mention',
      `Line ${String(firstBodyIndex + 1)}: an @mention cannot be combined with / directives — put "@<agent>" on the first line of the message instead.`,
    )
  }
  const prompt = lines.slice(index).join('\n').trim()

  if (state.workflow) {
    // /mode, /approval and /account have no field on FullWorkflowStartRequest.
    for (const name of WORKFLOW_INCOMPATIBLE) {
      const line = state.seen.get(name)
      if (line !== undefined) {
        return fail(
          line,
          'incompatible-directive',
          `Line ${String(line)}: "/${name}" cannot be combined with /workflow full.`,
          { directive: name },
        )
      }
    }
    return {
      ok: true,
      directives: {
        branch: 'workflow',
        prompt,
        ...(state.agentType === undefined ? {} : { agentType: state.agentType }),
        ...(state.model === undefined ? {} : { model: state.model }),
        ...(state.testCommand === undefined ? {} : { testCommand: state.testCommand }),
      },
    }
  }

  if (prompt === '') {
    const line = Math.max(index, 1)
    return fail(
      line,
      'missing-body',
      `Line ${String(line)}: the message has directives but no body text.`,
    )
  }
  return {
    ok: true,
    directives: {
      branch: 'run',
      prompt,
      ...(state.agentType === undefined ? {} : { agentType: state.agentType }),
      ...(state.account === undefined ? {} : { account: state.account }),
      ...(state.executionMode === undefined ? {} : { executionMode: state.executionMode }),
      ...(state.approvalMode === undefined ? {} : { approvalMode: state.approvalMode }),
      ...(state.model === undefined ? {} : { model: state.model }),
    },
  }
}
