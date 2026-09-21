/**
 * TASK-123 (Milestone 25 §6.2 / ADR-0013 §5) — the chunk → line splitter
 * feeding the structured-output protocol normalizers.
 *
 * Semantics: `\r` is stripped (CRLF writers, PTY carriage returns), lines are
 * cut on `\n`, and an incomplete tail line is held until the rest of it
 * arrives in a later chunk (or `flush()` at stream end). A single line longer
 * than MAX_LINE_CHARS is dropped and counted — the splitter enters a discard
 * mode until that line's terminating newline, so one giant line can never
 * grow the pending buffer without bound.
 */

export const OBSERVATION_MAX_LINE_CHARS = 64 * 1024

export interface LineSplitter {
  /** Returns the lines completed by this chunk (may be empty). */
  push(chunk: string): string[]
  /** Stream end: returns the held tail line when there is one. */
  flush(): string | undefined
  /** Lines dropped for exceeding the 64 KiB ceiling (push + flush). */
  readonly droppedLines: number
}

export function createLineSplitter(): LineSplitter {
  let pending = ''
  let discarding = false
  let dropped = 0

  return {
    push(chunk) {
      const lines: string[] = []
      // All \r go first so neither the length cap nor the parser ever sees them.
      const clean = chunk.replaceAll('\r', '')
      let start = 0
      while (start <= clean.length) {
        const newline = clean.indexOf('\n', start)
        const end = newline === -1 ? clean.length : newline
        const segment = clean.slice(start, end)
        if (discarding) {
          // Inside a dropped over-long line: skip until its newline ends it.
          if (newline !== -1) discarding = false
        } else {
          pending += segment
          if (pending.length > OBSERVATION_MAX_LINE_CHARS) {
            dropped += 1
            pending = ''
            // The line continues past this segment unless the newline ended it.
            discarding = newline === -1
          } else if (newline !== -1) {
            lines.push(pending)
            pending = ''
          }
        }
        if (newline === -1) break
        start = newline + 1
      }
      return lines
    },
    flush() {
      const tail = pending
      pending = ''
      discarding = false
      if (tail.length === 0) return undefined
      if (tail.length > OBSERVATION_MAX_LINE_CHARS) {
        dropped += 1
        return undefined
      }
      return tail
    },
    get droppedLines() {
      return dropped
    },
  }
}
