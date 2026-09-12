/**
 * TASK-065 — heuristic extraction of executed commands from PTY output.
 *
 * ADR-0002: this is post-hoc recognition for audit labelling only. Nothing
 * here gates execution — by the time bytes reach the output stream, the
 * command has already run.
 *
 * Conservative by contract ("宁缺勿假"): a line only yields a candidate when
 * it looks like a shell prompt line — an optional prompt prefix made of
 * typical prompt characters (user@host, path segments, brackets), then a
 * prompt marker (`$`, `#`, `❯`, `›`) and a command — or when it matches one of
 * the Agent-specific TUI patterns declared on `AgentDefinition
 * .auditCommandPatterns` (P1-4; Agents like Claude Code and Codex render their
 * own TUIs, e.g. `⏺ Bash(npm test)`, which never look like shell prompts).
 * Prose, program output, and diffs never qualify; missing a real command is
 * acceptable, inventing one is not.
 */

import type { AgentAuditCommandPattern } from '@teskra/contracts'

const ESC = '\u001b'
const BEL = '\u0007'

// CSI sequences, OSC sequences (terminated by BEL or ST), and charset selects.
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]` + // CSI
    `|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)` + // OSC
    `|${ESC}[()#][0-9A-Za-z]` + // charset selects
    `|${ESC}[=>]`, // keypad modes
  'g',
)

/** Removes ANSI escape sequences from raw PTY output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

// Prompt prefixes: bracketed segments may contain spaces (e.g. `[user@host
// dir]#`); outside brackets only typical prompt characters qualify, so prose
// like "the price is $ 5" can never reach the marker.
const PROMPT_PREFIX = '(?:\\[[^\\]\\r\\n]{0,60}\\])*[\\w.@%:~/()-]{0,60}'
const PROMPT_MARKER = '[$#❯›]'
const MAX_COMMAND_LENGTH = 500
const promptLinePattern = new RegExp(
  `^${PROMPT_PREFIX}${PROMPT_MARKER}\\s+(\\S[^\\r\\n]{0,${MAX_COMMAND_LENGTH}})$`,
)
const leadingMarkerPattern = new RegExp(`^${PROMPT_MARKER}`)

// A run can in principle emit megabytes without a newline; the pending partial
// line is force-flushed past this bound so the buffer stays small.
const MAX_PENDING_LINE_LENGTH = 8192

interface CompiledAgentPattern {
  readonly pattern: RegExp
  readonly afterMarker?: RegExp
}

function compileAgentPatterns(
  auditPatterns: readonly AgentAuditCommandPattern[],
): CompiledAgentPattern[] {
  const compiled: CompiledAgentPattern[] = []
  for (const rule of auditPatterns) {
    try {
      compiled.push({
        pattern: new RegExp(rule.pattern),
        ...(rule.afterMarker === undefined ? {} : { afterMarker: new RegExp(rule.afterMarker) }),
      })
    } catch {
      // AgentDefinition validation (agentDefinitionSchema) rejects invalid
      // regexes at registration; an invalid rule that still reaches us is
      // skipped — recognition stays conservative rather than crashing audit.
    }
  }
  return compiled
}

/**
 * Recognizes the commands on one completed output line. `markerMatched` is
 * whether the PREVIOUS line matched any pattern's `afterMarker` (P1-4: e.g.
 * Codex `codex exec` prints a bare `exec` line, then `<command> in <cwd>`).
 * Returns the commands found plus whether this line itself is a marker.
 */
function extractFromLine(
  rawLine: string,
  agentPatterns: readonly CompiledAgentPattern[],
  markerMatched: boolean,
): { commands: string[]; isMarker: boolean } {
  const line = stripAnsi(rawLine).trimEnd()
  const commands: string[] = []
  let isMarker = false
  for (const rule of agentPatterns) {
    if (rule.afterMarker !== undefined && rule.afterMarker.test(line)) {
      isMarker = true
    }
    if (rule.afterMarker !== undefined && !markerMatched) continue
    const command = rule.pattern.exec(line)?.[1]?.trim()
    if (command !== undefined && command.length > 0 && command.length <= MAX_COMMAND_LENGTH) {
      commands.push(command)
    }
  }
  const promptMatch = promptLinePattern.exec(line)
  const promptCommand = promptMatch?.[1]?.trim()
  if (
    promptCommand !== undefined &&
    promptCommand.length > 0 &&
    promptCommand.length <= MAX_COMMAND_LENGTH &&
    // A "command" that starts with another prompt marker is a bare prompt
    // redraw, not an invocation.
    !leadingMarkerPattern.test(promptCommand)
  ) {
    commands.push(promptCommand)
  }
  return { commands, isMarker }
}

/**
 * P1-4 — a stateful, line-buffered command extractor for one output stream.
 *
 * The Agent output batcher cuts chunks at a fixed time boundary, so a command
 * line is routinely split across two chunks; full-line patterns (`^…$`) fed
 * chunk-by-chunk lose those commands. `push` buffers the trailing partial
 * line and only recognizes completed lines; `flush` recognizes the leftover
 * partial line at end of stream.
 */
export interface CommandExtractor {
  push(outputChunk: string): string[]
  flush(): string[]
}

export function createCommandExtractor(
  auditPatterns: readonly AgentAuditCommandPattern[] = [],
): CommandExtractor {
  const agentPatterns = compileAgentPatterns(auditPatterns)
  let pending = ''
  let markerMatched = false

  const recognize = (lines: readonly string[]): string[] => {
    const commands: string[] = []
    for (const line of lines) {
      const result = extractFromLine(line, agentPatterns, markerMatched)
      commands.push(...result.commands)
      markerMatched = result.isMarker
    }
    return commands
  }

  return {
    push(outputChunk) {
      pending += outputChunk
      const lines = pending.split(/\r\n|\r|\n/)
      pending = lines.pop() ?? ''
      // Force-recognize an over-long partial line instead of buffering it
      // forever; it will not match a well-formed command pattern anyway.
      const forced = pending.length > MAX_PENDING_LINE_LENGTH ? [pending] : []
      if (forced.length > 0) pending = ''
      return recognize([...lines, ...forced])
    },
    flush() {
      const rest = pending
      pending = ''
      return rest.length === 0 ? [] : recognize([rest])
    },
  }
}

/**
 * One-shot variant of {@link createCommandExtractor}: recognizes the command
 * lines in a self-contained chunk (the trailing partial line counts as
 * complete). The result keeps stream order and may contain duplicates (the
 * caller dedupes per Run).
 */
export function extractExecutedCommands(
  outputChunk: string,
  auditPatterns: readonly AgentAuditCommandPattern[] = [],
): string[] {
  const extractor = createCommandExtractor(auditPatterns)
  return [...extractor.push(outputChunk), ...extractor.flush()]
}
