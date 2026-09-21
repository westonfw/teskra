import Database from 'better-sqlite3'

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentRun,
  IpcResult,
  StartAgentRunRequest,
  WorkflowDefinition,
  WorkflowStep,
  WorkbenchEvents,
} from '@teskra/contracts'

import {
  createAccountProfileRepository,
  createExecutionProfileRepository,
  createProfileAliasRepository,
  createWorkflowRunRepository,
} from '../db/repositories'
import { migrateDatabase } from '../db/migrations'
import { createProfileAliasManager } from '../agents/profile-alias-manager'
import { createEventBus } from '../events/event-bus'
import { initializeLogging, resetLoggingStateForTests } from '../logger'
import { createTeskraPaths } from '../paths'
import { createWorkflowEngine, type WorkflowExecutionContext } from './workflow-engine'
import { createWorkflowRunStore } from './workflow-run-store'

/**
 * TASK-111 end-to-end: a repo workflow agent node names profile ALIASES
 * (§53.1); the engine resolves them through ProfileAliasManager and hands the
 * machine-local ids to AgentManager.start. Every failure mode is fail-closed:
 * the step fails and AgentManager is never invoked.
 */

const AT = '2026-09-14T08:00:00.000Z'
const CONTEXT: WorkflowExecutionContext = { workspaceId: 'ws-1' }

const openConnections: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

interface CapturedStart {
  readonly requests: StartAgentRunRequest[]
}

function setup(definition: WorkflowDefinition, options?: { withResolver?: boolean }) {
  const connection = new Database(':memory:')
  openConnections.push(connection)
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)

  const accountProfiles = createAccountProfileRepository(connection)
  const executionProfiles = createExecutionProfileRepository(connection)
  const aliases = createProfileAliasRepository(connection)
  const aliasManager = createProfileAliasManager({
    aliases,
    accountProfiles,
    executionProfiles,
    reservedEnvKeys: () => ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'],
    now: () => AT,
  })

  const store = createWorkflowRunStore({
    workflowRuns: createWorkflowRunRepository(connection),
  })
  const events = createEventBus<WorkbenchEvents>()
  const captured: CapturedStart = { requests: [] }
  const agentManager = {
    start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>> {
      captured.requests.push(request)
      const run = { id: `agent-run-${String(captured.requests.length)}` } as AgentRun
      // Settle the step once the executor's subscriptions are in place: the
      // engine awaits start() before subscribing, so a microtask would fire
      // too early — a macrotask lands after the subscription continuation.
      setTimeout(() => {
        events.emit('agent.completed', { runId: run.id, exitCode: 0 })
      }, 0)
      return Promise.resolve({ ok: true, data: run })
    },
    cancel(): Promise<IpcResult<AgentRun>> {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN', message: 'n/a', retryable: false },
      })
    },
  }
  const engine = createWorkflowEngine({
    runs: store,
    events,
    agentManager,
    ...(options?.withResolver === false ? {} : { profileAliases: aliasManager }),
  })

  const created = store.createRun({ definition })
  if (!created.ok) throw new Error(created.error.message)

  return {
    engine,
    connection,
    accountProfiles,
    executionProfiles,
    aliasManager,
    captured,
    run: created.data.run,
    stepByNode(nodeId: string): WorkflowStep {
      const detail = store.getRun(created.data.run.id)
      if (!detail.ok || detail.data === null) throw new Error('run vanished')
      const step = detail.data.steps.find((candidate) => candidate.nodeId === nodeId)
      if (step === undefined) throw new Error(`no step for node "${nodeId}"`)
      return step
    },
  }
}

function insertAccountProfile(
  s: ReturnType<typeof setup>,
  id: string,
  agentId = 'codex',
  enabled = true,
): void {
  const created = s.accountProfiles.create(
    {
      id,
      agentId,
      name: `Account ${id}`,
      authType: 'subscription',
      runtime: { kind: 'windows' },
      enabled,
    },
    AT,
  )
  if (!created.ok) throw new Error(created.error.message)
}

