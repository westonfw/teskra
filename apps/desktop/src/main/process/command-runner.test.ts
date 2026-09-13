import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceRuntime } from '../workspace/runtime'
import {
  createCommandRunner,
  decodeCommandOutput,
  type CommandRunner,
  type CommandRunnerDeps,
} from './command-runner'

/** Node binary running a one-liner: a cross-platform one-shot command. */
const NODE = process.execPath
const nodeArgs = (script: string): string[] => ['-e', script]

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until `condition` holds or the deadline passes. */
async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) {
      return true
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return condition()
}

function run(runner: CommandRunner, script: string, extra: Record<string, unknown> = {}) {
  return runner.run({ command: NODE, args: nodeArgs(script), timeoutMs: 10_000, ...extra })
}

describe('CommandRunner (TASK-012)', () => {
  const runner = createCommandRunner()

  it('captures stdout/stderr/exitCode on success', async () => {
    const result = await run(runner, 'process.stdout.write("out"); process.stderr.write("err");')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 })
  })

  it('reports non-zero exit codes as data, not as errors', async () => {
    const result = await run(runner, 'process.exit(3)')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.exitCode).toBe(3)
  })

  it('times out, really kills the process tree, and leaves no orphan', async () => {
    // Grandchild sleep in the same process group: the runner must kill the
    // whole group, not just the direct child (plan §150 orphan rule).
    const dir = mkdtempSync(join(tmpdir(), 'teskra-cmd-'))
    const pidFile = join(dir, 'grandchild.pid')
    try {
      let childPid: number | undefined
      const result = await runner.run({
        command: NODE,
        args: nodeArgs(
          `const { spawn } = require('node:child_process');
           const fs = require('node:fs');
           const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
           fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
           setInterval(() => {}, 1000);`,
        ),
        timeoutMs: 300,
        onSpawn: (pid) => {
          childPid = pid
        },
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('COMMAND_TIMEOUT')
      expect(childPid).toBeDefined()
      const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
      expect(Number.isInteger(grandchildPid)).toBe(true)

      // Assert both PIDs are actually gone (SIGKILL is synchronous for the
      // group signal, but reaping is not — poll briefly).
      expect(await eventually(() => !pidAlive(childPid as number))).toBe(true)
      expect(await eventually(() => !pidAlive(grandchildPid))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  it('aborts via AbortSignal and kills the child', async () => {
    const controller = new AbortController()
    let childPid: number | undefined
    const pending = runner.run({
      command: NODE,
      args: nodeArgs('setInterval(() => {}, 1000)'),
      timeoutMs: 30_000,
      signal: controller.signal,
      onSpawn: (pid) => {
        childPid = pid
      },
    })
    await eventually(() => childPid !== undefined)
    controller.abort()

    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('aborted')
    expect(await eventually(() => !pidAlive(childPid as number))).toBe(true)
  })

  it('refuses to spawn when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let spawned = false
    const result = await runner.run({
      command: NODE,
      args: nodeArgs('process.exit(0)'),
      timeoutMs: 1000,
      signal: controller.signal,
      onSpawn: () => {
        spawned = true
      },
    })
    expect(result.ok).toBe(false)
    expect(spawned).toBe(false)
  })

  it('decodes utf16le output (wsl.exe --list --quiet shape)', async () => {
    // Node writes the UTF-16LE bytes wsl.exe would emit.
    const result = await run(
      runner,
      'process.stdout.write(Buffer.from("Ubuntu-24.04\\r\\ndocker-desktop\\r\\n", "utf16le"))',
      { encoding: 'utf16le' as const },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.stdout).toBe('Ubuntu-24.04\r\ndocker-desktop\r\n')
  })

  it('kills the command when stdout exceeds maxBuffer', async () => {
    let childPid: number | undefined
    const result = await runner.run({
      command: NODE,
      args: nodeArgs('for (;;) process.stdout.write("x".repeat(4096))'),
      timeoutMs: 30_000,
      maxBuffer: 16 * 1024,
      onSpawn: (pid) => {
        childPid = pid
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('output limit')
    expect(await eventually(() => !pidAlive(childPid as number))).toBe(true)
  })

  it('kills the process tree exactly once when chunks keep arriving after the overflow (P2-6)', async () => {
    // The overflow path settles on the first over-limit chunk, but the child
    // keeps producing output until the kill lands — every trailing chunk
    // re-enters the terminate path and must NOT spawn another taskkill.
    const killCalls: number[] = []
    const spyingRunner = createCommandRunner({
      killTree: (child) => {
        killCalls.push(child.pid as number)
        // Not killing on purpose: the script below exits by itself, and the
        // trailing chunks are what exercise the repeat-terminate path.
      },
    })
    const result = await spyingRunner.run({
      command: NODE,
      args: nodeArgs('for (let i = 0; i < 64; i++) process.stdout.write("x".repeat(4096))'),
      timeoutMs: 30_000,
      maxBuffer: 16 * 1024,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('output limit')
    // Let the child run to completion so every trailing chunk has fired.
    await new Promise((r) => setTimeout(r, 500))
    expect(killCalls).toHaveLength(1)
  })

  it('applies maxBuffer per stream, not to the combined stdout+stderr volume', async () => {
    // 5 MiB per stream, 8 MiB ceiling: each stream fits, so the command must
    // complete even though the combined 10 MiB exceeds the ceiling. The
    // timeout stays generous — loaded Windows runners drain pipes slowly.
    const fiveMiB = 5 * 1024 * 1024
    const result = await runner.run({
      command: NODE,
      args: nodeArgs(
        `process.stdout.write("x".repeat(${String(fiveMiB)}));
         process.stderr.write("y".repeat(${String(fiveMiB)}));`,
      ),
      timeoutMs: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.stdout).toHaveLength(fiveMiB)
    expect(result.data.stderr).toHaveLength(fiveMiB)
    expect(result.data.exitCode).toBe(0)
  })

  it('returns a structured error when the executable does not exist', async () => {
    const result = await runner.run({
      command: 'teskra-no-such-binary-anywhere',
      timeoutMs: 1000,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN')
  })

  it('rejects non-positive timeoutMs without spawning', async () => {
    const result = await runner.run({ command: NODE, timeoutMs: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('wraps commands through the injected WorkspaceRuntime', async () => {
    // A stub runtime standing in for WslRuntime.resolveCommand: it proves the
    // runner executes the runtime's executable/args/cwd, not the raw command.
    const wrapped: WorkspaceRuntime = {
      ref: { kind: 'wsl', distro: 'stub' },
      hostNative: false,
      resolveCommand: (command, args = [], cwd) => ({
        executable: NODE,
        args: nodeArgs(
          `process.stdout.write(${JSON.stringify('wrapped:' + command + ':' + (args[0] ?? ''))})`,
        ),
        ...(cwd !== undefined ? { cwd } : {}),
      }),
      resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: ['-l'] } }),
      resolveCwd: (p) => p,
      resolveHostPath: (p) => ({ ok: true, data: p }),
      resolveDataRoot: () => '/unused',
      resolveAgentProfilesRoot: () => '/unused/agent-profiles',
      resolveAgentProfileHome: (agentId, slug) => ({
        ok: true,
        data: `/unused/agent-profiles/${agentId}/${slug}`,
      }),

      validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: false } }),
    }
    const result = await runner.run({
      command: 'git',
      args: ['status'],
      timeoutMs: 5000,
      runtime: wrapped,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.stdout).toBe('wrapped:git:status')
  })
})

describe('decodeCommandOutput', () => {
  it('decodes utf16le fixture buffers', () => {
    const buffer = Buffer.from('WSL 版本: 2.4.11.0\r\n', 'utf16le')
    expect(decodeCommandOutput([buffer], 'utf16le')).toBe('WSL 版本: 2.4.11.0\r\n')
  })
})

describe('CommandRunner Windows .cmd shim support', () => {
  interface SpawnCall {
    file: string
    args: string[]
    options: Record<string, unknown>
  }

  /** A spawn seam that records the call and immediately closes with exit 0. */
  function recordingSpawn(): {
    spawn: NonNullable<CommandRunnerDeps['spawn']>
    calls: SpawnCall[]
  } {
    const calls: SpawnCall[] = []
    const spawn = ((file: string, args: string[], options: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        stdout: EventEmitter
        stderr: EventEmitter
      }
      child.pid = 7777
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      calls.push({ file, args: [...args], options })
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    }) as NonNullable<CommandRunnerDeps['spawn']>
    return { spawn, calls }
  }

  it('launches a .cmd shim through cmd.exe with verbatim arguments', async () => {
    const backend = recordingSpawn()
    const runner = createCommandRunner({ hostPlatform: 'win32', spawn: backend.spawn })

    const result = await runner.run({
      command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['exec', 'fix the bug'],
      timeoutMs: 1000,
    })

    expect(result).toEqual({ ok: true, data: { stdout: '', stderr: '', exitCode: 0 } })
    expect(backend.calls).toHaveLength(1)
    const call = backend.calls[0]!
    expect(call.file.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(call.args).toEqual([
      '/d',
      '/s',
      '/c',
      'call',
      '"C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd"',
      'exec',
      '"fix the bug"',
    ])
    expect(call.options).toMatchObject({ windowsVerbatimArguments: true, detached: false })
  })

  it('unwraps a .cmd shim into a direct node launch for multi-line args', async () => {
    // Regression: cmd ends the batch command at the first line break, so a
    // multi-line argument through a shim arrived truncated to its first
    // line. The shim's real target (node + entry .js) is spawned directly.
    const NPM_SHIM = [
      '@ECHO off',
      'SET dp0=%~dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      '',
    ].join('\r\n')
    const ENTRY = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    const NODE = 'C:\\Nodejs\\node.exe'
    vi.stubEnv('PATH', 'C:\\Nodejs')
    const backend = recordingSpawn()
    const runner = createCommandRunner({
      hostPlatform: 'win32',
      spawn: backend.spawn,
      shimIO: { read: () => NPM_SHIM, exists: (path) => path === ENTRY || path === NODE },
    })

    const result = await runner.run({
      command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['exec', '# Implement the Task\n\n用c++开发一个数学计算器'],
      timeoutMs: 1000,
    })
    vi.unstubAllEnvs()

    expect(result.ok).toBe(true)
    expect(backend.calls).toHaveLength(1)
    const call = backend.calls[0]!
    expect(call.file).toBe(NODE)
    expect(call.args).toEqual([ENTRY, 'exec', '# Implement the Task\n\n用c++开发一个数学计算器'])
    expect(call.options).not.toHaveProperty('windowsVerbatimArguments')
  })

  it('falls back to the cmd.exe shape when a shim needing direct launch cannot be unwrapped', async () => {
    const backend = recordingSpawn()
    const runner = createCommandRunner({
      hostPlatform: 'win32',
      spawn: backend.spawn,
      shimIO: { read: () => undefined, exists: () => false },
    })

    await runner.run({
      command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['exec', 'line1\nline2'],
      timeoutMs: 1000,
    })

    expect(backend.calls[0]!.file.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(backend.calls[0]!.options).toHaveProperty('windowsVerbatimArguments', true)
  })

  it('resolves a bare command name through PATH and launches the .cmd shim', async () => {
    // Shell workflow steps run e.g. `npm test`: on Windows `npm` only exists
    // as npm.cmd, and spawning the bare name fails outright (EINVAL). The
    // runner must resolve it via PATH+PATHEXT, then the shim path applies.
    const NPM_CMD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\npm.cmd'
    vi.stubEnv('PATH', 'C:\\Users\\u\\AppData\\Roaming\\npm')
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD')
    const backend = recordingSpawn()
    const runner = createCommandRunner({
      hostPlatform: 'win32',
      spawn: backend.spawn,
      shimIO: { read: () => undefined, exists: (path) => path === NPM_CMD },
    })

    const result = await runner.run({ command: 'npm', args: ['test'], timeoutMs: 1000 })
    vi.unstubAllEnvs()

    expect(result.ok).toBe(true)
    const call = backend.calls[0]!
    expect(call.file.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(call.args).toEqual(['/d', '/s', '/c', 'call', `"${NPM_CMD}"`, 'test'])
  })

  it('does not wrap non-shim executables on win32', async () => {
    const backend = recordingSpawn()
    const runner = createCommandRunner({ hostPlatform: 'win32', spawn: backend.spawn })

    await runner.run({ command: 'C:\\Tools\\codex.exe', args: ['--version'], timeoutMs: 1000 })

    expect(backend.calls[0]).toMatchObject({
      file: 'C:\\Tools\\codex.exe',
      args: ['--version'],
    })
    expect(backend.calls[0]!.options).not.toHaveProperty('windowsVerbatimArguments')
  })

  it('does not wrap .cmd paths on POSIX hosts', async () => {
    const backend = recordingSpawn()
    const runner = createCommandRunner({ hostPlatform: 'linux', spawn: backend.spawn })

    await runner.run({ command: '/opt/codex.cmd', args: ['--version'], timeoutMs: 1000 })

    expect(backend.calls[0]).toMatchObject({ file: '/opt/codex.cmd', args: ['--version'] })
  })

  it.skipIf(process.platform !== 'win32')(
    'really executes a .cmd shim end-to-end on Windows',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'teskra-shim-'))
      try {
        const shim = join(dir, 'fake agent.cmd')
        writeFileSync(shim, '@echo off\r\necho shim-ok %1\r\n', 'utf8')
        const runner = createCommandRunner({ hostPlatform: 'win32' })

        const result = await runner.run({ command: shim, args: ['hello'], timeoutMs: 5000 })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.data.exitCode).toBe(0)
        expect(result.data.stdout).toContain('shim-ok hello')
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    },
  )
})
