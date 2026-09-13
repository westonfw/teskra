import { CLAUDE_AGENT } from '../definitions/claude'
import { createTextFailureClassifier, type AgentFailureClassifier } from './failure-classifier'

/**
 * ClaudeFailureClassifier (TASK-105, §17.3) — Claude Code phrasing on top of
 * the shared §17 base patterns. "Credit balance is too low" is a billing
 * quota condition, so it maps to rate-limited (the closest §17 kind);
 * "OAuth token has expired" is covered by the shared auth-expired pattern.
 */
export function createClaudeFailureClassifier(): AgentFailureClassifier {
  return createTextFailureClassifier(CLAUDE_AGENT.id, [
    {
      kind: 'rate-limited',
      retryable: true,
      pattern: /credit balance is too low|usage limit reached/i,
    },
  ])
}
