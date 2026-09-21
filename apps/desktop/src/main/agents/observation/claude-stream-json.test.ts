import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AGENT_OBSERVATION_PAYLOAD_MAX,
  AGENT_OBSERVATION_TEXT_MAX,
  type AgentObservation,
} from '@teskra/contracts'

import { normalizeClaudeStreamJsonLine } from './claude-stream-json'
import { createLineSplitter } from './line-splitter'
import type { ObservationNormalizer } from './normalize-shared'

const FIXTURES = join(__dirname, 'fixtures')

/**
 * Feeds a fixture through the real splitter at randomized chunk boundaries —
 * the NDJSON stream arrives as arbitrarily cut PTY chunks, so a fixture must
 * parse identically no matter where the bytes are split.
 */
function replayFixture(
  name: string,
  normalizer: ObservationNormalizer,
): { observations: AgentObservation[]; ignored: number } {
  const content = readFileSync(join(FIXTURES, name), 'utf8')
  let reference: { observations: AgentObservation[]; ignored: number } | undefined
  for (const cut of [1, 7, 64, content.length]) {
    const splitter = createLineSplitter()
    const outcome: { observations: AgentObservation[]; ignored: number } = {
      observations: [],
      ignored: 0,
    }
    const handle = (line: string): void => {
      const result = normalizer(line)
      if (result === undefined) {
        outcome.ignored += 1
      } else {
        outcome.observations.push(...result.observations)
      }
    }
    for (let index = 0; index < content.length; index += cut) {
      for (const line of splitter.push(content.slice(index, index + cut))) {
        handle(line)
      }
    }
    const tail = splitter.flush()
    if (tail !== undefined) handle(tail)
    // The per-character replay is the reference the coarser cuts compare to.
    if (reference === undefined) {
      reference = outcome
    } else {
      expect(outcome).toEqual(reference)
    }
  }
  if (reference === undefined) throw new Error('unreachable: no replay ran')
  return reference
}

describe('normalizeClaudeStreamJsonLine (TASK-123 §6.2)', () => {
  it('parses the success fixture (Claude Code 2.0.30) into the full observation sequence', () => {
    const { observations, ignored } = replayFixture(
      'claude-code-2.0.30-success.jsonl',
      normalizeClaudeStreamJsonLine,
    )
    // The 5 header comment lines are the only ignored lines.
    expect(ignored).toBe(5)
    expect(observations).toEqual([
      { kind: 'session', sessionId: 'b8f2c1a4-1111-4a2b-9c3d-000000000001' },
      { kind: 'assistant_text', text: "I'll inspect the repository layout first." },
      {
        kind: 'tool_call',
        toolName: 'Bash',
        input: JSON.stringify({ command: 'ls -la', description: 'List repository contents' }),
        command: 'ls -la',
      },
      {
        kind: 'tool_result',
        ok: true,
        output: 'total 24\ndrwxr-xr-x 3 dev dev 4096 Sep 21 10:00 .',
      },
      {
        kind: 'assistant_text',
        text: 'Done. The repository root contains the expected files.',
      },
      {
        kind: 'usage',
        inputTokens: 7,
        outputTokens: 64,
        cacheReadTokens: 18500,
        cacheWriteTokens: 120,
        costUsdMicros: 12345,
      },
      { kind: 'result', ok: true, durationMs: 4210, turns: 2 },
    ])
  })

  it('parses the error fixture: is_error result yields usage + error + failed result', () => {
    const { observations } = replayFixture(
      'claude-code-2.0.30-error.jsonl',
      normalizeClaudeStreamJsonLine,
    )
    expect(observations.map((observation) => observation.kind)).toEqual([
      'session',
      'assistant_text',
      'usage',
      'error',
      'result',
    ])
    const error = observations.find((observation) => observation.kind === 'error')
    expect(error).toEqual({
      kind: 'error',
      message: 'Reached the maximum number of turns without completing the task.',
      code: 'error_max_turns',
    })
    const usage = observations.find((observation) => observation.kind === 'usage')
    expect(usage).toEqual({
      kind: 'usage',
      inputTokens: 900,
      outputTokens: 2100,
      cacheReadTokens: 4000,
      cacheWriteTokens: 0,
    })
    expect(observations.at(-1)).toEqual({ kind: 'result', ok: false, durationMs: 61000, turns: 10 })
  })

  it('tolerates the noise fixture: CRLF, unknown types, non-JSON lines', () => {
    const { observations, ignored } = replayFixture(
      'claude-code-2.0.30-noise.jsonl',
      normalizeClaudeStreamJsonLine,
    )
    // Ignored: 3 header lines + the garbage line + the unknown future event.
    expect(ignored).toBe(5)
    const kinds = observations.map((observation) => observation.kind)
    expect(kinds).toEqual([
      'session',
      // rate_limit_event: known, no observation.
      'tool_call',
      'tool_result',
      'usage',
      'result',
    ])
    const toolCall = observations.find((observation) => observation.kind === 'tool_call')
    expect(toolCall).toEqual({
      kind: 'tool_call',
      toolName: 'Read',
      input: JSON.stringify({ file_path: '/repo/README.md' }),
    })
  })

  it('returns undefined for unknown types and non-JSON lines', () => {
    expect(normalizeClaudeStreamJsonLine('not json')).toBeUndefined()
    expect(normalizeClaudeStreamJsonLine('{"type":"mystery"}')).toBeUndefined()
    expect(normalizeClaudeStreamJsonLine('{"no_type":true}')).toBeUndefined()
    expect(normalizeClaudeStreamJsonLine('[1,2,3]')).toBeUndefined()
  })

  it('truncates assistant text to 8 KiB and tool payloads to 4 KiB', () => {
    const longText = 'a'.repeat(AGENT_OBSERVATION_TEXT_MAX + 500)
    const assistant = normalizeClaudeStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
      }),
    )
    expect(assistant?.observations[0]).toEqual({
      kind: 'assistant_text',
      text: 'a'.repeat(AGENT_OBSERVATION_TEXT_MAX),
    })
    const longCommand = 'c'.repeat(AGENT_OBSERVATION_PAYLOAD_MAX + 500)
    const toolCall = normalizeClaudeStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: longCommand } }],
        },
      }),
    )
    const observation = toolCall?.observations[0]
    expect(observation?.kind).toBe('tool_call')
    if (observation?.kind === 'tool_call') {
      expect(observation.command?.length).toBe(AGENT_OBSERVATION_PAYLOAD_MAX)
      expect(observation.input.length).toBeLessThanOrEqual(AGENT_OBSERVATION_PAYLOAD_MAX)
    }
  })

  it('does not extract a command from non-Bash tools', () => {
    const result = normalizeClaudeStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { command: 'not-a-command' } }],
        },
      }),
    )
    expect(result?.observations[0]).toEqual({
      kind: 'tool_call',
      toolName: 'Read',
      input: JSON.stringify({ command: 'not-a-command' }),
    })
  })

  it('marks a tool_result with is_error as not ok', () => {
    const result = normalizeClaudeStreamJsonLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'boom', is_error: true }],
        },
      }),
    )
    expect(result?.observations[0]).toEqual({ kind: 'tool_result', ok: false, output: 'boom' })
  })
})
