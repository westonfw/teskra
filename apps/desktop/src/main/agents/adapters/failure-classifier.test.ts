import { describe, expect, it } from 'vitest'

import { AGENT_FAILURE_EVIDENCE_MAX } from '@teskra/contracts'

import { createClaudeFailureClassifier } from './claude-failure-classifier'
import { createCodexFailureClassifier } from './codex-failure-classifier'
import { buildEvidence, classifyOutput, parseResetAt } from './failure-classifier'

const codex = createCodexFailureClassifier()
const claude = createClaudeFailureClassifier()

describe('AgentFailureClassifier (TASK-105, §17)', () => {
  it('classifies rate limit text, parses resetAt, and marks the failure retryable', () => {
    const result = codex.classify({
      exitCode: 1,
      outputTail: [
        'Thinking…',
        "Error: You've hit your usage limit. Try again at 2026-10-01T12:30:00Z",
      ].join('\n'),
    })
    expect(result).toEqual({
      kind: 'rate-limited',
      retryable: true,
      resetAt: '2026-10-01T12:30:00.000Z',
      evidence: "Error: You've hit your usage limit. Try again at 2026-10-01T12:30:00Z",
    })
  })

  it('classifies "resets at" hints into a normalized ISO resetAt', () => {
    const result = codex.classify({
      exitCode: 1,
      outputTail: 'Rate limit reached for gpt-5. Quota resets at 2026-10-02 00:00:00+00:00',
    })
    expect(result.kind).toBe('rate-limited')
    expect(result.resetAt).toBe('2026-10-02T00:00:00.000Z')
  })

  it('leaves resetAt undefined when the hint is fuzzy natural language', () => {
    const result = claude.classify({
      exitCode: 1,
      outputTail: 'Claude AI usage limit reached. Your limit will reset at 11pm.',
    })
    expect(result.kind).toBe('rate-limited')
    expect(result.resetAt).toBeUndefined()
  })

  it('distinguishes authentication-expired from authentication-required', () => {
    expect(
      claude.classify({ exitCode: 1, outputTail: 'Error: OAuth token has expired. Run /login.' })
        .kind,
    ).toBe('authentication-expired')
    expect(
      codex.classify({
        exitCode: 1,
        outputTail: '401 Unauthorized: please log in with `codex login`',
      }).kind,
    ).toBe('authentication-required')
  })

  it('maps a Claude credit-balance error to rate-limited', () => {
    const result = claude.classify({
      exitCode: 1,
      outputTail: 'API Error: 400 {"error":{"message":"Your credit balance is too low"}}',
    })
    expect(result.kind).toBe('rate-limited')
  })

  it('classifies network failures as retryable', () => {
    expect(
      codex.classify({ exitCode: 1, outputTail: 'stream error: connection reset by peer' }).kind,
    ).toBe('network')
    expect(
      claude.classify({ exitCode: 1, outputTail: 'request failed: ETIMEDOUT api.anthropic.com' }),
    ).toMatchObject({ kind: 'network', retryable: true })
  })

  it('classifies permission failures', () => {
    expect(
      codex.classify({ exitCode: 1, outputTail: 'Error: EACCES: permission denied, open /etc/x' })
        .kind,
    ).toBe('permission')
  })

  it('falls back to process-crash for an unrecognized non-zero exit and keeps the last line as evidence', () => {
    const result = codex.classify({
      exitCode: 134,
      outputTail: 'compiling…\nthread panicked at index out of bounds\n',
    })
    expect(result.kind).toBe('process-crash')
    expect(result.retryable).toBe(true)
    expect(result.evidence).toBe('thread panicked at index out of bounds')
  })

  it('falls back to unknown when there is no exit code and no recognizable text', () => {
    expect(codex.classify({ outputTail: 'Agent could not be started.' })).toEqual({
      kind: 'unknown',
      retryable: false,
    })
  })

  it('prefers structured provider events over the surrounding PTY text (§17.0 (b))', () => {
    const result = codex.classify({
      exitCode: 1,
      structuredEvents: [{ type: 'error', message: 'quota exceeded for this workspace' }],
      outputTail: 'the user asked about quota exceeded handling in their diff\n',
    })
    expect(result.kind).toBe('rate-limited')
    expect(result.evidence).toContain('quota exceeded for this workspace')
  })

  it('masks secret shapes in evidence before truncating (§17.3)', () => {
    const line =
      'Error: rate limit for key sk-abc123DEF456ghi789 and ghp_tokenvalue123 — retry later'
    const result = codex.classify({ exitCode: 1, outputTail: line })
    expect(result.evidence).not.toContain('sk-abc123')
    expect(result.evidence).not.toContain('ghp_tokenvalue123')
    expect(result.evidence).toContain('[redacted]')
  })

  it('truncates evidence to AGENT_FAILURE_EVIDENCE_MAX (§17.3)', () => {
    const line = `rate limit: ${'x'.repeat(2 * AGENT_FAILURE_EVIDENCE_MAX)}`
    const result = codex.classify({ exitCode: 1, outputTail: line })
    expect(result.evidence?.length).toBeLessThanOrEqual(AGENT_FAILURE_EVIDENCE_MAX)
  })

  it('keeps only the matched line, never the whole output (§17.3)', () => {
    const result = codex.classify({
      exitCode: 1,
      outputTail: 'line one\nline two\nquota exceeded on request 3\nline four',
    })
    expect(result.evidence).toBe('quota exceeded on request 3')
  })
})

describe('parseResetAt / buildEvidence helpers', () => {
  it('rejects garbage dates and unrelated text', () => {
    expect(parseResetAt('resets at next Tuesday')).toBeUndefined()
    expect(parseResetAt('resets at 2026-13-99T99:99:99Z')).toBeUndefined()
    expect(parseResetAt('no hint here')).toBeUndefined()
  })

  it('buildEvidence collapses whitespace and masks secrets', () => {
    expect(buildEvidence('  quota   exceeded\tnow ')).toBe('quota exceeded now')
    expect(buildEvidence('token sk-livekey12345')).toBe('token [redacted]')
  })
})

describe('classifyOutput (§17.0 weak-signal seam)', () => {
  it('classifies a live chunk without any exit context', () => {
    const result = classifyOutput(codex, 'quota exceeded')
    expect(result.kind).toBe('rate-limited')
  })
})
