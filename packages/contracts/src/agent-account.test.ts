import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_AUTH_TYPES,
  ACCOUNT_PROFILE_STATUSES,
  agentAccountProfileSchema,
  agentRunProfileSnapshotSchema,
  agentRuntimeIdentitySchema,
  configHomeSchema,
} from './agent-account'
import {
  AGENT_FAILURE_EVIDENCE_MAX,
  AGENT_FAILURE_KINDS,
  agentFailureClassificationSchema,
} from './agent-failure'
import { agentRunSchema, startAgentRunRequestSchema } from './agent'

const NOW = '2026-09-13T00:00:00.000Z'

function validProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct_codex_personal',
    agentId: 'codex',
    name: 'Codex Personal',
    authType: 'subscription',
    runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    configHome: '/home/weston/.teskra/agent-profiles/codex/personal',
    status: 'ready',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('agentAccountProfileSchema (Milestone 24 §5)', () => {
  it('accepts the §5.2 WSL example', () => {
    expect(agentAccountProfileSchema.safeParse(validProfile()).success).toBe(true)
  })

  it('accepts a Windows profile with an absolute drive path', () => {
    const result = agentAccountProfileSchema.safeParse(
      validProfile({
        runtime: { kind: 'windows' },
        configHome: 'C:\\Users\\weston\\.teskra\\agent-profiles\\codex\\personal',
      }),
    )
    expect(result.success).toBe(true)
  })

  it('keeps the §16 status set (no disabled) and the auth types', () => {
    expect(ACCOUNT_PROFILE_STATUSES).toEqual([
      'ready',
      'login-required',
      'limited',
      'expired',
      'unknown',
    ])
    expect(ACCOUNT_AUTH_TYPES).toEqual(['subscription', 'api-key', 'external'])
    expect(agentAccountProfileSchema.safeParse(validProfile({ status: 'disabled' })).success).toBe(
      false,
    )
  })

  it('rejects a wsl profile without a distro (§7 cross-object constraint)', () => {
    const result = agentAccountProfileSchema.safeParse(validProfile({ runtime: { kind: 'wsl' } }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'runtime.distro')).toBe(
        true,
      )
    }
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ runtime: { kind: 'wsl', distro: '' } }))
        .success,
    ).toBe(false)
  })

  it('rejects runtime kinds outside the first-phase windows/wsl set', () => {
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ runtime: { kind: 'ssh' } })).success,
    ).toBe(false)
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ runtime: { kind: 'container' } })).success,
    ).toBe(false)
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ runtime: { kind: 'linux' } })).success,
    ).toBe(false)
  })

  it('rejects maxConcurrentRuns of 0 or negative; accepts undefined or >= 1', () => {
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ maxConcurrentRuns: 0 })).success,
    ).toBe(false)
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ maxConcurrentRuns: -1 })).success,
    ).toBe(false)
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ maxConcurrentRuns: 1.5 })).success,
    ).toBe(false)
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ maxConcurrentRuns: 1 })).success,
    ).toBe(true)
    expect(agentAccountProfileSchema.safeParse(validProfile()).success).toBe(true)
  })
})

describe('configHomeSchema (§5.3 path semantics)', () => {
  it.each([
    ['POSIX absolute', '/home/weston/.teskra/agent-profiles/codex/personal'],
    ['Windows drive with backslashes', 'C:\\Users\\weston\\.codex'],
    ['Windows drive with forward slashes', 'C:/Users/weston/.codex'],
    ['UNC', '\\\\server\\share\\agent-profiles\\codex'],
  ])('accepts %s', (_label, value) => {
    expect(configHomeSchema.safeParse(value).success).toBe(true)
  })

  it.each([
    ['~ expansion', '~/.codex'],
    ['~user expansion', '~weston/.codex'],
    ['POSIX env reference', '$HOME/.codex'],
    ['Windows env reference', '%USERPROFILE%\\.codex'],
    ['relative path', 'profiles/codex'],
    ['Windows relative path', '.\\profiles\\codex'],
    ['drive-relative path', 'C:profiles\\codex'],
  ])('rejects %s', (_label, value) => {
    expect(configHomeSchema.safeParse(value).success).toBe(false)
  })

  it('rejects configHome inside a profile as well', () => {
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ configHome: '~/.codex' })).success,
    ).toBe(false)
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ configHome: 'relative/path' })).success,
    ).toBe(false)
    // Optional: an external profile without an isolated home is valid.
    expect(
      agentAccountProfileSchema.safeParse(validProfile({ configHome: undefined })).success,
    ).toBe(true)
  })
})

