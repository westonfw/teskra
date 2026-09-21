import {
  AGENT_OBSERVATION_PAYLOAD_MAX,
  AGENT_OBSERVATION_TEXT_MAX,
  type AgentObservation,
} from '@teskra/contracts'

import {
  asRecord,
  parseJsonLine,
  readBoolean,
  readNonNegativeNumber,
  readString,
  serializePayload,
  truncate,
  type ObservationNormalizer,
} from './normalize-shared'

/**
 * TASK-123 (§6.2) — normalizes Claude Code's `--print --output-format
 * stream-json --verbose` NDJSON stream (Claude Code 2.x) into
 * AgentObservations.
 *
 * Recognized events:
 * - `system` / `init`              → session (`session_id`)
 * - `assistant` message blocks     → assistant_text (text) / tool_call (tool_use;
 *                                    `Bash` additionally yields `command`)
 * - `user` tool_result blocks      → tool_result
 * - `result`                       → usage (provider-reported tokens + cost)
 *                                    + result; an `is_error` result also yields
 *                                    an error observation
 * Unknown / malformed lines return undefined (counted as ignored). Known
 * Claude housekeeping events that carry no observation return an empty list.
 */
export const normalizeClaudeStreamJsonLine: ObservationNormalizer = (line) => {
  const parsed = asRecord(parseJsonLine(line))
  if (parsed === undefined) return undefined
  const type = readString(parsed['type'])
  if (type === undefined) return undefined

  if (type === 'system') {
    if (readString(parsed['subtype']) !== 'init') return { observations: [] }
    const sessionId = readString(parsed['session_id'])
    if (sessionId === undefined) return undefined
    return { observations: [{ kind: 'session', sessionId }] }
  }

  if (type === 'assistant') {
    const message = asRecord(parsed['message'])
    const content = message?.['content']
    if (!Array.isArray(content)) return undefined
    const observations: AgentObservation[] = []
    for (const block of content) {
      const record = asRecord(block)
      if (record === undefined) continue
      const blockType = readString(record['type'])
      if (blockType === 'text') {
        const text = record['text']
        if (typeof text !== 'string' || text.length === 0) continue
        observations.push({
          kind: 'assistant_text',
          text: truncate(text, AGENT_OBSERVATION_TEXT_MAX),
        })
      } else if (blockType === 'tool_use') {
        const toolName = readString(record['name'])
        if (toolName === undefined) continue
        const input = record['input']
        const command = toolName === 'Bash' ? readString(asRecord(input)?.['command']) : undefined
        observations.push({
          kind: 'tool_call',
          toolName,
          input: serializePayload(input, AGENT_OBSERVATION_PAYLOAD_MAX),
          ...(command === undefined
            ? {}
            : { command: truncate(command, AGENT_OBSERVATION_PAYLOAD_MAX) }),
        })
      }
      // thinking / redacted_thinking / server_tool_use ... blocks: known shape,
      // no observation.
    }
    return { observations }
  }

  if (type === 'user') {
    const message = asRecord(parsed['message'])
    const content = message?.['content']
    if (!Array.isArray(content)) return { observations: [] }
    const observations: AgentObservation[] = []
    for (const block of content) {
      const record = asRecord(block)
      if (record === undefined || readString(record['type']) !== 'tool_result') continue
      observations.push({
        kind: 'tool_result',
        ok: record['is_error'] !== true,
        output: serializePayload(record['content'], AGENT_OBSERVATION_PAYLOAD_MAX),
      })
    }
    return { observations }
  }

  if (type === 'result') {
    const observations: AgentObservation[] = []
    const usage = asRecord(parsed['usage'])
    if (usage !== undefined) {
      const costUsd = readNonNegativeNumber(parsed['total_cost_usd'])
      const model = readString(asRecord(parsed['message'])?.['model'])
      observations.push({
        kind: 'usage',
        inputTokens: readNonNegativeNumber(usage['input_tokens']) ?? 0,
        outputTokens: readNonNegativeNumber(usage['output_tokens']) ?? 0,
        cacheReadTokens: readNonNegativeNumber(usage['cache_read_input_tokens']) ?? 0,
        cacheWriteTokens: readNonNegativeNumber(usage['cache_creation_input_tokens']) ?? 0,
        // ADR-0013 §6: provider-reported cost only; absent stays absent.
        ...(costUsd === undefined ? {} : { costUsdMicros: Math.round(costUsd * 1_000_000) }),
        ...(model === undefined ? {} : { model }),
      })
    }
    const isError = readBoolean(parsed['is_error']) ?? false
    const subtype = readString(parsed['subtype'])
    if (isError) {
      const message = readString(parsed['result']) ?? subtype ?? 'unknown error'
      observations.push({
        kind: 'error',
        message: truncate(message, AGENT_OBSERVATION_PAYLOAD_MAX),
        ...(subtype === undefined ? {} : { code: subtype }),
      })
    }
    const durationMs = readNonNegativeNumber(parsed['duration_ms'])
    const turns = readNonNegativeNumber(parsed['num_turns'])
    observations.push({
      kind: 'result',
      ok: !isError,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(turns === undefined ? {} : { turns }),
    })
    return { observations }
  }

  // rate_limit_event, stream_event (--include-partial-messages), ... — known
  // stream members with no observation value.
  if (type === 'rate_limit_event' || type === 'stream_event') return { observations: [] }
  return undefined
}
