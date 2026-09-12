import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createCriteriaRepository, type CriteriaRepository } from './criteria-repository'

let connection: Database.Database
let repo: CriteriaRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'T', 'ready', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  repo = createCriteriaRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('CriteriaRepository', () => {
  it('creates versioned sets and resolves the latest one', () => {
    setup()
    const v1 = repo.createSet({ id: 'cs-1', taskId: 'task-1', version: 1 })
    expect(v1.ok && v1.data.status).toBe('draft')
    if (v1.ok) {
      expect(v1.data.createdAt).toMatch(ISO_UTC_PATTERN)
    }
    repo.createSet({ id: 'cs-2', taskId: 'task-1', version: 2 })

    const latest = repo.getLatestSet('task-1')
    expect(latest.ok && latest.data?.id).toBe('cs-2')

    const list = repo.listSetsByTask('task-1')
    expect(list.ok && list.data.map((set) => set.id)).toEqual(['cs-2', 'cs-1'])
  })

  it('confirms and supersedes sets', () => {
    setup()
    repo.createSet({ id: 'cs-1', taskId: 'task-1', version: 1 })
    const confirmed = repo.confirmSet('cs-1', '2026-09-09T12:00:00.000Z')
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.data?.status).toBe('confirmed')
    expect(confirmed.data?.confirmedAt).toBe('2026-09-09T12:00:00.000Z')

    const superseded = repo.supersedeSet('cs-1')
    expect(superseded.ok && superseded.data?.status).toBe('superseded')
  })

  it('adds criteria ordered by ordinal and maps required to boolean', () => {
    setup()
    repo.createSet({ id: 'cs-1', taskId: 'task-1', version: 1 })
    repo.addCriterion({
      id: 'c-2',
      criteriaSetId: 'cs-1',
      ordinal: 2,
      description: 'Tests pass',
      category: 'test',
      required: false,
    })
    repo.addCriterion({
      id: 'c-1',
      criteriaSetId: 'cs-1',
      ordinal: 1,
      description: 'Schema matches',
      category: 'functional',
    })

    const criteria = repo.listCriteria('cs-1')
    expect(criteria.ok).toBe(true)
    if (!criteria.ok) return
    expect(criteria.data.map((c) => c.id)).toEqual(['c-1', 'c-2'])
    expect(criteria.data[0]?.required).toBe(true)
    expect(criteria.data[1]?.required).toBe(false)
  })

  it('updates and deletes criteria', () => {
    setup()
    repo.createSet({ id: 'cs-1', taskId: 'task-1', version: 1 })
    repo.addCriterion({ id: 'c-1', criteriaSetId: 'cs-1', ordinal: 1, description: 'x' })
    const updated = repo.updateCriterion('c-1', { description: 'y', required: false })
    expect(updated.ok && updated.data?.description).toBe('y')
    expect(repo.deleteCriterion('c-1')).toEqual({ ok: true, data: true })
    expect(repo.getCriterionById('c-1')).toEqual({ ok: true, data: null })
  })

  it('rejects a stored category outside the §139.1 list', () => {
    setup()
    repo.createSet({ id: 'cs-1', taskId: 'task-1', version: 1 })
    repo.addCriterion({ id: 'c-1', criteriaSetId: 'cs-1', ordinal: 1, description: 'x' })
    connection
      .prepare('UPDATE acceptance_criteria SET category = ? WHERE id = ?')
      .run('vibes', 'c-1')

    const result = repo.getCriterionById('c-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})
