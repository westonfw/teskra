import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  Artifact,
  IpcResult,
  RecordArtifactRequest,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
} from '@teskra/contracts'

import type { ArtifactStore } from '../artifacts/artifact-store'
import { migrateDatabase } from '../db/migrations'
import { createWorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { createEventBus } from '../events/event-bus'
import {
  createCommandRunner,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from '../process/command-runner'
import type { RuntimeStatus, WorkspaceRuntime } from '../workspace/runtime'
import { createShellStepExecutor, shellArtifactType, splitCommandLine } from './shell-step-executor'
import {
  createWorkflowEngine,
  type WorkflowExecutionContext,
  type WorkflowStepExecution,
} from './workflow-engine'
import { createWorkflowRunStore } from './workflow-run-store'

/**
 * TASK-058 acceptance: shell steps run commands (dotnet test / npm test /
 * git status style) through CommandRunner with a timeout, the exit code
 * becomes the step result, and the output is recorded as an Artifact.
 */

/** Pass-through runtime: commands execute natively (mirrors the WSL-on-Linux dev path). */
const passthroughRuntime: WorkspaceRuntime = {
  ref: { kind: 'wsl' },
  hostNative: true,
  resolveCommand(command, args = [], cwd) {
    return { executable: command, args, ...(cwd === undefined ? {} : { cwd }) }
  },
  resolveTerminal() {
    throw new Error('unused')
  },
  resolveCwd(path) {
    return path
  },
  resolveHostPath(path) {
    return { ok: true, data: path }
  },
  resolveDataRoot() {
    return '/tmp'
  },
  resolveAgentProfilesRoot() {
    return '/tmp/agent-profiles'
  },
  resolveAgentProfileHome(agentId: string, slug: string) {
    return { ok: true as const, data: `/tmp/agent-profiles/${agentId}/${slug}` }
  },
  validate(): IpcResult<RuntimeStatus> {
    return { ok: true, data: { kind: 'wsl', hostNative: true } }
  },
}

const CONTEXT: WorkflowExecutionContext = {
  workspaceId: 'ws-1',
  runtime: passthroughRuntime,
  cwd: '/repo',
}

/** Real-spawn tests need a cwd that actually exists. */
const REAL_CONTEXT: WorkflowExecutionContext = {
  workspaceId: 'ws-1',
  runtime: passthroughRuntime,
  cwd: process.cwd(),
}

const RUN: WorkflowRun = {
  id: 'run-1',
  taskId: 'task-1',
  workflowDefinitionId: 'test-workflow',
  definition: { id: 'test-workflow', steps: [] },
  status: 'running',
  currentIteration: 0,
  totalIterations: 0,
  criteriaIteration: 0,
  createdAt: '2026-09-11T00:00:00.000Z',
}

function stepFor(nodeId: string): WorkflowStep {
  return {
    id: `step-${nodeId}`,
    workflowRunId: RUN.id,
    nodeId,
    nodeType: 'shell',
    status: 'running',
    iteration: 0,
    attempt: 1,
    createdAt: '2026-09-11T00:00:00.000Z',
  }
}

function executionFor(
  command: string,
  overrides: {
    timeoutMs?: number
    requireConfirmation?: boolean
    run?: WorkflowRun
    context?: WorkflowExecutionContext
  } = {},
): WorkflowStepExecution {
  const node: WorkflowStepExecution['node'] = {
    id: 'verify',
    type: 'shell',
    command,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.requireConfirmation === undefined
      ? {}
      : { requireConfirmation: overrides.requireConfirmation }),
    runOn: 'always',
  }
  return {
    run: overrides.run ?? RUN,
    step: stepFor(node.id),
    node,
    context: overrides.context ?? CONTEXT,
    upstreamOutcomes: {},
  }
}

function mockCommandRunner(result: IpcResult<CommandResult>): {
  commands: CommandRunner
  requests: CommandRequest[]
} {
  const requests: CommandRequest[] = []
  return {
    requests,
    commands: {
      run(request) {
        requests.push(request)
        return Promise.resolve(result)
      },
    },
  }
}

function mockArtifactStore(): {
  artifacts: Pick<ArtifactStore, 'record'>
  requests: RecordArtifactRequest[]
} {
  const requests: RecordArtifactRequest[] = []
  return {
    requests,
    artifacts: {
      record(request) {
        requests.push(request)
        return { ok: true, data: { id: 'artifact-1' } as Artifact }
      },
    },
  }
}

describe('splitCommandLine', () => {
  it('splits on whitespace and groups quoted segments', () => {
    expect(splitCommandLine('dotnet test')).toEqual(['dotnet', 'test'])
    expect(splitCommandLine('git status')).toEqual(['git', 'status'])
    expect(splitCommandLine('npm test -- --run')).toEqual(['npm', 'test', '--', '--run'])
    expect(splitCommandLine('node -e "process.exit(3)"')).toEqual(['node', '-e', 'process.exit(3)'])
    expect(splitCommandLine("echo 'a b'")).toEqual(['echo', 'a b'])
    expect(splitCommandLine('   ')).toEqual([])
  })
})

describe('shellArtifactType', () => {
  it('picks the artifact type from the command semantics', () => {
    expect(shellArtifactType('npm test')).toBe('test-result')
    expect(shellArtifactType('dotnet test --filter X')).toBe('test-result')
    expect(shellArtifactType('git diff')).toBe('diff')
    expect(shellArtifactType('git status')).toBe('implementation')
  })
})

describe('createShellStepExecutor (TASK-058)', () => {
  it('passes command, args, cwd, timeout and runtime to CommandRunner', async () => {
    const { commands, requests } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    const executor = createShellStepExecutor({ commands })

    await executor.execute(executionFor('npm test -- --run', { timeoutMs: 60_000 }))

    expect(requests).toHaveLength(1)
    const request = requests[0] as CommandRequest
    expect(request.command).toBe('npm')
    expect(request.args).toEqual(['test', '--', '--run'])
    expect(request.cwd).toBe('/repo')
    expect(request.timeoutMs).toBe(60_000)
    expect(request.runtime).toBe(passthroughRuntime)
  })

  it('applies the default timeout when the node declares none', async () => {
    const { commands, requests } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    const executor = createShellStepExecutor({ commands, defaultTimeoutMs: 1234 })

    await executor.execute(executionFor('git status'))

    expect((requests[0] as CommandRequest).timeoutMs).toBe(1234)
  })

  it('turns a zero exit code into a completed step result', async () => {
    const { commands } = mockCommandRunner({
      ok: true,
      data: { stdout: 'all green', stderr: '', exitCode: 0 },
    })
    const executor = createShellStepExecutor({ commands })

    const completion = await executor.execute(executionFor('npm test'))

    expect(completion.outcome).toBe('success')
    expect(completion.result).toMatchObject({ exitCode: 0 })
  })

  it('turns a non-zero exit code into a failed step result', async () => {
    const { commands } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '2 failed', exitCode: 1 },
    })
    const executor = createShellStepExecutor({ commands })

    const completion = await executor.execute(executionFor('dotnet test'))

    expect(completion.outcome).toBe('failure')
    expect(completion.result).toMatchObject({ exitCode: 1 })
  })

  it('fails the step with timedOut when the command times out', async () => {
    const { commands } = mockCommandRunner({
      ok: false,
      error: {
        code: 'COMMAND_TIMEOUT',
        message: 'Command "npm" timed out after 100ms.',
        retryable: true,
      },
    })
    const executor = createShellStepExecutor({ commands })

    const completion = await executor.execute(executionFor('npm test', { timeoutMs: 100 }))

    expect(completion.outcome).toBe('failure')
    expect(completion.result).toMatchObject({ timedOut: true })
  })

  it('records the output as a test-result artifact for task-bound runs', async () => {
    const { commands } = mockCommandRunner({
      ok: true,
      data: { stdout: 'tests passed', stderr: 'warn', exitCode: 0 },
    })
    const { artifacts, requests } = mockArtifactStore()
    const executor = createShellStepExecutor({ commands, artifacts })

    const completion = await executor.execute(executionFor('npm test'))

    expect(requests).toHaveLength(1)
    const request = requests[0] as RecordArtifactRequest
    expect(request.taskId).toBe('task-1')
    expect(request.type).toBe('test-result')
    expect(request.content).toContain('tests passed')
    expect(request.content).toContain('warn')
    expect(request.content).toContain('exit code: 0')
    expect(completion.result).toMatchObject({ artifactId: 'artifact-1' })
  })

  it('skips artifact recording for task-less runs (ADR-0006)', async () => {
    const { commands } = mockCommandRunner({
      ok: true,
      data: { stdout: 'branch main', stderr: '', exitCode: 0 },
    })
    const { artifacts, requests } = mockArtifactStore()
    const executor = createShellStepExecutor({ commands, artifacts })
    const tasklessRun: WorkflowRun = { ...RUN }
    delete (tasklessRun as { taskId?: string }).taskId

    const completion = await executor.execute(executionFor('git status', { run: tasklessRun }))

    expect(requests).toHaveLength(0)
    expect(completion.outcome).toBe('success')
    expect(completion.result).not.toHaveProperty('artifactId')
  })

  it('fails cleanly when the execution context lacks runtime/cwd', async () => {
    const { commands, requests } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    const executor = createShellStepExecutor({ commands })

    const completion = await executor.execute(
      executionFor('git status', { context: { workspaceId: 'ws-1' } }),
    )

    expect(completion.outcome).toBe('failure')
    expect(requests).toHaveLength(0)
  })

  it('aborts the in-flight command when the engine cancels the step', async () => {
    const commands = createCommandRunner()
    const executor = createShellStepExecutor({ commands })
    const execution = executionFor(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`,
    )

    const pending = executor.execute({ ...execution, context: REAL_CONTEXT })
    await executor.cancel?.(execution.step.id)
    const completion = await pending

    expect(completion.outcome).toBe('failure')
    expect(completion.result?.['error']).toMatch(/aborted/u)
  })

  it('runs a real command end-to-end and surfaces its exit code', async () => {
    const commands = createCommandRunner()
    const executor = createShellStepExecutor({ commands })

    const ok = await executor.execute(
      executionFor(`${JSON.stringify(process.execPath)} -e "process.exit(0)"`, {
        context: REAL_CONTEXT,
      }),
    )
    expect(ok.outcome).toBe('success')
    expect(ok.result).toMatchObject({ exitCode: 0 })

    const failing = await executor.execute(
      executionFor(`${JSON.stringify(process.execPath)} -e "process.exit(3)"`, {
        context: REAL_CONTEXT,
      }),
    )
    expect(failing.outcome).toBe('failure')
    expect(failing.result).toMatchObject({ exitCode: 3 })
  }, 20_000)

  it('kills a real command that overruns its timeout', async () => {
    const commands = createCommandRunner()
    const executor = createShellStepExecutor({ commands })

    const completion = await executor.execute(
      executionFor(`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`, {
        timeoutMs: 300,
        context: REAL_CONTEXT,
      }),
    )

    expect(completion.outcome).toBe('failure')
    expect(completion.result).toMatchObject({ timedOut: true })
  }, 20_000)
})

describe('shell steps inside the workflow engine (TASK-057 + TASK-058)', () => {
  const openConnections: Database.Database[] = []

  afterEach(() => {
    for (const connection of openConnections.splice(0)) {
      connection.close()
    }
  })

  function setup(exitCode: number) {
    const connection = new Database(':memory:')
    openConnections.push(connection)
    connection.pragma('foreign_keys = ON')
    const migrated = migrateDatabase(connection)
    if (!migrated.ok) throw new Error(migrated.error.message)

    const store = createWorkflowRunStore({
      workflowRuns: createWorkflowRunRepository(connection),
    })
    const { commands } = mockCommandRunner({
      ok: true,
      data: { stdout: 'out', stderr: '', exitCode },
    })
    const engine = createWorkflowEngine({
      runs: store,
      events: createEventBus(),
      executors: { shell: createShellStepExecutor({ commands }) },
    })
    const definition: WorkflowDefinition = {
      id: 'shell-flow',
      steps: [{ id: 'verify', type: 'shell', command: 'npm test', runOn: 'always' }],
    }
    const created = store.createRun({ definition })
    if (!created.ok) throw new Error(created.error.message)
    return { engine, store, run: created.data.run }
  }

  it('completes the step with the exit code as its result', async () => {
    const { engine, store, run } = setup(0)

    const finished = await engine.start(run.id, CONTEXT)
    expect(finished.ok).toBe(true)

    const detail = store.getRun(run.id)
    const step = detail.ok ? detail.data?.steps[0] : undefined
    expect(step?.status).toBe('completed')
    expect(step?.result).toMatchObject({ outcome: 'success', exitCode: 0 })
  })

  it('fails the step on a non-zero exit code', async () => {
    const { engine, store, run } = setup(1)

    await engine.start(run.id, CONTEXT)

    const detail = store.getRun(run.id)
    const step = detail.ok ? detail.data?.steps[0] : undefined
    expect(step?.status).toBe('failed')
    expect(step?.result).toMatchObject({ outcome: 'failure', exitCode: 1 })
  })
})

describe('createShellStepExecutor — repo-defined command confirmation (TASK-118)', () => {
  it('executes a requireConfirmation step only after the user approves the full command line', async () => {
    const { commands, requests } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    const seen: { stepId: string; command: string; cwd: string }[] = []
    const executor = createShellStepExecutor({
      commands,
      confirmation: {
        async request(details) {
          seen.push({ stepId: details.stepId, command: details.command, cwd: details.cwd })
          // Nothing executes while the step awaits the user's decision.
          expect(requests).toHaveLength(0)
          return true
        },
        cancel() {},
      },
    })

    const completion = await executor.execute(
      executionFor('npm run repo-script', { requireConfirmation: true }),
    )

    expect(seen).toEqual([{ stepId: 'step-verify', command: 'npm run repo-script', cwd: '/repo' }])
    expect(requests).toHaveLength(1)
    expect(completion.outcome).toBe('success')
  })

  it('records the approval decision in the step result (code-review P1-6)', async () => {
    const { commands } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    const executor = createShellStepExecutor({
      commands,
      confirmation: { request: async () => true, cancel() {} },
    })

    const completion = await executor.execute(
      executionFor('npm run repo-script', { requireConfirmation: true }),
    )

    expect(completion.outcome).toBe('success')
    const confirmation = completion.result?.['confirmation'] as
      { stepId: string; command: string; cwd: string; decidedAt: string } | undefined
    expect(confirmation).toMatchObject({
      stepId: 'step-verify',
      command: 'npm run repo-script',
      cwd: '/repo',
    })
    expect(Number.isNaN(Date.parse(confirmation?.decidedAt ?? ''))).toBe(false)
  })

  it('keeps the approval record when the confirmed command then fails', async () => {
    const { commands } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 1 },
    })
    const executor = createShellStepExecutor({
      commands,
      confirmation: { request: async () => true, cancel() {} },
    })

    const completion = await executor.execute(
      executionFor('npm run repo-script', { requireConfirmation: true }),
    )

    expect(completion.outcome).toBe('failure')
    expect(completion.result).toMatchObject({
      exitCode: 1,
      confirmation: { stepId: 'step-verify', command: 'npm run repo-script', cwd: '/repo' },
    })
  })

  it('does not execute when the user rejects', async () => {
    const { commands, requests } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    const executor = createShellStepExecutor({
      commands,
      confirmation: { request: async () => false, cancel() {} },
    })

    const completion = await executor.execute(
      executionFor('npm run repo-script', { requireConfirmation: true }),
    )

    expect(requests).toHaveLength(0)
    expect(completion).toMatchObject({
      outcome: 'failure',
      result: { rejected: true },
    })
  })

  it('refuses a requireConfirmation step when no confirmation channel is wired', async () => {
    const { commands, requests } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    const executor = createShellStepExecutor({ commands })

    const completion = await executor.execute(
      executionFor('npm run repo-script', { requireConfirmation: true }),
    )

    expect(requests).toHaveLength(0)
    expect(completion).toMatchObject({ outcome: 'failure', result: { rejected: true } })
  })

  it('runs a step without requireConfirmation exactly as before (trusted / built-in path)', async () => {
    const { commands, requests } = mockCommandRunner({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    })
    let requested = false
    const executor = createShellStepExecutor({
      commands,
      confirmation: {
        async request() {
          requested = true
          return false
        },
        cancel() {},
      },
    })

    const completion = await executor.execute(executionFor('npm test'))

    expect(requested).toBe(false)
    expect(requests).toHaveLength(1)
    expect(completion.outcome).toBe('success')
  })
})
