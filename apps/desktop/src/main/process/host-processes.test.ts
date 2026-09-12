import { describe, expect, it, vi } from 'vitest'

import type { CommandRunner } from './command-runner'
import { createHostProcessControl } from './host-processes'

/** A pid that cannot exist (far above the Linux pid_max ceiling). */
const DEAD_PID = 67_000_000

function stubCommands(handler: CommandRunner['run']): CommandRunner {
  return { run: vi.fn(handler) }
}

describe('HostProcessControl (P0-2)', () => {
  describe('POSIX', () => {
    const control = createHostProcessControl({
      commands: stubCommands(async () => {
        throw new Error('POSIX control must not spawn commands')
      }),
      hostPlatform: 'linux',
    })

    it('probes a live pid and a dead pid without throwing', async () => {
      expect(await control.probe(process.pid)).toEqual({ ok: true, data: true })
      expect(await control.probe(DEAD_PID)).toEqual({ ok: true, data: false })
    })

    it('rejects invalid pids with a structured error', async () => {
      const probed = await control.probe(-1)
      expect(probed.ok).toBe(false)
      if (!probed.ok) expect(probed.error.code).toBe('VALIDATION_FAILED')
    })

    it('treats an already-gone terminate target as success', async () => {
      expect(await control.terminate(DEAD_PID)).toEqual({ ok: true, data: undefined })
    })

    it('reads a stable start-time token from /proc for a live pid, null for a dead one', async () => {
      const first = await control.identity(process.pid)
      expect(first.ok).toBe(true)
      if (first.ok) expect(typeof first.data).toBe('string')
      const second = await control.identity(process.pid)
      expect(second).toEqual(first)
      expect(await control.identity(DEAD_PID)).toEqual({ ok: true, data: null })
    })
  })

  describe('POSIX non-Linux (ps via CommandRunner)', () => {
    it('uses ps lstart as the identity token and maps empty output to null', async () => {
      const commands = stubCommands(async () => ({
        ok: true as const,
        data: { stdout: 'Sat Sep 12 10:00:00 2026\n', stderr: '', exitCode: 0 },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'darwin' })

      expect(await control.identity(4242)).toEqual({
        ok: true,
        data: 'Sat Sep 12 10:00:00 2026',
      })
      expect(commands.run).toHaveBeenCalledWith({
        command: 'ps',
        args: ['-o', 'lstart=', '-p', '4242'],
        timeoutMs: 5_000,
      })

      const gone = stubCommands(async () => ({
        ok: true as const,
        data: { stdout: '', stderr: '', exitCode: 1 },
      }))
      const goneControl = createHostProcessControl({ commands: gone, hostPlatform: 'darwin' })
      expect(await goneControl.identity(4242)).toEqual({ ok: true, data: null })
    })
  })

  describe('Windows (tasklist/taskkill via CommandRunner)', () => {
    it('parses tasklist output for the pid token', async () => {
      const commands = stubCommands(async () => ({
        ok: true as const,
        data: {
          stdout: 'wsl.exe                      4242 Console                    1     88,000 K\r\n',
          stderr: '',
          exitCode: 0,
        },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'win32' })

      expect(await control.probe(4242)).toEqual({ ok: true, data: true })
      expect(commands.run).toHaveBeenCalledWith({
        command: 'tasklist',
        args: ['/FI', 'PID eq 4242', '/NH'],
        timeoutMs: 5_000,
      })
    })

    it('reports not-alive when tasklist finds no matching task', async () => {
      const commands = stubCommands(async () => ({
        ok: true as const,
        data: {
          stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
          stderr: '',
          exitCode: 0,
        },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'win32' })

      expect(await control.probe(4242)).toEqual({ ok: true, data: false })
    })

    it('does not substring-match a different pid', async () => {
      const commands = stubCommands(async () => ({
        ok: true as const,
        data: {
          // "14242" contains "4242" as a substring; a naive includes() check
          // would false-positive on it, the word-boundary match must not.
          stdout: 'wsl.exe                     14242 Console                    1     88,000 K\r\n',
          stderr: '',
          exitCode: 0,
        },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'win32' })

      expect(await control.probe(4242)).toEqual({ ok: true, data: false })
    })

    it('surfaces a tasklist failure as an error result, not as "dead"', async () => {
      const commands = stubCommands(async () => ({
        ok: false as const,
        error: { code: 'COMMAND_TIMEOUT' as const, message: 'timed out', retryable: true },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'win32' })

      const probed = await control.probe(4242)
      expect(probed.ok).toBe(false)
    })

    it('terminates via taskkill tree-kill and checks the exit code', async () => {
      const commands = stubCommands(async (request) => ({
        ok: true as const,
        data: {
          stdout: request.command === 'taskkill' ? 'SUCCESS' : '',
          stderr: '',
          exitCode: request.command === 'taskkill' ? 0 : 1,
        },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'win32' })

      expect(await control.terminate(4242)).toEqual({ ok: true, data: undefined })
      expect(commands.run).toHaveBeenCalledWith({
        command: 'taskkill',
        args: ['/PID', '4242', '/T', '/F'],
        timeoutMs: 10_000,
      })
    })

    it('fails termination when taskkill exits non-zero', async () => {
      const commands = stubCommands(async () => ({
        ok: true as const,
        data: { stdout: '', stderr: 'ERROR: Access denied', exitCode: 1 },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'win32' })

      const terminated = await control.terminate(4242)
      expect(terminated.ok).toBe(false)
    })

    it('identifies a process via its PowerShell start time, null when gone', async () => {
      const commands = stubCommands(async () => ({
        ok: true as const,
        data: { stdout: '2026-09-12T10:00:00.0000000Z\r\n', stderr: '', exitCode: 0 },
      }))
      const control = createHostProcessControl({ commands, hostPlatform: 'win32' })

      expect(await control.identity(4242)).toEqual({
        ok: true,
        data: '2026-09-12T10:00:00.0000000Z',
      })
      const request = vi.mocked(commands.run).mock.calls[0]?.[0]
      expect(request?.command).toBe('powershell')
      expect(request?.args).toContain('-NoProfile')

      const gone = stubCommands(async () => ({
        ok: true as const,
        data: { stdout: '', stderr: '', exitCode: 0 },
      }))
      const goneControl = createHostProcessControl({ commands: gone, hostPlatform: 'win32' })
      expect(await goneControl.identity(4242)).toEqual({ ok: true, data: null })
    })
  })
})
