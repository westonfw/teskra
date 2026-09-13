import { describe, expect, it, vi } from 'vitest'

import type { IpcResult } from '@teskra/contracts'

import type { HostProcessControl } from './host-processes'
import { terminateSurvivorProcess } from './survivor'

/**
 * P0-2 / §19.5 — the pid-identity survivor judgment shared by reconciliation
 * (TASK-040) and cross-profile continuation (TASK-107).
 */

function hostProcesses(overrides: Partial<HostProcessControl> = {}): HostProcessControl {
  return {
    probe: vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: false })),
    identity: vi.fn(async (): Promise<IpcResult<string | null>> => ({ ok: true, data: null })),
    terminate: vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined })),
    ...overrides,
  }
}

const RUN = { id: 'run-1', pid: 4242, pidIdentity: 'token-A' }

describe('terminateSurvivorProcess (§19.5)', () => {
  it('returns none when no control is composed or no pid is recorded', async () => {
    expect(await terminateSurvivorProcess(undefined, RUN)).toBe('none')
    expect(await terminateSurvivorProcess(hostProcesses(), { id: 'run-1' })).toBe('none')
  })

  it('a gone pid (identity null) is dead — never terminated', async () => {
    const control = hostProcesses()
    expect(await terminateSurvivorProcess(control, RUN)).toBe('none')
    expect(control.terminate).not.toHaveBeenCalled()
  })

  it('an identity mismatch means the pid was reused — dead, never terminated', async () => {
    const control = hostProcesses({
      identity: vi.fn(async () => ({ ok: true as const, data: 'other-token' })),
    })
    expect(await terminateSurvivorProcess(control, RUN)).toBe('none')
    expect(control.terminate).not.toHaveBeenCalled()
  })

  it('a failed identity read is neither dead nor verified — alive, never terminated', async () => {
    const control = hostProcesses({
      identity: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'UNKNOWN' as const, message: 'stat failed', retryable: true },
      })),
    })
    expect(await terminateSurvivorProcess(control, RUN)).toBe('alive')
    expect(control.terminate).not.toHaveBeenCalled()
  })

  it('a verified survivor is terminated with its recorded pid', async () => {
    const control = hostProcesses({
      identity: vi.fn(async () => ({ ok: true as const, data: 'token-A' })),
    })
    expect(await terminateSurvivorProcess(control, RUN)).toBe('terminated')
    expect(control.terminate).toHaveBeenCalledWith(4242)
  })

  it('a verified survivor that cannot be terminated reports alive', async () => {
    const control = hostProcesses({
      identity: vi.fn(async () => ({ ok: true as const, data: 'token-A' })),
      terminate: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'UNKNOWN' as const, message: 'taskkill failed', retryable: true },
      })),
    })
    expect(await terminateSurvivorProcess(control, RUN)).toBe('alive')
  })

  it('legacy rows without a token fall back to probe-only liveness', async () => {
    const legacy = { id: 'run-legacy', pid: 4242 }
    const dead = hostProcesses()
    expect(await terminateSurvivorProcess(dead, legacy)).toBe('none')
    expect(dead.probe).toHaveBeenCalledWith(4242)
    expect(dead.terminate).not.toHaveBeenCalled()

    const alive = hostProcesses({
      probe: vi.fn(async () => ({ ok: true as const, data: true })),
    })
    expect(await terminateSurvivorProcess(alive, legacy)).toBe('terminated')

    const probeFailed = hostProcesses({
      probe: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'UNKNOWN' as const, message: 'ps failed', retryable: true },
      })),
    })
    expect(await terminateSurvivorProcess(probeFailed, legacy)).toBe('none')
    expect(probeFailed.terminate).not.toHaveBeenCalled()
  })
})
