import {
  AGENT_FAILURE_EVIDENCE_MAX,
  type AgentFailureClassification,
  type AgentFailureKind,
} from '@teskra/contracts'

import { redactSecrets } from '../../redact'

/**
 * AgentFailureClassifier (TASK-105, Milestone 24 §17 / ADR-0010) — post-hoc
 * classification of why an Agent Run failed. The Run status stays `failed`;
 * the classification is the failure *reason*, persisted in
 * `agent_runs.failure_classification_json`.
 *
 * §17.0: classification runs ONLY after the process has exited (or when the
 * launch itself failed) — never against a live stream. A PTY text match
 * ("quota exceeded" inside a reviewed diff, a file the Agent catted, the
 * Agent quoting the user) is a weak signal and must never terminate a Run
 * or mutate a Profile on its own. The live-stream seam, should a UI hint
 * ever be wanted, is the `process.output` subscription in AgentManager
 * feeding `classifyOutput` below; nothing calls it today by design.
 *
 * §17.1: every regex lives HERE (the shared base patterns) or in the
 * per-agent classifier modules next to it — never inlined into AgentManager.
 */

/** The Run-exit context a classifier reasons about. */
export interface AgentFailureContext {
  /** Non-zero for every process-exit failure; absent when the launch failed. */
  readonly exitCode?: number | undefined
  readonly signal?: number | undefined
  /** Bounded tail of the (already secret-redacted) terminal log. */
  readonly outputTail: string
  /**
   * Structured provider events when the CLI emits them (e.g. `codex exec`
   * JSON lines). Scanned before the raw tail — a structured provider error
   * is a stronger signal than surrounding PTY text (§17.0 (b)).
   */
  readonly structuredEvents?: readonly unknown[] | undefined
}

export interface AgentFailureClassifier {
  /** AgentDefinition.id this classifier understands (free-form string). */
  readonly agentId: string
  classify(context: AgentFailureContext): AgentFailureClassification
}

interface FailurePattern {
  readonly kind: Exclude<AgentFailureKind, 'process-crash' | 'unknown'>
  readonly retryable: boolean
  readonly pattern: RegExp
}

/**
 * §17 recognition list, shared by every CLI. Order is significant: the first
 * matching kind wins, so the more specific auth-expired patterns precede the
 * generic auth-required ones ("session expired, please log in again" is an
 * expiry, not a missing login).
 */
const BASE_FAILURE_PATTERNS: readonly FailurePattern[] = [
  {
    kind: 'rate-limited',
    retryable: true,
    pattern: /rate[ -]?limit|usage limit|quota exceeded|too many requests|\b429\b/i,
  },
  {
    kind: 'authentication-expired',
    retryable: false,
    pattern: /(?:token|session|credential(?:s)?|authentication|oauth)[^.\n]{0,60}expired/i,
  },
  {
    kind: 'authentication-required',
    retryable: false,
    pattern:
      /login required|please (?:log ?in|sign ?in|authenticate)|not (?:logged|signed) in|unauthorized|\b401\b|invalid api key|authentication required/i,
  },
  {
    kind: 'network',
    retryable: true,
    pattern:
      /\bnetwork\b|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|fetch failed|connection (?:refused|reset|aborted)|dns /i,
  },
  {
    kind: 'permission',
    retryable: false,
    pattern:
      /permission denied|\beacces\b|\beperm\b|insufficient permissions?|operation not permitted/i,
  },
]

/**
 * `resets at 2026-10-01T00:00:00Z` / `try again at ...` — the only reset
 * formats parsed. Fuzzy natural language ("in 3 hours", "at 11pm") is NOT
 * guessed: a wrong resetAt is worse than none. A missing resetAt never
 * strands the profile either — the §18.0 projection
 * (account-profile-status-service) writes a conservative default limitedUntil
 * (failure time + ACCOUNT_LIMITED_DEFAULT_DURATION_MS) whenever the
 * classification carries no resetAt, and reads a legacy `limited` row without
 * `limitedUntil` as expired once that window has passed.
 */
const RESET_AT_PATTERN =
  /(?:resets?\s+(?:at|on)|try again at)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i

export function parseResetAt(text: string): string | undefined {
  const match = RESET_AT_PATTERN.exec(text)
  const candidate = match?.[1]
  if (candidate === undefined) return undefined
  const parsed = Date.parse(candidate.replace(' ', 'T'))
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

/**
 * §17.3: evidence is ONLY the matched line (never the surrounding output),
 * passed through the existing secret mask first, then capped at 512 chars.
 */
export function buildEvidence(line: string): string {
  const masked = redactSecrets(line) as string
  return masked.replace(/\s+/g, ' ').trim().slice(0, AGENT_FAILURE_EVIDENCE_MAX)
}

function lastNonEmptyLine(outputTail: string): string | undefined {
  const lines = outputTail.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line !== undefined && line.trim().length > 0) return line
  }
  return undefined
}

/**
 * Factory for the per-agent classifiers: shared base patterns plus optional
 * agent-specific extras (checked first — a CLI's own phrasing is the most
 * specific signal it gives).
 */
export function createTextFailureClassifier(
  agentId: string,
  extraPatterns: readonly FailurePattern[] = [],
): AgentFailureClassifier {
  const patterns = [...extraPatterns, ...BASE_FAILURE_PATTERNS]

  return {
    agentId,

    classify(context) {
      const candidateLines = [
        ...(context.structuredEvents ?? []).map((event) => JSON.stringify(event)),
        ...context.outputTail.split(/\r?\n/),
      ]
      for (const { kind, retryable, pattern } of patterns) {
        const matched = candidateLines.find((line) => pattern.test(line))
        if (matched !== undefined) {
          return {
            kind,
            retryable,
            ...(kind === 'rate-limited'
              ? (() => {
                  const resetAt = parseResetAt(context.outputTail)
                  return resetAt === undefined ? {} : { resetAt }
                })()
              : {}),
            evidence: buildEvidence(matched),
          }
        }
      }
      // No recognizable text: a non-zero exit / signal means the process
      // itself died; a launch-time failure without output stays unknown.
      if (
        (context.exitCode !== undefined && context.exitCode !== 0) ||
        context.signal !== undefined
      ) {
        const lastLine = lastNonEmptyLine(context.outputTail)
        return {
          kind: 'process-crash',
          retryable: true,
          ...(lastLine === undefined ? {} : { evidence: buildEvidence(lastLine) }),
        }
      }
      return { kind: 'unknown', retryable: false }
    },
  }
}

/**
 * §17.0 seam: classify a live output chunk WITHOUT any lifecycle effect.
 * Deliberately unused by production code — a future "looks rate-limited" UI
 * hint would subscribe to `process.output` in AgentManager and call this,
 * still without killing the process or flipping Run/Profile state.
 */
export function classifyOutput(
  classifier: AgentFailureClassifier,
  outputChunk: string,
): AgentFailureClassification {
  return classifier.classify({ outputTail: outputChunk })
}
