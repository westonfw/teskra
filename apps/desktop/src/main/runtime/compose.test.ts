import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FUTURE_RUNTIME_PORTS } from '@teskra/contracts'
import { buildHandoffContext } from '@teskra/shared'

import { createTeskraPaths } from '../paths'
import type { CommandRunner } from '../process/command-runner'
import { composeTeskraRuntime } from './compose'
import { requireRuntimePort } from './facade'

const tempHomes: string[] = []

afterEach(() => {
  for (const path of tempHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function makeHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'teskra-compose-'))
  tempHomes.push(path)
  return path
}

function wslCommands(): CommandRunner {
  return {
    async run(request) {
      if (request.args?.includes('--status')) {
        return {
          ok: true,
          data: { stdout: 'Default Distribution: Ubuntu-24.04\r\n', stderr: '', exitCode: 0 },
        }
      }
      if (request.args?.includes('--version')) {
        return {
          ok: true,
          data: { stdout: 'WSL version: 2.6.3.0\r\n', stderr: '', exitCode: 0 },
        }
      }
      return {
        ok: true,
        data: { stdout: 'Ubuntu-24.04\r\nDebian\r\n', stderr: '', exitCode: 0 },
      }
    },
  }
}

describe('TeskraRuntime composition root (TASK-081)', () => {
  it('instantiates under plain Node with working workspace, terminal, and system ports', async () => {
    const home = makeHome()
    const paths = createTeskraPaths({ TESKRA_HOME: home })
    const composed = await composeTeskraRuntime({
      paths,
      commands: wslCommands(),
      hostPlatform: 'linux',
      appVersion: '9.8.7',
      runtimeVersion: '22.test',
      initializeLogs: false,
      includeDevelopmentAgents: true,
    })
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    const runtime = composed.data

    const workspacePath = join(home, 'repo')
    mkdirSync(workspacePath)
    const created = runtime.workspace.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: workspacePath,
    })
    expect(created.ok).toBe(true)
    expect(runtime.workspace.listRecent().ok).toBe(true)
    expect(runtime.terminal.list()).toEqual({ ok: true, data: [] })
    expect(runtime.agent.listDefinitions()).toMatchObject({
      ok: true,
      data: [{ id: 'codex' }, { id: 'claude' }, { id: 'fake' }],
    })
    expect(runtime.agent.list({ activeOnly: true })).toEqual({ ok: true, data: [] })
    if (!created.ok) throw new Error('expected workspace')
    const task = runtime.task.create({ workspaceId: created.data.id, title: 'Compose runtime' })
    expect(task).toMatchObject({
      ok: true,
      data: { workspaceId: created.data.id, title: 'Compose runtime', status: 'draft' },
    })
    expect(runtime.task.list({ workspaceId: created.data.id })).toMatchObject({
      ok: true,
      data: [{ title: 'Compose runtime' }],
    })
    expect(runtime.system.info()).toEqual({
      ok: true,
      data: { appVersion: '9.8.7', runtimeVersion: '22.test' },
    })
    const systemPaths = runtime.system.paths()
    expect(systemPaths.ok).toBe(true)
    if (systemPaths.ok) {
      expect(systemPaths.data.dataDirectory).toBe(home)
      expect(systemPaths.data.databaseFile).toBe(join(home, 'db', 'teskra.sqlite'))
      expect(existsSync(systemPaths.data.logDirectory)).toBe(true)
    }
    const health = await runtime.system.health()
    expect(health).toEqual({
      ok: true,
      data: { databaseAvailable: true, wslAvailable: true, issues: [] },
    })

    expect(runtime.dispose()).toEqual({ ok: true, data: undefined })
    expect(runtime.dispose()).toEqual({ ok: true, data: undefined })
  })

  it('mounts WSL list/read/write operations on the system port', async () => {
    const home = makeHome()
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
    })
    if (!composed.ok) throw new Error('expected runtime')

    const listed = await composed.data.system.listWslDistributions()
    expect(listed.ok && listed.data.map((item) => item.name)).toEqual(['Ubuntu-24.04', 'Debian'])
    expect(await composed.data.system.getDefaultWslDistribution()).toEqual({
      ok: true,
      data: 'Ubuntu-24.04',
    })
    expect(await composed.data.system.setDefaultWslDistribution('debian')).toEqual({
      ok: true,
      data: 'Debian',
    })
    expect(await composed.data.system.getDefaultWslDistribution()).toEqual({
      ok: true,
      data: 'Debian',
    })
    composed.data.dispose()
  })

  it('mounts Settings config writes and the injected folder opener', async () => {
    const home = makeHome()
    const openPath = vi.fn(async () => '')
    const selectDirectory = vi.fn(async () => '/selected/repo')
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
      openPath,
      selectDirectory,
    })
    if (!composed.ok) throw new Error('expected runtime')

    const repo = join(home, 'repo')
    mkdirSync(repo)
    const workspace = composed.data.workspace.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: repo,
    })
    if (!workspace.ok) throw new Error('expected workspace')

    const global = composed.data.settings.updateConfig({
      layer: 'global',
      patch: { logging: { level: 'debug' } },
    })
    expect(global.ok && global.data.sources['logging.level']).toBe('global')
    const local = composed.data.settings.updateConfig({
      layer: 'workspace',
      workspaceId: workspace.data.id,
      patch: { logging: { level: 'warn' } },
    })
    expect(local.ok && local.data.sources['logging.level']).toBe('workspace')

    expect(await composed.data.settings.openDirectory({ kind: 'data' })).toEqual({
      ok: true,
      data: undefined,
    })
    expect(await composed.data.settings.openDirectory({ kind: 'logs' })).toEqual({
      ok: true,
      data: undefined,
    })
    expect(openPath).toHaveBeenNthCalledWith(1, home)
    expect(openPath).toHaveBeenNthCalledWith(2, join(home, 'logs'))
    expect(await composed.data.workspace.selectDirectory({ runtime: { kind: 'windows' } })).toEqual(
      { ok: true, data: '/selected/repo' },
    )
    expect(selectDirectory).toHaveBeenCalledOnce()
    composed.data.dispose()
  })

  it('mounts the Credential Store port with an explicit unavailable degrade (TASK-088)', async () => {
    const home = makeHome()
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
    })
    if (!composed.ok) throw new Error('expected runtime')

    // No cipher injected → explicit degrade, never silent plaintext.
    expect(composed.data.credential.status()).toEqual({ ok: true, data: { available: false } })
    const set = composed.data.credential.set({ key: 'OPENAI_API_KEY', value: 'sk-compose-secret' })
    expect(set.ok).toBe(false)
    if (!set.ok) expect(set.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    expect(existsSync(join(home, 'credentials.json'))).toBe(false)

    // Workspace env secrets are refused end-to-end while unavailable.
    const repo = join(home, 'repo')
    mkdirSync(repo)
    const workspace = composed.data.workspace.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: repo,
      env: { OPENAI_API_KEY: 'sk-compose-secret' },
    })
    expect(workspace.ok).toBe(false)
    if (!workspace.ok) expect(workspace.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    composed.data.dispose()
  })

  it('stores and resolves credentials through an injected cipher (TASK-088)', async () => {
    const home = makeHome()
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
      credentialCipher: {
        isAvailable: () => true,
        encrypt: (plaintext) => `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
        decrypt: (ciphertext) =>
          Buffer.from(ciphertext.slice('enc:'.length), 'base64').toString('utf8'),
      },
    })
    if (!composed.ok) throw new Error('expected runtime')

    expect(composed.data.credential.status()).toEqual({ ok: true, data: { available: true } })
    expect(composed.data.credential.set({ key: 'OPENAI_API_KEY', value: 'sk-compose-secret' })).toEqual({
      ok: true,
      data: undefined,
    })
    // list exposes key names only; no get channel exists on the facade.
    expect(composed.data.credential.list()).toEqual({ ok: true, data: ['OPENAI_API_KEY'] })
    expect(readFileSync(join(home, 'credentials.json'), 'utf8')).not.toContain(
      'sk-compose-secret',
    )
    expect(composed.data.credential.delete({ key: 'OPENAI_API_KEY' })).toEqual({
      ok: true,
      data: true,
    })
    composed.data.dispose()
  })

  it('runs the repository Fake Agent through the composed Agent lifecycle', async () => {
    const home = makeHome()
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      hostPlatform: 'linux',
      wslInfo: { available: true },
      initializeLogs: false,
      includeDevelopmentAgents: true,
      fakeAgentScriptPath: join(process.cwd(), 'tools', 'fake-agent.js'),
    })
    if (!composed.ok) throw new Error('expected runtime')

    const repo = join(home, 'repo')
    mkdirSync(repo)
    const workspace = composed.data.workspace.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: repo,
    })
    if (!workspace.ok) throw new Error(workspace.error.message)
    const completed = new Promise<{ runId: string; exitCode: number }>((resolveCompleted) => {
      composed.data.events.subscribe('agent.completed', resolveCompleted)
    })

    const started = await composed.data.agent.start({
      workspaceId: workspace.data.id,
      agentType: 'fake',
      executionMode: 'attended',
      environment: { TESKRA_FAKE_SCENARIO: 'success' },
    })
    expect(started).toMatchObject({ ok: true, data: { status: 'running' } })
    const exit = await completed
    expect(exit.exitCode).toBe(0)
    expect(composed.data.agent.get({ runId: exit.runId })).toMatchObject({
      ok: true,
      data: { status: 'completed', exitCode: 0 },
    })

    // TASK-051: the Fake Agent's file-contract handoff was collected on exit
    // and is queryable through the facade (ADR-0004).
    const handoff = composed.data.handoff.get({ runId: exit.runId })
    expect(handoff).toMatchObject({
      ok: true,
      data: {
        runId: exit.runId,
        type: 'implementation',
        parseStatus: 'ok',
        payload: { summary: 'Fake Agent completed the requested work.' },
      },
    })

    // The next Agent can receive the handoff as prompt context: the same
    // record renders as the {{previousHandoff}} variable (TASK-079).
    const previousHandoff =
      handoff.ok && handoff.data !== null ? buildHandoffContext(handoff.data) : undefined
    expect(previousHandoff).toContain('Fake Agent completed the requested work.')
    const rendered = composed.data.prompts.render({
      name: 'review',
      context: {
        task: { title: 'Demo Task', description: 'Describe it.' },
        criteria: ['It works'],
        role: 'reviewer',
        memory: '',
        ...(previousHandoff === undefined ? {} : { previousHandoff }),
        env: { TESKRA_HANDOFF_PATH: '/tmp/handoff.json', TESKRA_ARTIFACT_DIR: '/tmp/artifacts' },
      },
    })
    expect(rendered.ok).toBe(true)
    if (rendered.ok) {
      expect(rendered.data.content).toContain('Fake Agent completed the requested work.')
    }

    composed.data.dispose()
  })

  it('degrades gracefully when the Fake Agent writes a malformed handoff (TASK-051)', async () => {
    const home = makeHome()
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      hostPlatform: 'linux',
      wslInfo: { available: true },
      initializeLogs: false,
      includeDevelopmentAgents: true,
      fakeAgentScriptPath: join(process.cwd(), 'tools', 'fake-agent.js'),
    })
    if (!composed.ok) throw new Error('expected runtime')

    const repo = join(home, 'repo')
    mkdirSync(repo)
    const workspace = composed.data.workspace.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: repo,
    })
    if (!workspace.ok) throw new Error(workspace.error.message)
    const completed = new Promise<{ runId: string; exitCode: number }>((resolveCompleted) => {
      composed.data.events.subscribe('agent.completed', resolveCompleted)
    })

    const started = await composed.data.agent.start({
      workspaceId: workspace.data.id,
      agentType: 'fake',
      executionMode: 'attended',
      environment: { TESKRA_FAKE_SCENARIO: 'bad-handoff' },
    })
    expect(started).toMatchObject({ ok: true, data: { status: 'running' } })
    const exit = await completed

    // The run still completes and the raw handoff file is preserved on disk.
    expect(composed.data.agent.get({ runId: exit.runId })).toMatchObject({
      ok: true,
      data: { status: 'completed', exitCode: 0 },
    })
    const handoff = composed.data.handoff.get({ runId: exit.runId })
    expect(handoff).toMatchObject({ ok: true, data: { parseStatus: 'degraded' } })
    if (handoff.ok && handoff.data !== null) {
      expect(readFileSync(handoff.data.rawPath as string, 'utf8')).toBe(
        '{ definitely-not-valid-json',
      )
    }

    composed.data.dispose()
  })

  it('renders prompt templates through the facade, honoring repo-local overrides (TASK-079)', async () => {
    const home = makeHome()
    const paths = createTeskraPaths({ TESKRA_HOME: home })
    const composed = await composeTeskraRuntime({
      paths,
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
    })
    if (!composed.ok) throw new Error('expected runtime')
    const runtime = composed.data

    const context = {
      task: { title: 'Demo Task', description: 'Describe it.' },
      criteria: ['It works'],
      role: 'implementer',
      env: { TESKRA_HANDOFF_PATH: '/tmp/handoff.json', TESKRA_ARTIFACT_DIR: '/tmp/artifacts' },
    }

    const builtin = runtime.prompts.render({ name: 'implement', context })
    expect(builtin.ok).toBe(true)
    if (builtin.ok) {
      expect(builtin.data.source).toBe('builtin')
      expect(builtin.data.content).toContain('Demo Task')
      expect(builtin.data.content).toContain('/tmp/handoff.json')
      expect(builtin.data.content).not.toMatch(/\{\{[^{}]*\}\}/)
    }

    const repo = join(home, 'repo')
    mkdirSync(repo)
    const workspace = runtime.workspace.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: repo,
    })
    if (!workspace.ok) throw new Error('expected workspace')
    mkdirSync(paths.repoPromptsDir(repo), { recursive: true })
    writeFileSync(join(paths.repoPromptsDir(repo), 'implement.md'), 'OVERRIDE: {{task.title}}')

    const overridden = runtime.prompts.render({
      name: 'implement',
      workspaceId: workspace.data.id,
      context,
    })
    expect(overridden.ok).toBe(true)
    if (overridden.ok) {
      expect(overridden.data.source).toBe('repo-local')
      expect(overridden.data.content).toBe('OVERRIDE: Demo Task')
    }

    const listed = runtime.prompts.list({ workspaceId: workspace.data.id })
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.data.find((info) => info.name === 'implement')?.source).toBe('repo-local')
      expect(listed.data.find((info) => info.name === 'plan')?.source).toBe('builtin')
    }

    expect(runtime.prompts.render({ name: 'plan', workspaceId: 'missing', context })).toMatchObject(
      { ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } },
    )
    runtime.dispose()
  })

  it('reports every not-yet-mounted port as CAPABILITY_NOT_AVAILABLE', async () => {
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: makeHome() }),
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
    })
    if (!composed.ok) throw new Error('expected runtime')

    for (const name of FUTURE_RUNTIME_PORTS.filter(
      (candidate) =>
        candidate !== 'agent' &&
        candidate !== 'task' &&
        candidate !== 'git' &&
        candidate !== 'worktree' &&
        candidate !== 'workflow',
    )) {
      const result = requireRuntimePort(composed.data, name)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    }
    // TASK-055: the workflow port is mounted (repo-local definition loading).
    expect(requireRuntimePort(composed.data, 'workflow').ok).toBe(true)
    composed.data.dispose()
  })
})
