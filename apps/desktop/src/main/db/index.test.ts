import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createTeskraPaths } from '../paths'
import { openDatabase, openDatabaseFile, type TeskraDatabase } from './index'

// Tests must never touch the real ~/.teskra — every file-backed database
// lives under a mkdtemp TESKRA_HOME (see paths.test.ts for the convention).
const tempRoots: string[] = []
const openDatabases: TeskraDatabase[] = []

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teskra-db-test-'))
  tempRoots.push(dir)
  return dir
}

function open(paths: Parameters<typeof openDatabase>[0]): TeskraDatabase {
  const result = openDatabase(paths)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  openDatabases.push(result.data)
  return result.data
}

afterAll(() => {
  for (const db of openDatabases) {
    db.close()
  }
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

describe('openDatabase (TASK-005)', () => {
  it('opens the database at <TESKRA_HOME>/db/teskra.sqlite', () => {
    const home = makeTempHome()
    const db = open(createTeskraPaths({ TESKRA_HOME: home }))
    expect(db.filePath).toBe(join(home, 'db', 'teskra.sqlite'))
    expect(existsSync(db.filePath)).toBe(true)
  })

  it('applies the mandatory PRAGMA set on a file-backed database', () => {
    const home = makeTempHome()
    const db = open(createTeskraPaths({ TESKRA_HOME: home }))

    const foreignKeys = db.connection.pragma('foreign_keys', { simple: true })
    const journalMode = db.connection.pragma('journal_mode', { simple: true })
    const busyTimeout = db.connection.pragma('busy_timeout', { simple: true })

    expect(foreignKeys).toBe(1)
    expect(journalMode).toBe('wal')
    expect(busyTimeout).toBe(5000)
  })

  it('actually enforces foreign key constraints', () => {
    const home = makeTempHome()
    const db = open(createTeskraPaths({ TESKRA_HOME: home }))

    db.connection.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
    db.connection.exec(
      'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))',
    )
    expect(() => db.connection.prepare('INSERT INTO child (parent_id) VALUES (?)').run(999))
      .toThrow(/FOREIGN KEY/)
  })

  it('supports in-memory databases for tests', () => {
    const result = openDatabaseFile(':memory:')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    openDatabases.push(result.data)
    result.data.connection.exec('CREATE TABLE t (a INTEGER)')
    result.data.connection.prepare('INSERT INTO t VALUES (?)').run(1)
    expect(result.data.connection.prepare('SELECT a FROM t').get()).toEqual({ a: 1 })
  })

  it('closes cleanly and tolerates a second close', () => {
    const home = makeTempHome()
    const db = open(createTeskraPaths({ TESKRA_HOME: home }))
    expect(db.close()).toEqual({ ok: true, data: undefined })
    expect(db.close()).toEqual({ ok: true, data: undefined })
  })

  it('returns a structured error instead of throwing when the file cannot open', () => {
    // A directory path is never a valid SQLite file (SQLITE_CANTOPEN).
    const home = makeTempHome()
    const result = openDatabaseFile(home)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The public shape never carries detail / cause (TASK-003).
      expect(result.error).toEqual({
        code: 'UNKNOWN',
        message: 'Failed to open the Teskra database.',
        retryable: false,
      })
    }
  })
})
