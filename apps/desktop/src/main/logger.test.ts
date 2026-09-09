import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { toPublicError } from './errors'
import {
  createScopeLogger,
  getLogDirectory,
  getLogger,
  initializeLogging,
  LOG_SCOPES,
  resetLoggingStateForTests,
} from './logger'
import { createTeskraPaths } from './paths'

// Tests must never write to the real ~/.teskra/logs — every logger here is
// bound to a temp TESKRA_HOME.
const tempRoots: string[] = []

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teskra-logging-test-'))
  tempRoots.push(dir)
  return dir
}

function readLogRecords(dir: string, scope: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, `${scope}.log`), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('logging (TASK-004)', () => {
  it('writes one file per scope with timestamp / level / scope fields', () => {
    const home = makeTempHome()
    const logsDir = join(home, 'logs')
    for (const scope of LOG_SCOPES) {
      createScopeLogger(scope, logsDir, { sync: true }).info('hello')
    }
    for (const scope of LOG_SCOPES) {
      const [record] = readLogRecords(logsDir, scope)
      expect(record).toBeDefined()
      expect(record?.['scope']).toBe(scope)
      expect(record?.['level']).toBe(30)
      expect(record?.['msg']).toBe('hello')
      expect(typeof record?.['time']).toBe('string')
    }
  })

  it('redacts secrets in log objects and messages before they reach disk', () => {
    const home = makeTempHome()
    const logsDir = join(home, 'logs')
    const logger = createScopeLogger('app', logsDir, { sync: true })

    logger.info(
      { env: { GITHUB_TOKEN: 'ghp_secretvalue123' }, note: 'using sk-livekey456' },
      'ran with ghp_embedded789',
    )

    const raw = readFileSync(join(logsDir, 'app.log'), 'utf8')
    expect(raw).not.toContain('ghp_secretvalue123')
    expect(raw).not.toContain('sk-livekey456')
    expect(raw).not.toContain('ghp_embedded789')
    const [record] = readLogRecords(logsDir, 'app')
    const env = (record?.['env'] ?? {}) as Record<string, unknown>
    expect(env['GITHUB_TOKEN']).toBe('[redacted]')
  })

  it('initializeLogging resolves the log directory through the paths module', () => {
    resetLoggingStateForTests()
    const home = makeTempHome()
    const result = initializeLogging(createTeskraPaths({ TESKRA_HOME: home }), { sync: true })
    expect(result).toEqual({ ok: true, data: join(home, 'logs') })
    expect(getLogDirectory()).toBe(join(home, 'logs'))

    getLogger('git').info('scoped write')
    const [record] = readLogRecords(join(home, 'logs'), 'git')
    expect(record?.['scope']).toBe('git')
  })

  it('initializeLogging returns the structured error when the log dir cannot be created', () => {
    resetLoggingStateForTests()
    const home = makeTempHome()
    const blocker = join(home, 'blocked')
    // A file where a directory must be created → mkdir fails deterministically.
    writeFileSync(blocker, 'not a directory')

    const result = initializeLogging(createTeskraPaths({ TESKRA_HOME: join(blocker, 'sub') }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN')
    }
    expect(getLogDirectory()).toBeUndefined()
  })

  it('wires toPublicError into the app log with correlationId, detail and cause', () => {
    resetLoggingStateForTests()
    const home = makeTempHome()
    initializeLogging(createTeskraPaths({ TESKRA_HOME: home }), { sync: true })

    toPublicError({
      code: 'COMMAND_TIMEOUT',
      message: 'The command timed out.',
      retryable: true,
      detail: 'stderr mentions ghp_leakedtoken000',
      cause: new Error('spawn failed'),
    })

    const [record] = readLogRecords(join(home, 'logs'), 'app')
    expect(record?.['msg']).toBe('The command timed out.')
    expect(record?.['code']).toBe('COMMAND_TIMEOUT')
    expect(record?.['correlationId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(record?.['detail']).not.toContain('ghp_leakedtoken000')
    expect(record?.['cause']).toMatchObject({ name: 'Error', message: 'spawn failed' })
  })
})
