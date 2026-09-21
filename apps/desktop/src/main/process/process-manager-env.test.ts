import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../events/event-bus'
import type { WorkspaceRuntime } from '../workspace/runtime'
import {
  createProcessManager,
  dropCaseShadowedKeys,
  type ProcessManagerDeps,
  type ProcessStartRequest,
} from './process-manager'

/**
 * P0-1 (docs/code-review-2026-09-21.md §2) — case-insensitive env collisions.
 *
 * On Windows, node-pty serializes the env block in insertion order WITHOUT
 * deduplicating, and the Windows environment lookup is case-insensitive and
 * returns the FIRST match. An inherited `Codex_Home` (or a smuggled lowercase
 * key from workspace.env) therefore shadows the explicit `CODEX_HOME` the
 * request asked for. ProcessManager defends by dropping inherited keys that
 * case-insensitively collide with the request env before handing the block to
 * node-pty (win32 host only — Linux/WSL env is case-sensitive).
 */

const windowsRuntime: WorkspaceRuntime = {
  ref: { kind: 'windows' },
  hostNative: true,
  resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
  resolveTerminal: () => ({ ok: true, data: { command: 'cmd.exe', args: [] } }),
  resolveCwd: (path) => path,
  resolveHostPath: (path) => ({ ok: true, data: path }),
  resolveDataRoot: () => 'C:\\Users\\test',
  resolveAgentProfilesRoot: () => 'C:\\Users\\test/agent-profiles',
  resolveAgentProfileHome: (agentId, slug) => ({
    ok: true,
    data: `C:\\Users\\test/agent-profiles/${agentId}/${slug}`,
  }),

  validate: () => ({ ok: true, data: { kind: 'windows', hostNative: true } }),
}

function request(id: string, env: Record<string, string>): ProcessStartRequest {
  return {
    id,
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'echo ok'],
    cwd: 'C:\\repo',
    env,
    runtime: windowsRuntime,
    workspaceId: 'ws1',
  }
}

function fakePtyBackend(): {
  spawn: NonNullable<ProcessManagerDeps['spawn']>
  calls: Array<{ file: string; args: string[] | string; options: unknown }>
} {
  const calls: Array<{ file: string; args: string[] | string; options: unknown }> = []
  const spawn: NonNullable<ProcessManagerDeps['spawn']> = (file, args, options) => {
    calls.push({ file, args: typeof args === 'string' ? args : [...args], options })
    const terminal: IPty = {
      pid: 10_000 + calls.length,
      cols: options.cols ?? 0,
      rows: options.rows ?? 0,
      process: file,
      handleFlowControl: false,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    }
    return terminal
  }
  return { spawn, calls }
}

describe('dropCaseShadowedKeys (P0-1)', () => {
  it('drops every base key that case-insensitively collides with an overlay key', () => {
    expect(
      dropCaseShadowedKeys(
        { Path: 'C:\\bin', HOME: 'C:\\u', Codex_Home: 'C:\\ambient' },
        { PATH: 'C:\\other', CODEX_HOME: 'C:\\profile' },
      ),
    ).toEqual({ HOME: 'C:\\u' })
  })

  it('keeps everything when no key collides', () => {
    const base = { EDITOR: 'vim', HOME: '/u' }
    expect(dropCaseShadowedKeys(base, { CODEX_HOME: '/profile' })).toEqual(base)
  })
})

