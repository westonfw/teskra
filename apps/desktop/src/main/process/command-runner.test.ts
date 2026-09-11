import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../workspace/runtime'
import { createCommandRunner, decodeCommandOutput, type CommandRunner } from './command-runner'

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

  it('applies maxBuffer per stream, not to the combined stdout+stderr volume', async () => {
    // 5 MiB per stream, 8 MiB ceiling: each stream fits, so the command must
    // complete even though the combined 10 MiB exceeds the ceiling.
    const fiveMiB = 5 * 1024 * 1024
    const result = await runner.run({
      command: NODE,
      args: nodeArgs(
        `process.stdout.write("x".repeat(${String(fiveMiB)}));
         process.stderr.write("y".repeat(${String(fiveMiB)}));`,
      ),
      timeoutMs: 10_000,
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
