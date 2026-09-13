import type { AgentAccountProfile, WorkspaceRuntimeRef } from '@teskra/contracts'
import { describe, expect, it } from 'vitest'

import {
  continuationSourceStopFailed,
  groupContinuationCandidates,
  isContinuationCandidate,
  runtimeCompatible,
} from './continuation-candidates'

const AT = '2026-09-10T00:00:00.000Z'
const NOW = Date.parse('2026-09-12T12:00:00.000Z')
const WINDOWS: WorkspaceRuntimeRef = { kind: 'windows' }
const UBUNTU: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'Ubuntu-22.04' }

function makeProfile(overrides: Partial<AgentAccountProfile>): AgentAccountProfile {
  return {
    id: 'acct-1',
    agentId: 'codex',
    name: 'Personal',
    authType: 'subscription',
    runtime: { kind: 'windows' },
    status: 'ready',
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

describe('runtimeCompatible (§37 step 0)', () => {
  it('matches by kind, and by distro for wsl', () => {
    expect(runtimeCompatible({ kind: 'windows' }, WINDOWS)).toBe(true)
    expect(runtimeCompatible({ kind: 'wsl', distro: 'ubuntu-22.04' }, UBUNTU)).toBe(true)
    expect(runtimeCompatible({ kind: 'wsl', distro: 'Debian' }, UBUNTU)).toBe(false)
    expect(runtimeCompatible({ kind: 'wsl', distro: 'Ubuntu-22.04' }, WINDOWS)).toBe(false)
    expect(runtimeCompatible({ kind: 'windows' }, UBUNTU)).toBe(false)
  })
})

describe('isContinuationCandidate (TASK-108)', () => {
  it('offers enabled, compatible ready / unknown profiles', () => {
    expect(isContinuationCandidate(makeProfile({ status: 'ready' }), WINDOWS, NOW)).toBe(true)
    expect(isContinuationCandidate(makeProfile({ status: 'unknown' }), WINDOWS, NOW)).toBe(true)
  })

  it('excludes disabled, incompatible, login-required and expired profiles', () => {
    expect(isContinuationCandidate(makeProfile({ enabled: false }), WINDOWS, NOW)).toBe(false)
    expect(isContinuationCandidate(makeProfile({ runtime: UBUNTU }), WINDOWS, NOW)).toBe(false)
    expect(isContinuationCandidate(makeProfile({ status: 'login-required' }), WINDOWS, NOW)).toBe(
      false,
    )
    expect(isContinuationCandidate(makeProfile({ status: 'expired' }), WINDOWS, NOW)).toBe(false)
  })

  it('excludes a limited profile whose reset is still in the future', () => {
    const limited = makeProfile({
      status: 'limited',
      limitedUntil: '2026-09-12T13:00:00.000Z',
    })
    expect(isContinuationCandidate(limited, WINDOWS, NOW)).toBe(false)
  })

  it('re-admits a limited profile whose limitedUntil already passed (§18.0)', () => {
    const expiredLimit = makeProfile({
      status: 'limited',
      limitedUntil: '2026-09-12T03:12:00.000Z',
    })
    expect(isContinuationCandidate(expiredLimit, WINDOWS, NOW)).toBe(true)
  })

  it('does not re-admit a limited profile without a limitedUntil', () => {
    expect(isContinuationCandidate(makeProfile({ status: 'limited' }), WINDOWS, NOW)).toBe(false)
  })
})

describe('groupContinuationCandidates (§26)', () => {
  const profiles = [
    makeProfile({ id: 'codex-personal', name: 'Personal' }),
    makeProfile({ id: 'codex-work', name: 'Work' }),
    makeProfile({ id: 'claude-work', agentId: 'claude', name: 'Claude Work' }),
    makeProfile({ id: 'claude-limited', agentId: 'claude', status: 'limited' }),
  ]

  it('splits same-Agent and cross-Agent candidates and drops the source account', () => {
    const groups = groupContinuationCandidates(
      profiles,
      { agentType: 'codex', accountProfileId: 'codex-personal' },
      WINDOWS,
      NOW,
    )
    expect(groups.sameAgent.map(({ id }) => id)).toEqual(['codex-work'])
    expect(groups.crossAgent.map(({ id }) => id)).toEqual(['claude-work'])
  })

  it('keeps the source account when the run used the legacy environment', () => {
    const groups = groupContinuationCandidates(
      profiles,
      { agentType: 'codex', accountProfileId: undefined },
      WINDOWS,
      NOW,
    )
    expect(groups.sameAgent.map(({ id }) => id)).toEqual(['codex-personal', 'codex-work'])
  })
})

describe('continuationSourceStopFailed (§19.3)', () => {
  it('maps only CONFLICT / COMMAND_TIMEOUT to the source-stop message', () => {
    expect(continuationSourceStopFailed('CONFLICT')).toBe(true)
    expect(continuationSourceStopFailed('COMMAND_TIMEOUT')).toBe(true)
    expect(continuationSourceStopFailed('ACCOUNT_PROFILE_DISABLED')).toBe(false)
    expect(continuationSourceStopFailed('ACCOUNT_PROFILE_INCOMPATIBLE')).toBe(false)
    expect(continuationSourceStopFailed('UNKNOWN')).toBe(false)
  })
})
