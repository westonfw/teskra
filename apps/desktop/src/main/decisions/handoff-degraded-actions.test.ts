import Database from 'better-sqlite3'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { migrateDatabase } from '../db/migrations'
import { createEventBus } from '../events/event-bus'
import { createDecisionRepository } from './decision-repository'
import { createDecisionService, type DecisionService } from './decision-service'
import {
  createHandoffDegradedActions,
  type HandoffDegradedActions,
} from './handoff-degraded-actions'

/**
 * TASK-130 acceptance (teskra-tasks.md; design doc §9.2): resolving a
 * handoff_degraded decision with open_raw reveals the raw file's directory
 * through the injected shell adapter; dismiss is the no-op.
 */

const T0 = '2026-09-22T00:00:00.000Z'
const RAW_PATH = 'C:\\Users\\u\\.teskra\\runs\\run-1\\handoff.json'

let connection: Database.Database | undefined
let decisions: DecisionService
let actions: HandoffDegradedActions | undefined

function setup(options?: { withOpenPath?: boolean }) {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${T0}', '${T0}')`,
    )
    .run()
  decisions = createDecisionService({
    decisions: createDecisionRepository(connection),
    events: createEventBus(),
  })
  const openPath = vi.fn(async () => '')
  actions = createHandoffDegradedActions({
    decisions,
    openPath: options?.withOpenPath === false ? undefined : openPath,
  })
  return { openPath }
}

function openDegraded(): string {
  const opened = decisions.open(
    {
      workspaceId: 'ws-1',
      kind: 'handoff_degraded',
      severity: 'warning',
      dedupeKey: 'handoff_degraded:run-1',
      title: 'The Agent handoff failed validation',
      detail: { kind: 'handoff_degraded', rawPath: RAW_PATH },
      options: [
        { id: 'open_raw', label: 'Open raw file' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    },
    T0,
  )
  if (!opened.ok) throw new Error(opened.error.message)
  return opened.data.id
}

afterEach(() => {
  actions?.dispose()
  actions = undefined
  decisions.dispose()
  connection?.close()
  connection = undefined
})

describe('HandoffDegradedActions (TASK-130)', () => {
  it('open_raw opens the directory containing the preserved raw handoff', async () => {
    const { openPath } = setup()
    const id = openDegraded()

    const resolved = decisions.resolve(id, 'open_raw', 'user')
    expect(resolved.ok).toBe(true)
    await Promise.resolve()

    expect(openPath).toHaveBeenCalledWith('C:\\Users\\u\\.teskra\\runs\\run-1')
  })

  it('dismiss performs no action', async () => {
    const { openPath } = setup()
    const id = openDegraded()

    const resolved = decisions.resolve(id, 'dismiss', 'user')
    expect(resolved.ok).toBe(true)
    await Promise.resolve()

    expect(openPath).not.toHaveBeenCalled()
  })

  it('open_raw without a shell adapter neither throws nor closes differently', () => {
    setup({ withOpenPath: false })
    const id = openDegraded()

    const resolved = decisions.resolve(id, 'open_raw', 'user')

    expect(resolved.ok).toBe(true)
    expect(resolved.ok && resolved.data.status === 'resolved').toBe(true)
  })
})
