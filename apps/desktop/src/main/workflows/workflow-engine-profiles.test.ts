import Database from 'better-sqlite3'

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

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
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

  it('fails closed on an unbound alias — no fallback to a default account, AgentManager never called', async () => {
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

    expect(pass.ok).toBe(true)
    const step = s.stepByNode('impl')
    expect(step.status).toBe('failed')
    expect(step.result?.['errorCode']).toBe('VALIDATION_FAILED')
    expect(String(step.result?.['error'])).toContain('not bound')
    // Failure propagates: the dependent node skips, no agent ever launches.
    expect(s.stepByNode('after').status).toBe('skipped')
    expect(s.captured.requests).toHaveLength(0)
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

    expect(pass.ok).toBe(true)
    const step = s.stepByNode('impl')
    expect(step.status).toBe('failed')
    expect(String(step.result?.['error'])).toContain('alias')
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

    expect(pass.ok).toBe(true)
    expect(s.stepByNode('impl').status).toBe('failed')
    expect(s.stepByNode('impl').result?.['errorCode']).toBe('ACCOUNT_PROFILE_NOT_FOUND')
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

    expect(pass.ok).toBe(true)
    expect(s.stepByNode('impl').result?.['errorCode']).toBe('ACCOUNT_PROFILE_DISABLED')
    expect(s.captured.requests).toHaveLength(0)
  })

  it('rejects a node env carrying a reserved account-profile key (§13.2)', async () => {
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

    expect(pass.ok).toBe(true)
    const step = s.stepByNode('impl')
    expect(step.status).toBe('failed')
    expect(String(step.result?.['error'])).toContain('CODEX_HOME')
    expect(s.captured.requests).toHaveLength(0)
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

    expect(pass.ok).toBe(true)
    expect(s.stepByNode('impl').status).toBe('failed')
    expect(s.captured.requests).toHaveLength(0)
  })
})