describe('ProcessManager env case-collision defense (P0-1)', () => {
  const PROBE = 'TESKRA_P01_PROBE'

  function withAmbientProbe<T>(run: () => T): T {
    const inherited = process.env[PROBE]
    process.env[PROBE] = 'AMBIENT'
    try {
      return run()
    } finally {
      if (inherited === undefined) {
        delete process.env[PROBE]
      } else {
        process.env[PROBE] = inherited
      }
    }
  }

  it('on a win32 host the request env shadows inherited case variants', () => {
    withAmbientProbe(() => {
      const backend = fakePtyBackend()
      const manager = createProcessManager({
        events: createEventBus(),
        spawn: backend.spawn,
        hostPlatform: 'win32',
      })

      const started = manager.start(request('p-win', { teskra_p01_probe: 'EXPLICIT' }))

      expect(started.ok).toBe(true)
      const options = backend.calls[0]?.options as { env: Record<string, string> }
      expect(options.env['teskra_p01_probe']).toBe('EXPLICIT')
      expect(options.env[PROBE]).toBeUndefined()
    })
  })

  it('on a linux host both casings survive (env is case-sensitive there)', () => {
    withAmbientProbe(() => {
      const backend = fakePtyBackend()
      const manager = createProcessManager({
        events: createEventBus(),
        spawn: backend.spawn,
        hostPlatform: 'linux',
      })

      const started = manager.start(request('p-linux', { teskra_p01_probe: 'EXPLICIT' }))

      expect(started.ok).toBe(true)
      const options = backend.calls[0]?.options as { env: Record<string, string> }
      expect(options.env['teskra_p01_probe']).toBe('EXPLICIT')
      expect(options.env[PROBE]).toBe('AMBIENT')
    })
  })
})

// ---------------------------------------------------------------------------
// [Windows 验证] Real node-pty reproduction of the P0-1 report: win32 only.
// Exercises the exact scenario from docs/code-review-2026-09-21.md §2 P0-1
// (cmd /c echo %VAR% with a case-conflicting env block) and the ProcessManager
// defense end-to-end. Skipped on non-Windows hosts.
// ---------------------------------------------------------------------------

const itWindows = process.platform === 'win32' ? it : it.skip

interface PtyRun {
  readonly output: string
  readonly exitCode: number
}

function runCmd(env: Record<string, string>, variable: string): Promise<PtyRun> {
  const terminal = spawn(
    process.env['ComSpec'] ?? 'cmd.exe',
    ['/d', '/s', '/c', `echo %${variable}%`],
    { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env },
  )
  return new Promise<PtyRun>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      terminal.kill()
      reject(new Error(`node-pty P0-1 probe for %${variable}% timed out`))
    }, 10_000)
    terminal.onData((data) => {
      output += data
    })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve({ output, exitCode })
    })
  })
}

describe('node-pty Windows env block behavior (P0-1, [Windows 验证])', () => {
  itWindows(
    'raw node-pty: the FIRST case-insensitive match in the env block wins',
    async () => {
      // The exact reproduction from the code review: a lowercase smuggled key
      // inserted before the profile's own casing wins the lookup.
      const result = await runCmd(
        {
          ...(process.env as Record<string, string>),
          teskra_p01_raw: 'SMUGGLED',
          TESKRA_P01_RAW: 'PROFILE',
        },
        'TESKRA_P01_RAW',
      )
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('SMUGGLED')
      expect(result.output).not.toContain('PROFILE')
    },
    15_000,
  )

  itWindows(
    'ProcessManager defense: the explicit request env wins end-to-end',
    async () => {
      const probe = 'TESKRA_P01_E2E'
      const inherited = process.env[probe]
      process.env[probe] = 'AMBIENT'
      try {
        const events = createEventBus()
        const manager = createProcessManager({ events })
        const output = new Promise<string>((resolve, reject) => {
          let collected = ''
          const timer = setTimeout(() => reject(new Error('P0-1 e2e probe timed out')), 10_000)
          events.subscribe('process.output', (event) => {
            if (event.processId === 'p-e2e') collected += event.data
          })
          events.subscribe('process.exited', (event) => {
            if (event.processId !== 'p-e2e') return
            clearTimeout(timer)
            resolve(collected)
          })
        })
        const started = manager.start({
          ...request('p-e2e', { teskra_p01_e2e: 'EXPLICIT' }),
          command: process.env['ComSpec'] ?? 'cmd.exe',
          args: ['/d', '/s', '/c', `echo %${probe}%`],
          cwd: process.cwd(),
        })
        expect(started.ok).toBe(true)

        // Without dropCaseShadowedKeys the inherited AMBIENT casing would sit
        // first in the env block and win the lookup (see the raw repro above).
        expect(await output).toContain('EXPLICIT')
        expect(await output).not.toContain('AMBIENT')
      } finally {
        if (inherited === undefined) {
          delete process.env[probe]
        } else {
          process.env[probe] = inherited
        }
      }
    },
    15_000,
  )
})
