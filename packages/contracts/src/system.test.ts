import { describe, expect, it } from 'vitest'

import {
  createWorkspaceRequestSchema,
  futureRuntimePortSchema,
  listRecentWorkspacesRequestSchema,
  openExternalRequestSchema,
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

  it('openExternalRequestSchema requires a parseable absolute URL (scheme check lives in Main)', () => {
    expect(openExternalRequestSchema.safeParse({ url: 'https://chatgpt.com/codex' }).success).toBe(
      true,
    )
    // Zod only guarantees URL-ness; the https:-only policy is enforced Main-side.
    expect(openExternalRequestSchema.safeParse({ url: 'http://example.com' }).success).toBe(true)
    expect(openExternalRequestSchema.safeParse({ url: 'not a url' }).success).toBe(false)
    expect(openExternalRequestSchema.safeParse({ url: 'https://a.b/c', extra: 1 }).success).toBe(
      false,
    )
  })
})
