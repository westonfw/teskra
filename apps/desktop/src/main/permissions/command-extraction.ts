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
 * prompt marker (`$`, `#`, `❯`, `›`) and a command. Prose, program output,
 * and diffs never qualify; missing a real command is acceptable, inventing
 * one is not.
 */

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

/**
 * Returns the command lines recognized in one output chunk. Lines that fail
 * the prompt heuristic are ignored entirely; the result keeps stream order
 * and may contain duplicates (the caller dedupes per Run).
 */
export function extractExecutedCommands(outputChunk: string): string[] {
  const commands: string[] = []
  for (const line of stripAnsi(outputChunk).split(/\r\n|\r|\n/)) {
    const match = promptLinePattern.exec(line.trimEnd())
    const command = match?.[1]?.trim()
    if (command === undefined || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
      continue
    }
    // A "command" that starts with another prompt marker is a bare prompt
    // redraw, not an invocation.
    if (leadingMarkerPattern.test(command)) continue
    commands.push(command)
  }
  return commands
}
