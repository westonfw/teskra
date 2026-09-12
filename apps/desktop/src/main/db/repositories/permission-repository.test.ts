import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createPermissionRepository, type PermissionRepository } from './permission-repository'

let connection: Database.Database
let repo: PermissionRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  const at = '2026-09-09T00:00:00.000Z'
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${at}', '${at}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'codex', 'running', 'attended', 'runs/run-1', '${at}', '${at}')`,
    )
    .run()
  repo = createPermissionRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('PermissionRepository', () => {
  it('creates and reads back a rule', () => {
    setup()
    const created = repo.createRule({
      id: 'rule-1',
      workspaceId: 'ws-1',
      commandPattern: 'rm -rf *',
      riskLevel: 'DESTRUCTIVE',
      action: 'deny',
      scope: 'persistent',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getRuleById('rule-1')).toEqual(created)
    expect(repo.getRuleById('missing')).toEqual({ ok: true, data: null })
  })

  it('listApplicableRules matches global + workspace + agent wildcards', () => {
    setup()
    repo.createRule({ id: 'g-1', commandPattern: 'sudo *', action: 'ask', scope: 'persistent' })
    repo.createRule({
      id: 'w-1',
      workspaceId: 'ws-1',
      commandPattern: 'rm -rf *',
      action: 'deny',
      scope: 'persistent',
    })
    repo.createRule({
      id: 'wa-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      commandPattern: 'git push',
      action: 'audit',
      scope: 'persistent',
    })
    repo.createRule({
      id: 'other-ws',
      workspaceId: 'ws-2',
      commandPattern: '*',
      action: 'allow',
      scope: 'persistent',
    })

    const forCodex = repo.listApplicableRules('ws-1', 'codex')
    expect(forCodex.ok && forCodex.data.map((rule) => rule.id)).toEqual(['g-1', 'w-1', 'wa-1'])

    const forClaude = repo.listApplicableRules('ws-1', 'claude-code')
    expect(forClaude.ok && forClaude.data.map((rule) => rule.id)).toEqual(['g-1', 'w-1'])

    const globals = repo.listApplicableRules()
    expect(globals.ok && globals.data.map((rule) => rule.id)).toEqual(['g-1'])
  })

  it('listApplicableRules only returns persistent rules (P1-3: ephemeral grants never come from this table)', () => {
    setup()
    // Non-persistent rows can still exist (written before the P1-3 fix); they
    // must be inert rather than apply forever.
    repo.createRule({
      id: 'legacy-once',
      commandPattern: 'npm test',
      action: 'allow',
      scope: 'once',
    })
    repo.createRule({
      id: 'legacy-session',
      commandPattern: 'git push',
      action: 'allow',
      scope: 'session',
    })
    repo.createRule({
      id: 'current',
      commandPattern: 'npm run build',
      action: 'allow',
      scope: 'persistent',
    })

    const listed = repo.listApplicableRules('ws-1', 'codex')
    expect(listed.ok && listed.data.map((rule) => rule.id)).toEqual(['current'])
    // The legacy rows are still stored and readable by id — only their
    // applicability changed.
    expect(repo.getRuleById('legacy-once').ok).toBe(true)
  })

  it('updates and deletes rules', () => {
    setup()
    repo.createRule({ id: 'rule-1', commandPattern: 'docker *', action: 'ask', scope: 'once' })
    const updated = repo.updateRule('rule-1', { action: 'audit', scope: 'session' })
    expect(updated.ok && updated.data?.action).toBe('audit')
    expect(repo.deleteRule('rule-1')).toEqual({ ok: true, data: true })
  })

  it('records audit entries and lists them per run', () => {
    setup()
    const entry = repo.recordAudit({
      runId: 'run-1',
      command: 'rm -rf build',
      cwd: 'C:\\dev\\ws',
      riskLevel: 'DESTRUCTIVE',
      detectedAt: '2026-09-09T10:00:00.000Z',
    })
    expect(entry.ok).toBe(true)
    if (!entry.ok) return
    expect(entry.data.id).toBeGreaterThan(0)
    expect(entry.data.detectedAt).toBe('2026-09-09T10:00:00.000Z')
    expect(entry.data.createdAt).toMatch(ISO_UTC_PATTERN)

    const list = repo.listAuditByRun('run-1')
    expect(list.ok && list.data.length).toBe(1)
  })

  it('rejects a stored action outside the §139.1 enum', () => {
    setup()
    repo.createRule({ id: 'rule-1', commandPattern: 'x', action: 'ask', scope: 'once' })
    connection.prepare('UPDATE permission_rules SET action = ? WHERE id = ?').run('yolo', 'rule-1')

    const result = repo.getRuleById('rule-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})
