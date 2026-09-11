import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

import { CLAUDE_AGENT } from '../agents/definitions/claude'
import { CODEX_AGENT } from '../agents/definitions/codex'
import { FAKE_AGENT } from '../agents/definitions/fake'
import { createAgentRegistry } from '../agents/agent-registry'
import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createPermissionRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import {
  createPermissionManager,
  matchCommandPattern,
  type PermissionManager,
} from './permission-manager'

const AT = '2026-09-09T00:00:00.000Z'

interface TestContext {
  readonly connection: Database.Database
  readonly events: EventBus<WorkbenchEvents>
  readonly manager: PermissionManager
  readonly home: string
}

const contexts: TestContext[] = []

afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.manager.dispose()
    context.connection.close()
    rmSync(context.home, { recursive: true, force: true })
  }
})

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function setup(): TestContext {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${AT}', '${AT}'),
              ('ws-2', 'WS2', 'windows', 'C:\\dev\\ws2', '${AT}', '${AT}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'codex', 'running', 'attended', 'runs/run-1', '${AT}', '${AT}'),
              ('run-2', 'ws-2', 'claude', 'running', 'attended', 'runs/run-2', '${AT}', '${AT}')`,
    )
    .run()
  const registered = createAgentRegistry([CODEX_AGENT, CLAUDE_AGENT, FAKE_AGENT])
  if (!registered.ok) throw new Error(registered.error.message)
  const events = createEventBus<WorkbenchEvents>()
  let ruleCounter = 0
  const manager = createPermissionManager({
    permissions: createPermissionRepository(connection),
    runs: createAgentRunRepository(connection),
    registry: registered.data,
    events,
    now: () => AT,
    createRuleId: () => `rule-${++ruleCounter}`,
  })
  const home = mkdtempSync(join(tmpdir(), 'teskra-permissions-'))
  const context: TestContext = { connection, events, manager, home }
  contexts.push(context)
  return context
}

function emitOutput(context: TestContext, runId: string, data: string): void {
  context.events.emit('agent.output', { runId, data })
}

describe('matchCommandPattern', () => {
  it('matches exact, prefix-subcommand, and trailing-star patterns', () => {
    expect(matchCommandPattern('git push', 'git push')).toBe(true)
    expect(matchCommandPattern('git push', 'git push origin main')).toBe(true)
    expect(matchCommandPattern('git push', 'git pushup')).toBe(false)
    expect(matchCommandPattern('docker *', 'docker system prune')).toBe(true)
    expect(matchCommandPattern('*', 'anything at all')).toBe(true)
    expect(matchCommandPattern('rm', 'rm -rf build')).toBe(true)
    expect(matchCommandPattern('', 'ls')).toBe(false)
  })
})

describe('PermissionManager rule CRUD (TASK-065)', () => {
  it('creates, lists, updates, and deletes rules (global + workspace scoped)', () => {
    const { manager } = setup()
    const global = manager.createRule({
      commandPattern: 'sudo *',
      action: 'deny',
      scope: 'persistent',
    })
    expect(global.ok).toBe(true)
    const scoped = manager.createRule({
      commandPattern: 'git push',
      action: 'audit',
      scope: 'session',
      workspaceId: 'ws-1',
      agentType: 'codex',
    })
    expect(scoped.ok).toBe(true)

    expect(unwrap(manager.listRules()).map((rule) => rule.commandPattern)).toEqual(['sudo *'])
    expect(unwrap(manager.listRules({ workspaceId: 'ws-1' }))).toHaveLength(2)

    if (!scoped.ok) return
    const updated = manager.updateRule({ ruleId: scoped.data.id, action: 'deny' })
    expect(updated.ok && updated.data?.action).toBe('deny')
    expect(manager.deleteRule({ ruleId: scoped.data.id })).toEqual({ ok: true, data: true })
    expect(unwrap(manager.listRules({ workspaceId: 'ws-1' }))).toHaveLength(1)
  })

  it('rejects rules for unregistered Agents', () => {
    const { manager } = setup()
    const created = manager.createRule({
      commandPattern: 'x',
      action: 'allow',
      scope: 'once',
      agentType: 'ghost',
    })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('PermissionManager.resolveProfile (TASK-065)', () => {
  it('merges global ← workspace ← agent rules with deny priority and dedupe', () => {
    const { manager } = setup()
    manager.createRule({ commandPattern: 'Bash(git status)', action: 'allow', scope: 'persistent' })
    manager.createRule({ commandPattern: 'Bash(git push *)', action: 'allow', scope: 'persistent' })
    manager.createRule({
      commandPattern: 'Bash(git push *)',
      action: 'deny',
      scope: 'persistent',
      workspaceId: 'ws-1',
    })
    manager.createRule({
      commandPattern: 'Bash(npm test)',
      action: 'allow',
      scope: 'persistent',
      workspaceId: 'ws-1',
      agentType: 'claude',
    })
    manager.createRule({
      commandPattern: 'Bash(echo hi)',
      action: 'allow',
      scope: 'persistent',
      workspaceId: 'ws-2',
    })

    const resolved = manager.resolveProfile({ agentType: 'claude', workspaceId: 'ws-1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.profile.allow).toEqual(['Bash(git status)', 'Bash(npm test)'])
    expect(resolved.data.profile.deny).toEqual(['Bash(git push *)'])
    expect(resolved.data.profile.approvalMode).toBe('manual')
    expect(resolved.data.notices).toEqual([])
  })

  it('ask stays native-handled on native Agents and degrades to audit-only elsewhere', () => {
    const { manager } = setup()
    manager.createRule({ commandPattern: 'Bash(rm *)', action: 'ask', scope: 'persistent' })

    const native = manager.resolveProfile({ agentType: 'claude' })
    expect(native.ok).toBe(true)
    if (!native.ok) return
    expect(native.data.notices).toHaveLength(1)
    expect(native.data.notices[0]?.reason).toContain('own approval prompt')
    expect(native.data.profile.allow).toEqual([])
    expect(native.data.profile.deny).toEqual([])

    for (const agentType of ['codex', 'fake']) {
      const degraded = manager.resolveProfile({ agentType })
      expect(degraded.ok).toBe(true)
      if (!degraded.ok) continue
      expect(degraded.data.notices).toHaveLength(1)
      expect(degraded.data.notices[0]?.action).toBe('ask')
      expect(degraded.data.notices[0]?.reason).toContain('audit-only')
      // The downgrade never smuggles the pattern into an enforcement list.
      expect(degraded.data.profile.allow).toEqual([])
      expect(degraded.data.profile.deny).toEqual([])
    }
  })
})

describe('PermissionManager decisions (TASK-065)', () => {
  it('persists always-allow / deny as rules consumed by the next resolution', () => {
    const { manager } = setup()
    manager.createRule({
      commandPattern: 'Bash(make deploy)',
      action: 'allow',
      scope: 'persistent',
    })
    const denied = manager.recordDecision({
      agentType: 'claude',
      commandPattern: 'Bash(make deploy)',
      decision: 'deny',
      workspaceId: 'ws-1',
    })
    expect(denied.ok && denied.data.persistedAs).toBe('rule')
    const resolved = unwrap(manager.resolveProfile({ agentType: 'claude', workspaceId: 'ws-1' }))
    expect(resolved.profile.deny).toContain('Bash(make deploy)')
    // deny wins over the earlier allow.
    expect(resolved.profile.allow).not.toContain('Bash(make deploy)')

    const allowed = manager.recordDecision({
      agentType: 'codex',
      commandPattern: 'ls',
      decision: 'always-allow',
    })
    expect(allowed.ok && allowed.data.persistedAs).toBe('rule')
    expect(allowed.ok && allowed.data.rule?.action).toBe('allow')
  })

  it('session decisions merge until dispose; once decisions are consumed exactly once', () => {
    const { manager } = setup()
    manager.recordDecision({
      agentType: 'codex',
      commandPattern: 'npm test',
      decision: 'allow-session',
      workspaceId: 'ws-1',
    })
    manager.recordDecision({
      agentType: 'codex',
      commandPattern: 'npm run build',
      decision: 'allow-once',
      workspaceId: 'ws-1',
    })

    const first = unwrap(manager.resolveProfile({ agentType: 'codex', workspaceId: 'ws-1' }))
    expect(first.profile.allow).toEqual(['npm test', 'npm run build'])
    const second = unwrap(manager.resolveProfile({ agentType: 'codex', workspaceId: 'ws-1' }))
    expect(second.profile.allow).toEqual(['npm test'])
    // Session decisions are not persisted as rules.
    expect(unwrap(manager.listRules())).toEqual([])
  })

  it('emits permission.resolved when the decision carries a runId', () => {
    const { manager, events } = setup()
    const seen: string[] = []
    events.subscribe('permission.resolved', ({ command }) => seen.push(command))
    manager.recordDecision({
      agentType: 'claude',
      commandPattern: 'Bash(ls)',
      decision: 'always-allow',
      runId: 'run-2',
    })
    expect(seen).toEqual(['Bash(ls)'])
  })
})

describe('PermissionManager audit (TASK-065)', () => {
  it('records commands recognized in the output stream with run/command/risk/detectedAt', () => {
    const context = setup()
    emitOutput(context, 'run-1', 'rockye@dev:~/repo$ rm -rf build\r\n')
    const list = unwrap(context.manager.listAudit({ runId: 'run-1' }))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      runId: 'run-1',
      command: 'rm -rf build',
      riskLevel: 'DESTRUCTIVE',
      detectedAt: AT,
    })
  })

  it('never invents commands from prose (宁缺勿假) and dedupes repeats', () => {
    const context = setup()
    emitOutput(context, 'run-1', 'The total is $ 500.\nRun `git push` to publish.\n')
    emitOutput(context, 'run-1', '$ git status\n$ git status\n')
    const list = unwrap(context.manager.listAudit({ runId: 'run-1' }))
    expect(list.map((entry) => entry.command)).toEqual(['git status'])
    expect(list[0]?.riskLevel).toBe('READ_ONLY')
  })

  it('links the most specific matching rule and emits permission.audit_recorded', () => {
    const context = setup()
    context.manager.createRule({ commandPattern: 'git push', action: 'audit', scope: 'session' })
    const specific = context.manager.createRule({
      commandPattern: 'git push',
      action: 'deny',
      scope: 'persistent',
      workspaceId: 'ws-1',
      agentType: 'codex',
    })
    const emitted: string[] = []
    context.events.subscribe('permission.audit_recorded', ({ riskLevel }) => {
      emitted.push(riskLevel)
    })
    emitOutput(context, 'run-1', '$ git push origin main\n')
    const list = unwrap(context.manager.listAudit({ runId: 'run-1' }))
    expect(list).toHaveLength(1)
    expect(list[0]?.riskLevel).toBe('NETWORK_WRITE')
    // Specific (workspace+agent) rule wins over the global one.
    expect(specific.ok && list[0]?.matchedRuleId === specific.data.id).toBe(true)
    expect(emitted).toEqual(['NETWORK_WRITE'])
  })

  it('audit failures never throw back into the event stream', () => {
    const context = setup()
    // run-999 does not exist → FK violation on insert; must be swallowed.
    emitOutput(context, 'run-999', '$ rm -rf /\n')
    expect(unwrap(context.manager.listAudit())).toEqual([])
  })
})

describe('PermissionManager.prepareRunPermission (TASK-065 + TASK-077)', () => {
  it('projects resolved allow/deny into the Claude settings file', () => {
    const { manager, home } = setup()
    manager.createRule({
      commandPattern: 'Bash(npm test)',
      action: 'allow',
      scope: 'persistent',
      workspaceId: 'ws-1',
    })
    manager.createRule({ commandPattern: 'Bash(rm *)', action: 'deny', scope: 'persistent' })
    const runDir = join(home, 'run-a')
    const prepared = manager.prepareRunPermission({
      definition: CLAUDE_AGENT,
      workspaceId: 'ws-1',
      role: 'reviewer',
      approvalMode: 'manual',
      runDir,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok || prepared.data === undefined) return
    expect(prepared.data.configPath).toBeDefined()
    const document = JSON.parse(readFileSync(prepared.data.configPath as string, 'utf8')) as {
      permissions: { allow?: string[]; deny?: string[]; defaultMode: string }
    }
    expect(document.permissions.allow).toEqual(['Bash(npm test)'])
    expect(document.permissions.deny).toEqual(['Bash(rm *)'])
  })

  it('generates nothing for none-enforcement Agents', () => {
    const { manager, home } = setup()
    const runDir = join(home, 'run-b')
    const prepared = manager.prepareRunPermission({
      definition: FAKE_AGENT,
      workspaceId: 'ws-1',
      approvalMode: 'manual',
      runDir,
    })
    expect(prepared.ok && prepared.data).toBeUndefined()
    expect(existsSync(join(runDir, 'permission-settings.json'))).toBe(false)
  })
})

describe('PermissionRepository.listAudit filters (TASK-065)', () => {
  it('filters by run / workspace / risk level, newest first', () => {
    const context = setup()
    emitOutput(context, 'run-1', '$ rm -rf build\n$ git push\n')
    emitOutput(context, 'run-2', '$ git push\n')

    const byWorkspace = unwrap(context.manager.listAudit({ workspaceId: 'ws-1' }))
    expect(byWorkspace.map((entry) => entry.runId)).toEqual(['run-1', 'run-1'])
    const byRisk = unwrap(context.manager.listAudit({ riskLevel: 'NETWORK_WRITE' }))
    expect(byRisk.map((entry) => entry.runId)).toEqual(['run-2', 'run-1'])
    expect(unwrap(context.manager.listAudit({ workspaceId: 'ws-2', riskLevel: 'DESTRUCTIVE' }))).toEqual(
      [],
    )
  })
})
