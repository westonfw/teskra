import {
  AGENT_OBSERVATION_PAYLOAD_MAX,
  AGENT_OBSERVATION_TEXT_MAX,
  type AgentObservation,
} from '@teskra/contracts'

import {
  asRecord,
  parseJsonLine,
  readNonNegativeNumber,
  readString,
  truncate,
  type ObservationNormalizer,
} from './normalize-shared'

/**
 * TASK-123 (§6.2) — normalizes Codex CLI's `codex exec --json` NDJSON stream
 * (Codex CLI 0.x, e.g. 0.154.0) into AgentObservations.
 *
 * Recognized events:
 * - `thread.started`                    → session (`thread_id`)
 * - `item.completed` command_execution  → tool_call (with `command`) +
 *                                         tool_result (exit code / output)
 * - `item.completed` agent_message      → assistant_text
 * - `item.completed` error              → error
 * - `turn.completed`                    → usage + result (ok)
 * - `turn.failed` / `error`             → error (+ result failed for the turn)
 * `turn.started`, `item.started`, `item.updated` and item kinds with no
 * observation value (reasoning, file_change, web_search, ...) are known stream
 * members and return an empty list; unknown or malformed lines return
 * undefined (counted as ignored).
 */
export const normalizeCodexExecJsonLine: ObservationNormalizer = (line) => {
  const parsed = asRecord(parseJsonLine(line))
  if (parsed === undefined) return undefined
  const type = readString(parsed['type'])
  if (type === undefined) return undefined

  if (type === 'thread.started') {
    const threadId = readString(parsed['thread_id'])
    if (threadId === undefined) return undefined
    return { observations: [{ kind: 'session', sessionId: threadId }] }
  }

  if (type === 'item.completed') {
    const item = asRecord(parsed['item'])
    if (item === undefined) return undefined
    // codex-rs moved the discriminant from `type` to `item_type`; accept both.
    const itemType = readString(item['item_type']) ?? readString(item['type'])
    if (itemType === 'command_execution') {
      const command = readString(item['command'])
      if (command === undefined) return { observations: [] }
      const exitCode = readNonNegativeNumber(item['exit_code'])
      const output = item['aggregated_output']
      return {
        observations: [
          {
            kind: 'tool_call',
            toolName: 'command_execution',
            input: truncate(JSON.stringify({ command }), AGENT_OBSERVATION_PAYLOAD_MAX),
            command: truncate(command, AGENT_OBSERVATION_PAYLOAD_MAX),
          },
          {
            kind: 'tool_result',
            toolName: 'command_execution',
            ok: exitCode === 0,
            output: truncate(
              typeof output === 'string' ? output : JSON.stringify(output ?? ''),
              AGENT_OBSERVATION_PAYLOAD_MAX,
            ),
          },
        ],
      }
    }
    if (itemType === 'agent_message') {
      const text = item['text']
      if (typeof text !== 'string' || text.length === 0) return { observations: [] }
      return {
        observations: [
          { kind: 'assistant_text', text: truncate(text, AGENT_OBSERVATION_TEXT_MAX) },
        ],
      }
    }
    if (itemType === 'error') {
      const message = readString(item['message']) ?? 'unknown error'
      return {
        observations: [
          { kind: 'error', message: truncate(message, AGENT_OBSERVATION_PAYLOAD_MAX) },
        ],
      }
    }
    // reasoning / file_change / mcp_tool_call / web_search / todo_list ...
    return { observations: [] }
  }

  if (type === 'turn.completed') {
    const usage = asRecord(parsed['usage'])
    const observations: AgentObservation[] = []
    if (usage !== undefined) {
      observations.push({
        kind: 'usage',
        inputTokens: readNonNegativeNumber(usage['input_tokens']) ?? 0,
        outputTokens: readNonNegativeNumber(usage['output_tokens']) ?? 0,
        cacheReadTokens: readNonNegativeNumber(usage['cached_input_tokens']) ?? 0,
        cacheWriteTokens: 0,
      })
    }
    observations.push({ kind: 'result', ok: true })
    return { observations }
  }

  if (type === 'turn.failed') {
    const error = asRecord(parsed['error'])
    const message = readString(error?.['message']) ?? 'turn failed'
    return {
      observations: [
        { kind: 'error', message: truncate(message, AGENT_OBSERVATION_PAYLOAD_MAX) },
        { kind: 'result', ok: false },
      ],
    }
  }

  if (type === 'error') {
    const message = readString(parsed['message'])
    if (message === undefined) return undefined
    return {
      observations: [{ kind: 'error', message: truncate(message, AGENT_OBSERVATION_PAYLOAD_MAX) }],
    }
  }

  // turn.started / item.started / item.updated — lifecycle noise, no observation.
  if (type === 'turn.started' || type === 'item.started' || type === 'item.updated') {
    return { observations: [] }
  }
  return undefined
}
