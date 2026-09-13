import { describe, expect, it } from 'vitest'

import {
  agentExecutionProfileSchema,
  createExecutionProfileRequestSchema,
  listExecutionProfilesRequestSchema,
  setDefaultExecutionProfileRequestSchema,
  updateExecutionProfileRequestSchema,
} from './agent-execution-profile'

/**
 * TASK-109 (Milestone 24 §6.1/§8.2): the execution profile contract. The
 * schema must stay同形 with the design doc §6.1 interface and the §8.2 table —
 * and must NOT grow permission/tool/skill/env profile IDs (§6.1; those
 * entities do not exist, adding them back is §6.2).
 */

const VALID = {
  id: 'exec-1',
  name: 'Codex Personal High',
  agentId: 'codex',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

describe('agentExecutionProfileSchema (TASK-109)', () => {
  it('accepts a minimal profile (only the required fields)', () => {
    const parsed = agentExecutionProfileSchema.safeParse(VALID)
    expect(parsed.success).toBe(true)
  })

  it('accepts a fully populated profile', () => {
    const parsed = agentExecutionProfileSchema.safeParse({
      ...VALID,
      accountProfileId: 'acct-1',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      approvalMode: 'safe-auto',
    })
    expect(parsed.success).toBe(true)
  })

  it('requires id / name / agentId / timestamps', () => {
    for (const field of ['id', 'name', 'agentId', 'createdAt', 'updatedAt'] as const) {
      const candidate = { ...VALID, [field]: '' }
      expect(agentExecutionProfileSchema.safeParse(candidate).success, field).toBe(false)
      const rest = Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== field))
      expect(agentExecutionProfileSchema.safeParse(rest).success, `missing ${field}`).toBe(false)
    }
  })

  it('rejects empty optional references instead of treating them as unset', () => {
    for (const field of ['accountProfileId', 'model', 'reasoningEffort'] as const) {
      expect(agentExecutionProfileSchema.safeParse({ ...VALID, [field]: '' }).success, field).toBe(
        false,
      )
    }
  })

  it('reuses the existing approvalMode enum', () => {
    expect(agentExecutionProfileSchema.safeParse({ ...VALID, approvalMode: 'yolo' }).success).toBe(
      false,
    )
    for (const mode of ['read-only', 'manual', 'safe-auto', 'full-auto'] as const) {
      expect(agentExecutionProfileSchema.safeParse({ ...VALID, approvalMode: mode }).success).toBe(
        true,
      )
    }
  })

  it('has exactly the §6.1/§8.2 fields — no permission/tool/skill/env profile IDs', () => {
    expect(Object.keys(agentExecutionProfileSchema.shape).sort()).toEqual(
      [
        'id',
        'name',
        'agentId',
        'accountProfileId',
        'model',
        'reasoningEffort',
        'approvalMode',
        'createdAt',
        'updatedAt',
      ].sort(),
    )
    // strictObject: the §6.2 entities must not sneak in as unrecognized keys.
    for (const field of [
      'permissionProfileId',
      'toolProfileId',
      'skillProfileId',
      'envProfileId',
    ]) {
      expect(agentExecutionProfileSchema.safeParse({ ...VALID, [field]: 'x' }).success, field).toBe(
        false,
      )
    }
  })
})

describe('execution profile request schemas (TASK-109)', () => {
  it('create requires agentId + name; the profile fields stay optional', () => {
    expect(createExecutionProfileRequestSchema.safeParse({ agentId: 'codex', name: 'P' }).success)
    expect(createExecutionProfileRequestSchema.safeParse({ name: 'P' }).success).toBe(false)
    expect(createExecutionProfileRequestSchema.safeParse({ agentId: 'codex' }).success).toBe(false)
    expect(createExecutionProfileRequestSchema.safeParse({ agentId: '', name: 'P' }).success).toBe(
      false,
    )
  })

  it('update distinguishes clearing (null) from untouched (absent)', () => {
    const clearing = updateExecutionProfileRequestSchema.safeParse({
      id: 'exec-1',
      patch: { accountProfileId: null, model: null },
    })
    expect(clearing.success).toBe(true)
    if (clearing.success) {
      expect(clearing.data.patch).toEqual({ accountProfileId: null, model: null })
    }
    expect(updateExecutionProfileRequestSchema.safeParse({ id: 'exec-1', patch: {} }).success).toBe(
      true,
    )
    expect(
      updateExecutionProfileRequestSchema.safeParse({
        id: 'exec-1',
        patch: { approvalMode: 'sometimes' },
      }).success,
    ).toBe(false)
  })

  it('list filters by agentId only', () => {
    expect(listExecutionProfilesRequestSchema.safeParse({}).success).toBe(true)
    expect(listExecutionProfilesRequestSchema.safeParse({ agentId: 'codex' }).success).toBe(true)
    expect(listExecutionProfilesRequestSchema.safeParse({ status: 'ready' }).success).toBe(false)
  })

  it('set-default takes a nullable profileId (null clears)', () => {
    expect(
      setDefaultExecutionProfileRequestSchema.safeParse({ agentId: 'codex', profileId: 'e-1' })
        .success,
    ).toBe(true)
    expect(
      setDefaultExecutionProfileRequestSchema.safeParse({ agentId: 'codex', profileId: null })
        .success,
    ).toBe(true)
    expect(setDefaultExecutionProfileRequestSchema.safeParse({ agentId: 'codex' }).success).toBe(
      false,
    )
  })
})
