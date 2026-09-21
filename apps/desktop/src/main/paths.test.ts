import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createTeskraPaths } from './paths'

// Tests must never touch the real ~/.teskra — every test either passes an
// explicit TESKRA_HOME pointing at a temp dir, or only calls pure resolvers.
const tempRoots: string[] = []

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teskra-paths-test-'))
  tempRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

describe('createTeskraPaths (ADR-0003 / TASK-078)', () => {
  it('resolves home from TESKRA_HOME when set', () => {
    const dir = makeTempHome()
    const paths = createTeskraPaths({ TESKRA_HOME: dir })
    expect(paths.home()).toBe(dir)
    expect(paths.config()).toBe(join(dir, 'config.json'))
  })

  it('falls back to <os.homedir()>/.teskra without TESKRA_HOME (no I/O)', () => {
    const paths = createTeskraPaths({})
    expect(paths.home()).toBe(join(homedir(), '.teskra'))
    expect(paths.config()).toBe(join(homedir(), '.teskra', 'config.json'))
  })

  it('treats an empty TESKRA_HOME as unset', () => {
    const paths = createTeskraPaths({ TESKRA_HOME: '' })
    expect(paths.home()).toBe(join(homedir(), '.teskra'))
  })

  it('creates the db / logs / run directories on demand', () => {
    const dir = makeTempHome()
    const paths = createTeskraPaths({ TESKRA_HOME: dir })

    const db = paths.db()
    expect(db).toEqual({ ok: true, data: join(dir, 'db', 'teskra.sqlite') })
    expect(existsSync(join(dir, 'db'))).toBe(true)

    expect(paths.logs()).toEqual({ ok: true, data: join(dir, 'logs') })
    expect(existsSync(join(dir, 'logs'))).toBe(true)

    expect(paths.runDir('run-1')).toEqual({ ok: true, data: join(dir, 'runs', 'run-1') })
    expect(existsSync(join(dir, 'runs', 'run-1'))).toBe(true)
    expect(paths.runFiles('run-1')).toEqual({
      ok: true,
      data: {
        directory: join(dir, 'runs', 'run-1'),
        manifest: join(dir, 'runs', 'run-1', 'run.json'),
        events: join(dir, 'runs', 'run-1', 'events.jsonl'),
        terminal: join(dir, 'runs', 'run-1', 'terminal.log'),
        handoff: join(dir, 'runs', 'run-1', 'handoff.json'),
        diff: join(dir, 'runs', 'run-1', 'diff.patch'),
        artifacts: join(dir, 'runs', 'run-1', 'artifacts'),
        progress: join(dir, 'runs', 'run-1', 'progress.jsonl'),
      },
    })
    expect(existsSync(join(dir, 'runs', 'run-1', 'artifacts'))).toBe(true)
    // TASK-126: progress.jsonl joins the volatile log set (RetentionService GC).
    expect(paths.runLogFiles(join(dir, 'runs', 'run-1'))).toEqual({
      events: join(dir, 'runs', 'run-1', 'events.jsonl'),
      terminal: join(dir, 'runs', 'run-1', 'terminal.log'),
      progress: join(dir, 'runs', 'run-1', 'progress.jsonl'),
    })
  })

  it('returns a structured error when directory creation fails (ENOTDIR)', () => {
    const dir = makeTempHome()
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'not a directory')
    const paths = createTeskraPaths({ TESKRA_HOME: join(blocker, 'sub') })

    const result = paths.logs()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN')
      expect(result.error.retryable).toBe(false)
      // The public shape never carries detail / cause.
      expect(result.error).toEqual({
        code: 'UNKNOWN',
        message: 'Failed to create the Teskra data directory.',
        retryable: false,
      })
    }
  })

  // chmod-based read-only semantics are POSIX-only: on Windows a directory's
  // read-only attribute does not block creating entries inside it (ACLs would
  // be needed), so this scenario is covered by the Linux/macOS runs only.
  it.skipIf(process.platform === 'win32')(
    'returns a structured error when TESKRA_HOME is read-only',
    () => {
      if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
        // chmod-based permission checks are bypassed by root.
        return
      }
      const dir = makeTempHome()
      const readOnly = join(dir, 'read-only')
      mkdirSync(readOnly)
      chmodSync(readOnly, 0o444)
      try {
        const paths = createTeskraPaths({ TESKRA_HOME: join(readOnly, 'teskra') })
        const result = paths.logs()
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.code).toBe('UNKNOWN')
        }
      } finally {
        chmodSync(readOnly, 0o755)
      }
    },
  )

  it('rejects path-traversal segments with VALIDATION_FAILED', () => {
    const dir = makeTempHome()
    const paths = createTeskraPaths({ TESKRA_HOME: dir })

    for (const bad of ['..', '.', '', 'a/b', 'a\\b']) {
      const run = paths.runDir(bad)
      expect(run.ok).toBe(false)
      if (!run.ok) {
        expect(run.error.code).toBe('VALIDATION_FAILED')
      }
    }
    // Nothing was created for invalid segments.
    expect(existsSync(join(dir, 'runs'))).toBe(false)
  })

  it('builds every path with node:path joins (correct separators per platform)', () => {
    const dir = makeTempHome()
    const paths = createTeskraPaths({ TESKRA_HOME: dir })

    expect(paths.config()).toBe(join(dir, 'config.json'))
    expect(paths.repoConfig(join(dir, 'repo'))).toBe(join(dir, 'repo', '.teskra', 'config.json'))
    expect(paths.credentials()).toBe(join(dir, 'credentials.json'))
    expect(paths.repoPromptsDir(join(dir, 'repo'))).toBe(join(dir, 'repo', '.teskra', 'prompts'))
    expect(paths.repoWorkflowsDir(join(dir, 'repo'))).toBe(
      join(dir, 'repo', '.teskra', 'workflows'),
    )
    const run = paths.runDir('r')
    expect(run.ok && run.data).toBe(join(dir, 'runs', 'r'))
    // [Windows 验证] separator correctness on win32 is asserted structurally
    // here via node:path; on-device verification is pending.
  })

  it('resolves agent profile homes purely and creates them only on demand (§9.2)', () => {
    const dir = makeTempHome()
    const paths = createTeskraPaths({ TESKRA_HOME: dir })

    expect(paths.agentProfilesRoot()).toBe(join(dir, 'agent-profiles'))
    const resolved = paths.resolveAgentProfileHome('codex', 'work')
    expect(resolved).toEqual({
      ok: true,
      data: join(dir, 'agent-profiles', 'codex', 'work'),
    })
    // Pure resolution: nothing was created on disk.
    expect(existsSync(join(dir, 'agent-profiles'))).toBe(false)
    if (!resolved.ok) throw new Error('expected resolution to succeed')

    const created = paths.createAgentProfileHome(resolved.data)
    expect(created).toEqual({ ok: true, data: undefined })
    expect(existsSync(join(dir, 'agent-profiles', 'codex', 'work'))).toBe(true)
  })

  it('rejects invalid agentId / slug segments for profile homes', () => {
    const dir = makeTempHome()
    const paths = createTeskraPaths({ TESKRA_HOME: dir })

    for (const bad of ['..', '.', '', 'a/b', 'a\\b']) {
      expect(paths.resolveAgentProfileHome(bad, 'work').ok).toBe(false)
      expect(paths.resolveAgentProfileHome('codex', bad).ok).toBe(false)
    }
    const valid = paths.resolveAgentProfileHome('codex', 'work')
    expect(valid.ok).toBe(true)
  })

  it('refuses to create a home outside the agent-profiles root (P2-5 defense in depth)', () => {
    const dir = makeTempHome()
    const paths = createTeskraPaths({ TESKRA_HOME: dir })

    const outside = [join(dir, 'elsewhere'), join(dir, 'agent-profiles', '..', 'escape')]
    for (const bad of [...outside, paths.agentProfilesRoot(), 'relative/path']) {
      const result = paths.createAgentProfileHome(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_FAILED')
      }
    }
    // Nothing was created anywhere.
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false)
    expect(existsSync(paths.agentProfilesRoot())).toBe(false)
  })
})