function insertExecutionProfile(
  s: ReturnType<typeof setup>,
  id: string,
  agentId = 'codex',
  accountProfileId?: string,
): void {
  const created = s.executionProfiles.create(
    {
      id,
      name: `Execution ${id}`,
      agentId,
      ...(accountProfileId === undefined ? {} : { accountProfileId }),
      model: 'gpt-5-codex',
    },
    AT,
  )
  if (!created.ok) throw new Error(created.error.message)
}

describe('WorkflowEngine profile aliases (TASK-111)', () => {
  it('resolves an accountProfile alias and starts the agent with the resolved accountProfileId', async () => {
    const definition: WorkflowDefinition = {
      id: 'alias-workflow',
      steps: [
        { id: 'impl', type: 'agent', agent: 'codex', accountProfile: 'work', runOn: 'always' },
      ],
    }
    const s = setup(definition)
    insertAccountProfile(s, 'acct_codex_work')
    const bound = s.aliasManager.bind({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct_codex_work',
    })
    expect(bound.ok).toBe(true)

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(true)
    expect(s.stepByNode('impl').status).toBe('completed')
    expect(s.captured.requests).toHaveLength(1)
    expect(s.captured.requests[0]).toMatchObject({
      agentType: 'codex',
      accountProfileId: 'acct_codex_work',
    })
    expect(s.captured.requests[0]?.executionProfileId).toBeUndefined()
  })

  it('§54: node.accountProfile wins for the account dimension while the execution profile applies whole', async () => {
    const definition: WorkflowDefinition = {
      id: 'priority-workflow',
      steps: [
        {
          id: 'impl',
          type: 'agent',
          agent: 'codex',
          accountProfile: 'work',
          profile: 'high-work',
          runOn: 'always',
        },
      ],
    }
    const s = setup(definition)
    insertAccountProfile(s, 'acct_explicit')
    insertAccountProfile(s, 'acct_from_exec')
    insertExecutionProfile(s, 'exec_high', 'codex', 'acct_from_exec')
    s.aliasManager.bind({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct_explicit',
    })
    s.aliasManager.bind({
      agentId: 'codex',
      kind: 'execution',
      alias: 'high-work',
      profileId: 'exec_high',
    })

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(true)
    // Both ids reach AgentManager.start; its §14 rule (explicit
    // accountProfileId overrides the execution profile's account) implements
    // the §54 account-dimension priority, while the execution profile's other
    // fields (model, …) still apply whole.
    expect(s.captured.requests[0]).toMatchObject({
      accountProfileId: 'acct_explicit',
      executionProfileId: 'exec_high',
    })
  })

  it('forwards a clean node env to the launch environment', async () => {
    const definition: WorkflowDefinition = {
      id: 'env-workflow',
      steps: [
        { id: 'impl', type: 'agent', agent: 'codex', env: { SAFE_VAR: '1' }, runOn: 'always' },
      ],
    }
    const s = setup(definition)

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(true)
    expect(s.captured.requests[0]?.environment).toEqual({ SAFE_VAR: '1' })
  })

  it('fails closed on an unbound alias at pass start — no fallback, no side effects, AgentManager never called (P2-11)', async () => {
    const definition: WorkflowDefinition = {
      id: 'unbound-workflow',
      steps: [
        { id: 'impl', type: 'agent', agent: 'codex', accountProfile: 'work', runOn: 'always' },
        { id: 'after', type: 'agent', agent: 'codex', dependsOn: ['impl'], runOn: 'always' },
      ],
    }
    const s = setup(definition)
    insertAccountProfile(s, 'acct_default')

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(false)
    if (pass.ok) return
    expect(pass.error.code).toBe('VALIDATION_FAILED')
    expect(pass.error.message).toContain('not bound')
    // The pass never began: no steps, no status change, no agent launch.
    expect(s.captured.requests).toHaveLength(0)
    const detail = s.connection.prepare('SELECT COUNT(*) AS n FROM workflow_steps').get() as {
      n: number
    }
    expect(detail.n).toBe(0)
  })

  it('prevalidates every node before scheduling — a later unbound node fails before the first node runs (P2-11)', async () => {
    const definition: WorkflowDefinition = {
      id: 'late-unbound-workflow',
      steps: [
        { id: 'first', type: 'agent', agent: 'codex', runOn: 'always' },
        {
          id: 'second',
          type: 'agent',
          agent: 'codex',
          accountProfile: 'work',
          dependsOn: ['first'],
          runOn: 'always',
        },
      ],
    }
    const s = setup(definition)

    const pass = s.engine.begin(s.run.id, CONTEXT)

    expect(pass.ok).toBe(false)
    if (pass.ok) return
    expect(pass.error.message).toContain('not bound')
    // The CLEAN first node never launched either — prevalidation precedes all
    // side effects, so a multi-node DAG cannot half-execute.
    expect(s.captured.requests).toHaveLength(0)
    const row = s.connection
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(s.run.id) as { status: string }
    expect(row.status).toBe('created')
  })

  it('rejects a repo workflow that names a Profile id instead of an alias (§55)', async () => {
    const definition: WorkflowDefinition = {
      id: 'id-workflow',
      steps: [
        {
          id: 'impl',
          type: 'agent',
          agent: 'codex',
          accountProfile: 'acct_codex_work',
          runOn: 'always',
        },
      ],
    }
    const s = setup(definition)
    insertAccountProfile(s, 'acct_codex_work')

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(false)
    if (pass.ok) return
    expect(pass.error.message).toContain('alias')
    expect(s.captured.requests).toHaveLength(0)
  })

  it('fails when the bound account profile was deleted', async () => {
    const definition: WorkflowDefinition = {
      id: 'deleted-workflow',
      steps: [
        { id: 'impl', type: 'agent', agent: 'codex', accountProfile: 'work', runOn: 'always' },
      ],
    }
    const s = setup(definition)
    insertAccountProfile(s, 'acct_codex_work')
    s.aliasManager.bind({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct_codex_work',
    })
    s.accountProfiles.delete('acct_codex_work')

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(false)
    if (pass.ok) return
    expect(pass.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
    expect(s.captured.requests).toHaveLength(0)
  })

  it('fails when the bound account profile is disabled', async () => {
    const definition: WorkflowDefinition = {
      id: 'disabled-workflow',
      steps: [
        { id: 'impl', type: 'agent', agent: 'codex', accountProfile: 'work', runOn: 'always' },
      ],
    }
    const s = setup(definition)
    insertAccountProfile(s, 'acct_codex_work', 'codex', false)
    s.aliasManager.bind({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct_codex_work',
    })

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(false)
    if (pass.ok) return
    expect(pass.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
    expect(s.captured.requests).toHaveLength(0)
  })

  it('rejects a node env carrying a reserved account-profile key — and logs it (§13.2)', async () => {
    // §13.2 "拒绝并记录": arm the agent log BEFORE setup so the
    // ProfileAliasManager's rejection leaves a WARN record (TASK-114).
    resetLoggingStateForTests()
    const logHome = mkdtempSync(join(tmpdir(), 'teskra-task114-wf-log-'))
    directories.push(logHome)
    const initialized = initializeLogging(createTeskraPaths({ TESKRA_HOME: logHome }), {
      sync: true,
    })
    if (!initialized.ok) throw new Error(initialized.error.message)
    const definition: WorkflowDefinition = {
      id: 'reserved-env-workflow',
      steps: [
        {
          id: 'impl',
          type: 'agent',
          agent: 'codex',
          env: { CODEX_HOME: '/attacker/.codex' },
          runOn: 'always',
        },
      ],
    }
    const s = setup(definition)

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(false)
    if (pass.ok) return
    expect(pass.error.message).toContain('CODEX_HOME')
    expect(s.captured.requests).toHaveLength(0)
    const logged = readFileSync(join(logHome, 'logs', 'agent.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['msg'] === 'Reserved account-profile env key rejected.')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ level: 40, source: 'workflow node "impl"' })
  })

  it('fails closed when the runtime has no alias resolver but a node declares aliases', async () => {
    const definition: WorkflowDefinition = {
      id: 'no-resolver-workflow',
      steps: [
        { id: 'impl', type: 'agent', agent: 'codex', accountProfile: 'work', runOn: 'always' },
      ],
    }
    const s = setup(definition, { withResolver: false })

    const pass = await s.engine.start(s.run.id, CONTEXT)

    expect(pass.ok).toBe(false)
    if (pass.ok) return
    expect(pass.error.message).toContain('profile alias resolution is not available')
    expect(s.captured.requests).toHaveLength(0)
  })
})