describe('agentFailureClassificationSchema (§17, ADR-0010)', () => {
  it('keeps the §17.1 kind set', () => {
    expect(AGENT_FAILURE_KINDS).toEqual([
      'rate-limited',
      'authentication-required',
      'authentication-expired',
      'network',
      'permission',
      'process-crash',
      'unknown',
    ])
  })

  it('accepts a full classification', () => {
    const result = agentFailureClassificationSchema.safeParse({
      kind: 'rate-limited',
      resetAt: NOW,
      retryable: true,
      evidence: 'usage limit reached, resets at 2026-09-14',
    })
    expect(result.success).toBe(true)
  })

  it('accepts evidence at exactly 512 chars and rejects 513 (§17.3)', () => {
    expect(
      agentFailureClassificationSchema.safeParse({
        kind: 'rate-limited',
        retryable: true,
        evidence: 'x'.repeat(AGENT_FAILURE_EVIDENCE_MAX),
      }).success,
    ).toBe(true)
    expect(
      agentFailureClassificationSchema.safeParse({
        kind: 'rate-limited',
        retryable: true,
        evidence: 'x'.repeat(AGENT_FAILURE_EVIDENCE_MAX + 1),
      }).success,
    ).toBe(false)
  })

  it('requires retryable and rejects unknown kinds', () => {
    expect(agentFailureClassificationSchema.safeParse({ kind: 'rate-limited' }).success).toBe(false)
    expect(
      agentFailureClassificationSchema.safeParse({ kind: 'quota', retryable: true }).success,
    ).toBe(false)
  })
})

describe('agentRunProfileSnapshotSchema / agentRuntimeIdentitySchema (§7 / §40)', () => {
  it('accepts a full snapshot', () => {
    const result = agentRunProfileSnapshotSchema.safeParse({
      accountProfileId: 'acct_codex_personal',
      accountProfileName: 'Codex Personal',
      executionProfileId: 'exec_codex_gpt5',
      executionProfileName: 'Codex GPT-5',
      runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
      configHome: '/home/weston/.teskra/agent-profiles/codex/personal',
      model: 'gpt-5',
      reasoningEffort: 'high',
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty snapshot (legacy run without profiles)', () => {
    expect(agentRunProfileSnapshotSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a snapshot with a non-absolute configHome', () => {
    expect(agentRunProfileSnapshotSchema.safeParse({ configHome: '~/.codex' }).success).toBe(false)
  })

  it('accepts a runtime identity and rejects one without runtime', () => {
    expect(
      agentRuntimeIdentitySchema.safeParse({
        agentId: 'codex',
        accountProfileId: 'acct_codex_personal',
        runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
        configHome: '/home/weston/.teskra/agent-profiles/codex/personal',
      }).success,
    ).toBe(true)
    expect(agentRuntimeIdentitySchema.safeParse({ agentId: 'codex' }).success).toBe(false)
  })
})

describe('agentRunSchema / startAgentRunRequestSchema profile fields (§7 / §14)', () => {
  const minimalRun = {
    id: 'run-1',
    workspaceId: 'ws-1',
    agentType: 'codex',
    status: 'created',
    executionMode: 'orchestrated',
    runDir: 'runs/run-1',
    createdAt: NOW,
    updatedAt: NOW,
  }

  it('accepts runs without profile fields (legacy rows)', () => {
    expect(agentRunSchema.safeParse(minimalRun).success).toBe(true)
  })

  it('accepts accountProfileId / executionProfileId / profileSnapshot / failureClassification', () => {
    const result = agentRunSchema.safeParse({
      ...minimalRun,
      accountProfileId: 'acct_codex_personal',
      executionProfileId: 'exec_codex_gpt5',
      profileSnapshot: { accountProfileName: 'Codex Personal' },
      failureClassification: { kind: 'rate-limited', retryable: true },
    })
    expect(result.success).toBe(true)
  })

  it('still rejects unknown fields (strictObject) and agentId misnomers (§4.5)', () => {
    expect(agentRunSchema.safeParse({ ...minimalRun, agentId: 'codex' }).success).toBe(false)
    expect(agentRunSchema.safeParse({ ...minimalRun, accountProfile: 'x' }).success).toBe(false)
  })

  it('validates nested profileSnapshot and failureClassification', () => {
    expect(
      agentRunSchema.safeParse({
        ...minimalRun,
        profileSnapshot: { configHome: 'relative/path' },
      }).success,
    ).toBe(false)
    expect(
      agentRunSchema.safeParse({
        ...minimalRun,
        failureClassification: { kind: 'rate-limited' },
      }).success,
    ).toBe(false)
  })

  it('accepts accountProfileId / executionProfileId on the start request', () => {
    const base = { workspaceId: 'ws-1', agentType: 'codex' }
    expect(startAgentRunRequestSchema.safeParse(base).success).toBe(true)
    expect(
      startAgentRunRequestSchema.safeParse({
        ...base,
        accountProfileId: 'acct_codex_personal',
        executionProfileId: 'exec_codex_gpt5',
      }).success,
    ).toBe(true)
    expect(startAgentRunRequestSchema.safeParse({ ...base, agentId: 'codex' }).success).toBe(false)
  })
})
