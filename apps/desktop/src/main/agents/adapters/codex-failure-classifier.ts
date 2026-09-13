import { CODEX_AGENT } from '../definitions/codex'
import { createTextFailureClassifier, type AgentFailureClassifier } from './failure-classifier'

/**
 * CodexFailureClassifier (TASK-105, §17.3) — Codex CLI phrasing on top of
 * the shared §17 base patterns. Codex reports quota exhaustion as
 * "usage limit" / "rate limit" with a "resets at <iso>" hint (parsed by the
 * shared resetAt logic) and streams `stream error: ... disconnected` events
 * for transport failures.
 */
export function createCodexFailureClassifier(): AgentFailureClassifier {
  return createTextFailureClassifier(CODEX_AGENT.id, [
    {
      kind: 'network',
      retryable: true,
      pattern: /stream (?:error|disconnected)|error sending request/i,
    },
  ])
}
