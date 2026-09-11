import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { workerHandoffSchema } from '@teskra/contracts'
import { inspectRunWatchdog } from '@teskra/shared'

const fakeAgent = fileURLToPath(new URL('../../../../../tools/fake-agent.js', import.meta.url))
const temporaryDirectories: string[] = []

interface ScenarioResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

interface ScenarioOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly input?: string
  readonly killAfterMs?: number
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-fake-agent-'))
  temporaryDirectories.push(directory)
  return directory
}

function runScenario(name: string, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeAgent, '--scenario', name], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'pipe',
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
      })
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    if (options.killAfterMs !== undefined) {
      setTimeout(() => child.kill('SIGKILL'), options.killAfterMs)
    }
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

describe('Fake Agent scenarios (TASK-083)', () => {
  it('success emits progress, exits zero, and writes a valid WorkerHandoff', async () => {
    const directory = temporaryDirectory()
    const handoffPath = join(directory, 'handoff.json')
    const result = await runScenario('success', {
      cwd: directory,
      env: { TESKRA_HANDOFF_PATH: handoffPath, TESKRA_RUN_ID: 'run-success' },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Fake Agent completed')
    const handoff = workerHandoffSchema.safeParse(JSON.parse(readFileSync(handoffPath, 'utf8')))
    expect(handoff.success).toBe(true)
    if (handoff.success) expect(handoff.data.runId).toBe('run-success')
  })

  it('fail writes an error and exits non-zero', async () => {
    const result = await runScenario('fail')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('failed as requested')
  })

  it('hang remains alive until the host kills it', async () => {
    const result = await runScenario('hang', { killAfterMs: 150 })
    expect(result.exitCode).toBeNull()
    expect(result.signal).not.toBeNull()
    expect(result.stdout).toContain('hanging as requested')
    expect(
      inspectRunWatchdog(
        {
          status: 'running',
          createdAt: '2026-09-10T00:00:00.000Z',
          lastOutputAt: '2026-09-10T00:00:01.000Z',
        },
        Date.parse('2026-09-10T00:10:01.000Z'),
        600_000,
      ).possiblyStalled,
    ).toBe(true)
  })

  it('slow-output streams ten MiB before exiting', async () => {
    const prefix = 'Fake Agent high-volume output follows\n'
    const result = await runScenario('slow-output')
    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.stdout)).toBe(Buffer.byteLength(prefix) + 10 * 1024 * 1024)
  }, 15_000)

  it('needs-input waits for stdin and then continues', async () => {
    const result = await runScenario('needs-input', { input: 'continue\n' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('waiting for input')
    expect(result.stdout).toContain('received: continue')
  })

  it('dirty-worktree creates an uncommitted file in cwd', async () => {
    const directory = temporaryDirectory()
    const result = await runScenario('dirty-worktree', { cwd: directory })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(directory, 'fake-agent-dirty.txt'), 'utf8')).toContain('uncommitted')
  })

  it('bad-handoff exits zero but writes malformed JSON for degraded-path tests', async () => {
    const directory = temporaryDirectory()
    const handoffPath = join(directory, 'handoff.json')
    const result = await runScenario('bad-handoff', {
      env: { TESKRA_HANDOFF_PATH: handoffPath },
    })
    expect(result.exitCode).toBe(0)
    expect(() => JSON.parse(readFileSync(handoffPath, 'utf8'))).toThrow()
  })
})
