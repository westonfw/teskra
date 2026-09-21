import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AGENT_OBSERVATION_PAYLOAD_MAX,
  AGENT_OBSERVATION_TEXT_MAX,
  type AgentObservation,
} from '@teskra/contracts'

import { normalizeCodexExecJsonLine } from './codex-exec-json'
import { createLineSplitter } from './line-splitter'
import type { ObservationNormalizer } from './normalize-shared'

const FIXTURES = join(__dirname, 'fixtures')

/** Same randomized-chunk replay as the Claude fixture tests. */
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
    if (reference === undefined) {
      reference = outcome
    } else {
      expect(outcome).toEqual(reference)
    }
  }
  if (reference === undefined) throw new Error('unreachable: no replay ran')
  return reference
}

describe('normalizeCodexExecJsonLine (TASK-123 §6.2)', () => {
  it('parses the success fixture (Codex CLI 0.154.0) into the full observation sequence', () => {
    const { observations, ignored } = replayFixture(
      'codex-cli-0.154.0-success.jsonl',
      normalizeCodexExecJsonLine,
    )
    // The 4 header comment lines are the only ignored lines.
    expect(ignored).toBe(4)
    expect(observations).toEqual([
      { kind: 'session', sessionId: '019a12cd-4444-4e5f-a6b7-000000000004' },
      {
        kind: 'tool_call',
        toolName: 'command_execution',
        input: JSON.stringify({ command: "bash -lc 'ls'" }),
        command: "bash -lc 'ls'",
      },
      {
        kind: 'tool_result',
        toolName: 'command_execution',
        ok: true,
        output: 'README.md\nsrc\n',
      },
      { kind: 'assistant_text', text: 'The repository contains README.md and src/.' },
      {
        kind: 'usage',
        inputTokens: 4200,
        outputTokens: 37,
        cacheReadTokens: 2048,
        cacheWriteTokens: 0,
      },
      { kind: 'result', ok: true },
    ])
  })

  it('parses the turn-failed fixture: failed exit code, error + failed result, stream error', () => {
    const { observations, ignored } = replayFixture(
      'codex-cli-0.154.0-turn-failed.jsonl',
      normalizeCodexExecJsonLine,
    )
    expect(ignored).toBe(3)
    expect(observations.map((observation) => observation.kind)).toEqual([
      'session',
      'tool_call',
      'tool_result',
      'error',
      'result',
      'error',
    ])
    expect(observations[2]).toMatchObject({ kind: 'tool_result', ok: false })
    expect(observations[3]).toEqual({
      kind: 'error',
      message: 'stream disconnected before completion: rate limit exceeded, please try again later',
    })
    expect(observations[4]).toEqual({ kind: 'result', ok: false })
    expect(observations[5]).toEqual({
      kind: 'error',
      message: 'stream error: idle timeout waiting for SSE',
    })
  })

  it('tolerates the noise fixture: CRLF, reasoning items, garbage, legacy item.type discriminant', () => {
    const { observations, ignored } = replayFixture(
      'codex-cli-0.154.0-noise.jsonl',
      normalizeCodexExecJsonLine,
    )
    // Ignored: 3 header lines + garbage line + the unknown future event.
    expect(ignored).toBe(5)
    expect(observations.map((observation) => observation.kind)).toEqual([
      'session',
      // reasoning item: known, no observation.
      'tool_call',
      'tool_result',
      'usage',
      'result',
    ])
    expect(observations[1]).toMatchObject({
      kind: 'tool_call',
      toolName: 'command_execution',
      command: "bash -lc 'pwd'",
    })
    expect(observations[2]).toMatchObject({ kind: 'tool_result', ok: true, output: '/repo\n' })
  })

  it('returns undefined for unknown types and non-JSON lines', () => {
    expect(normalizeCodexExecJsonLine('not json')).toBeUndefined()
    expect(normalizeCodexExecJsonLine('{"type":"mystery"}')).toBeUndefined()
    expect(normalizeCodexExecJsonLine('{"no_type":true}')).toBeUndefined()
    expect(normalizeCodexExecJsonLine('42')).toBeUndefined()
  })

  it('truncates assistant text to 8 KiB and tool output to 4 KiB', () => {
    const longText = 'a'.repeat(AGENT_OBSERVATION_TEXT_MAX + 500)
    const message = normalizeCodexExecJsonLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', item_type: 'agent_message', text: longText },
      }),
    )
    expect(message?.observations[0]).toEqual({
      kind: 'assistant_text',
      text: 'a'.repeat(AGENT_OBSERVATION_TEXT_MAX),
    })
    const longOutput = 'o'.repeat(AGENT_OBSERVATION_PAYLOAD_MAX + 500)
    const completed = normalizeCodexExecJsonLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          item_type: 'command_execution',
          command: 'yes',
          aggregated_output: longOutput,
          exit_code: 0,
        },
      }),
    )
    const toolResult = completed?.observations[1]
    expect(toolResult?.kind).toBe('tool_result')
    if (toolResult?.kind === 'tool_result') {
      expect(toolResult.output.length).toBe(AGENT_OBSERVATION_PAYLOAD_MAX)
    }
  })

  it('marks a command_execution with a non-zero exit code as not ok', () => {
    const result = normalizeCodexExecJsonLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          item_type: 'command_execution',
          command: 'false',
          aggregated_output: '',
          exit_code: 1,
        },
      }),
    )
    expect(result?.observations[1]).toMatchObject({ kind: 'tool_result', ok: false })
  })
})
