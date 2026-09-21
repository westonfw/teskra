import { describe, expect, it } from 'vitest'

import {
  CONFIG_LAYERS,
  DEFAULT_CONFIG,
  teskraConfigLayerSchema,
  teskraConfigSchema,
  updateConfigRequestSchema,
} from './config'

describe('config contracts (TASK-080)', () => {
  it('ships four layers in override order', () => {
    expect(CONFIG_LAYERS).toEqual(['default', 'global', 'workspace', 'override'])
  })

  it('DEFAULT_CONFIG satisfies the full schema (plan §147 4/3/2, TASK-085 10min)', () => {
    const parsed = teskraConfigSchema.safeParse(DEFAULT_CONFIG)
    expect(parsed.success).toBe(true)
    expect(DEFAULT_CONFIG.concurrency).toEqual({
      maxGlobalRuns: 4,
      maxRunsPerWorkspace: 3,
      maxRunsPerAgent: 2,
    })
    expect(DEFAULT_CONFIG.watchdog.stalledThresholdMs).toBe(600_000)
    // TASK-119 (Milestone 25 §5.2/§5.3): preparing 5min, idle 2h, ask by default.
    expect(DEFAULT_CONFIG.watchdog.preparingTimeoutMs).toBe(300_000)
    expect(DEFAULT_CONFIG.watchdog.idleTimeoutMs).toBe(7_200_000)
    expect(DEFAULT_CONFIG.watchdog.idleAction).toBe('ask')
    expect(DEFAULT_CONFIG.environment.defaultDistro).toBeNull()
    // plan §135 / TASK-069: merged worktrees 1d, run logs 30d, discarded runs 30d.
    // TASK-133: default artifact patterns node_modules/.next/.turbo, idle 7d.
    expect(DEFAULT_CONFIG.retention).toEqual({
      mergedWorktreeDays: 1,
      completedRunLogsDays: 30,
      discardedRunDays: 30,
      worktreeArtifactPatterns: ['node_modules', '.next', '.turbo'],
      worktreeArtifactIdleDays: 7,
    })
    // TASK-122 (Milestone 25 §6.1): structured streams on by default.
    expect(DEFAULT_CONFIG.observability).toEqual({ structuredStream: true })
    // TASK-128 (ADR-0014 §4): decisions never expire unless opted in.
    // TASK-131 (§9.3): blocking decisions desktop-notify by default.
    expect(DEFAULT_CONFIG.decisions).toEqual({
      shellConfirmationTimeoutMs: 0,
      stalledRunTimeoutMs: 0,
      desktopNotifications: true,
    })
    // TASK-121 (Milestone 25 §5.4): one transient network retry by default.
    expect(DEFAULT_CONFIG.retry).toEqual({ transientAttempts: 1 })
  })

  it('retry transientAttempts is an integer in 0..3 (TASK-121)', () => {
    expect(teskraConfigLayerSchema.safeParse({ retry: { transientAttempts: 0 } }).success).toBe(
      true,
    )
    expect(teskraConfigLayerSchema.safeParse({ retry: { transientAttempts: 3 } }).success).toBe(
      true,
    )
    expect(teskraConfigLayerSchema.safeParse({ retry: { transientAttempts: 4 } }).success).toBe(
      false,
    )
    expect(teskraConfigLayerSchema.safeParse({ retry: { transientAttempts: -1 } }).success).toBe(
      false,
    )
    expect(teskraConfigLayerSchema.safeParse({ retry: { transientAttempts: 1.5 } }).success).toBe(
      false,
    )
  })

  it('decisions desktopNotifications is a boolean toggle (TASK-131)', () => {
    expect(
      teskraConfigLayerSchema.safeParse({ decisions: { desktopNotifications: false } }).success,
    ).toBe(true)
    expect(
      teskraConfigLayerSchema.safeParse({ decisions: { desktopNotifications: 'yes' } }).success,
    ).toBe(false)
  })

  it('decisions timeouts are integers >= 0 (0 = never expire)', () => {
    expect(
      teskraConfigLayerSchema.safeParse({ decisions: { shellConfirmationTimeoutMs: 60_000 } })
        .success,
    ).toBe(true)
    expect(
      teskraConfigLayerSchema.safeParse({ decisions: { stalledRunTimeoutMs: -1 } }).success,
    ).toBe(false)
    expect(
      teskraConfigLayerSchema.safeParse({ decisions: { stalledRunTimeoutMs: 1.5 } }).success,
    ).toBe(false)
  })

  it('retention worktree-artifact fields: partial layers, validated values (TASK-133)', () => {
    expect(
      teskraConfigLayerSchema.safeParse({ retention: { worktreeArtifactPatterns: ['dist'] } })
        .success,
    ).toBe(true)
    expect(
      teskraConfigLayerSchema.safeParse({ retention: { worktreeArtifactIdleDays: 14 } }).success,
    ).toBe(true)
    expect(
      teskraConfigLayerSchema.safeParse({ retention: { worktreeArtifactPatterns: [] } }).success,
    ).toBe(true)
    // Negative idle days, fractional days, empty pattern names, and non-array
    // patterns are all rejected.
    expect(
      teskraConfigLayerSchema.safeParse({ retention: { worktreeArtifactIdleDays: -1 } }).success,
    ).toBe(false)
    expect(
      teskraConfigLayerSchema.safeParse({ retention: { worktreeArtifactIdleDays: 1.5 } }).success,
    ).toBe(false)
    expect(
      teskraConfigLayerSchema.safeParse({ retention: { worktreeArtifactPatterns: [''] } }).success,
    ).toBe(false)
    expect(
      teskraConfigLayerSchema.safeParse({ retention: { worktreeArtifactPatterns: 'dist' } })
        .success,
    ).toBe(false)
  })

  it('layer schema accepts deep-partial layers and rejects unknown keys', () => {
    expect(teskraConfigLayerSchema.safeParse({ logging: { level: 'debug' } }).success).toBe(true)
    expect(teskraConfigLayerSchema.safeParse({}).success).toBe(true)
    expect(teskraConfigLayerSchema.safeParse({ bogus: true }).success).toBe(false)
    expect(teskraConfigLayerSchema.safeParse({ logging: { level: 'loud' } }).success).toBe(false)
    expect(
      teskraConfigLayerSchema.safeParse({ environment: { defaultDistro: 'Ubuntu-24.04' } }).success,
    ).toBe(true)
    expect(
      teskraConfigLayerSchema.safeParse({ observability: { structuredStream: false } }).success,
    ).toBe(true)
    expect(
      teskraConfigLayerSchema.safeParse({ observability: { structuredStream: 'off' } }).success,
    ).toBe(false)
  })

  it('requires a workspace id only for workspace-layer writes', () => {
    expect(
      updateConfigRequestSchema.safeParse({
        layer: 'global',
        patch: { logging: { level: 'warn' } },
      }).success,
    ).toBe(true)
    expect(
      updateConfigRequestSchema.safeParse({
        layer: 'workspace',
        patch: { logging: { level: 'warn' } },
      }).success,
    ).toBe(false)
    expect(
      updateConfigRequestSchema.safeParse({
        layer: 'workspace',
        workspaceId: 'ws1',
        patch: { logging: { level: 'warn' } },
      }).success,
    ).toBe(true)
  })
})
