import { describe, expect, it } from 'vitest'

import {
  createWorkspaceRequestSchema,
  futureRuntimePortSchema,
  listRecentWorkspacesRequestSchema,
  openWorkspaceRequestSchema,
  systemHealthSchema,
  systemInfoSchema,
  systemPathsSchema,
  workspaceValidationSchema,
} from './index'

describe('Runtime Facade contracts (TASK-081)', () => {
  it('validates workspace port request/response shapes', () => {
    expect(
      createWorkspaceRequestSchema.safeParse({
        name: 'Demo',
        runtime: { kind: 'windows' },
        path: 'C:\\repo',
      }).success,
    ).toBe(true)
    expect(
      openWorkspaceRequestSchema.safeParse({ runtime: { kind: 'wsl' }, path: '/repo' }).success,
    ).toBe(true)
    expect(listRecentWorkspacesRequestSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(workspaceValidationSchema.safeParse({ exists: null }).success).toBe(true)
  })

  it('validates system info, paths, health, and future port names', () => {
    expect(
      systemInfoSchema.safeParse({ appVersion: '1.0.0', runtimeVersion: '22.0.0' }).success,
    ).toBe(true)
    expect(
      systemPathsSchema.safeParse({
        dataDirectory: '/data',
        logDirectory: '/data/logs',
        databaseFile: '/data/db.sqlite',
      }).success,
    ).toBe(true)
    expect(
      systemHealthSchema.safeParse({
        databaseAvailable: true,
        wslAvailable: false,
        issues: [{ code: 'WSL_NOT_AVAILABLE', message: 'missing', retryable: false }],
      }).success,
    ).toBe(true)
    expect(futureRuntimePortSchema.safeParse('agent').success).toBe(true)
    expect(futureRuntimePortSchema.safeParse('terminal').success).toBe(false)
  })
})
