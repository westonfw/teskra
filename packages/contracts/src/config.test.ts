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
    expect(DEFAULT_CONFIG.environment.defaultDistro).toBeNull()
  })

  it('layer schema accepts deep-partial layers and rejects unknown keys', () => {
    expect(teskraConfigLayerSchema.safeParse({ logging: { level: 'debug' } }).success).toBe(true)
    expect(teskraConfigLayerSchema.safeParse({}).success).toBe(true)
    expect(teskraConfigLayerSchema.safeParse({ bogus: true }).success).toBe(false)
    expect(teskraConfigLayerSchema.safeParse({ logging: { level: 'loud' } }).success).toBe(false)
    expect(
      teskraConfigLayerSchema.safeParse({ environment: { defaultDistro: 'Ubuntu-24.04' } }).success,
    ).toBe(true)
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
