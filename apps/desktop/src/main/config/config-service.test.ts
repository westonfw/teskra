import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, type Workspace } from '@teskra/contracts'

import type { TeskraPaths } from '../paths'
import { createConfigService, deepMerge, type ConfigServiceDeps } from './config-service'

// Warnings are asserted on the resolve() result; keep the file/stdout pino
// logger quiet (getLogger reads this lazily, at first use).
process.env['TESKRA_LOG_LEVEL'] = 'fatal'

const GLOBAL_CONFIG_PATH = '/teskra-home/config.json'

function stubPaths(): TeskraPaths {
  return {
    home: () => '/teskra-home',
    db: () => ({ ok: true, data: '/teskra-home/db/teskra.sqlite' }),
    logs: () => ({ ok: true, data: '/teskra-home/logs' }),
    runDir: (runId) => ({ ok: true, data: `/teskra-home/runs/${runId}` }),
    runLogFiles: (runDirectory) => ({
      events: `${runDirectory}/events.jsonl`,
      terminal: `${runDirectory}/terminal.log`,
    }),
    runFiles: (runId) => ({
      ok: true,
      data: {
        directory: `/teskra-home/runs/${runId}`,
        manifest: `/teskra-home/runs/${runId}/run.json`,
        events: `/teskra-home/runs/${runId}/events.jsonl`,
        terminal: `/teskra-home/runs/${runId}/terminal.log`,
        handoff: `/teskra-home/runs/${runId}/handoff.json`,
        diff: `/teskra-home/runs/${runId}/diff.patch`,
        artifacts: `/teskra-home/runs/${runId}/artifacts`,
      },
    }),
    config: () => GLOBAL_CONFIG_PATH,
    credentials: () => '/teskra-home/credentials.json',
    repoConfig: (repoRoot) => `${repoRoot}/.teskra/config.json`,
    repoPromptsDir: (repoRoot) => `${repoRoot}/.teskra/prompts`,
    repoWorkflowsDir: (repoRoot) => `${repoRoot}/.teskra/workflows`,
    repoMemoryDir: (repoRoot) => `${repoRoot}/.teskra/memory`,
    agentProfilesRoot: () => `/teskra-home/agent-profiles`,
    resolveAgentProfileHome: (agentId, slug) => ({
      ok: true,
      data: `/teskra-home/agent-profiles/${agentId}/${slug}`,
    }),
    createAgentProfileHome: () => ({ ok: true, data: undefined }),
  }
}

function enoent(path: string): Error {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
  ;(error as NodeJS.ErrnoException).code = 'ENOENT'
  return error
}

/** In-memory file map: path → file content; missing keys throw ENOENT. */
function fakeReadFile(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path]
    if (content === undefined) {
      throw enoent(path)
    }
    return content
  }
}

const REPO_ROOT = '/repo/demo'

function stubWorkspace(id: string): Workspace {
  return {
    id,
    name: 'demo',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: REPO_ROOT,
    trustLevel: 'trusted',
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }
}

function makeDeps(
  files: Record<string, string>,
  overrides: Partial<ConfigServiceDeps> = {},
): ConfigServiceDeps {
  return {
    paths: stubPaths(),
    readFile: fakeReadFile(files),
    workspaces: {
      getById: (id) => ({ ok: true, data: id === 'ws1' ? stubWorkspace(id) : null }),
    },
    ...overrides,
  }
}

describe('ConfigService.resolve — layer order', () => {
  it('returns built-in defaults when no layer files exist', () => {
    const service = createConfigService(makeDeps({}))
    const resolved = service.resolve()
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.config).toEqual(DEFAULT_CONFIG)
    expect(resolved.data.warnings).toEqual([])
    for (const source of Object.values(resolved.data.sources)) {
      expect(source).toBe('default')
    }
  })

  it('applies default < global < workspace < override with per-field sources', () => {
    const service = createConfigService(
      makeDeps({
        [GLOBAL_CONFIG_PATH]: JSON.stringify({
          logging: { level: 'debug' },
          concurrency: { maxGlobalRuns: 8 },
        }),
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          concurrency: { maxGlobalRuns: 6 },
        }),
      }),
    )
    const resolved = service.resolve({
      workspaceId: 'ws1',
      override: { watchdog: { stalledThresholdMs: 60_000 } },
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const { config, sources, warnings } = resolved.data
    expect(warnings).toEqual([])
    expect(config).toEqual({
      logging: { level: 'debug' }, // global
      concurrency: {
        maxGlobalRuns: 6, // workspace beats global
        maxRunsPerWorkspace: 3, // default untouched
        maxRunsPerAgent: 2,
      },
      watchdog: {
        stalledThresholdMs: 60_000, // run override beats all
        preparingTimeoutMs: 300_000, // default untouched
        idleTimeoutMs: 7_200_000,
        idleAction: 'ask',
      },
      environment: { defaultDistro: null },
      agents: { executableOverrides: {}, defaultAccountProfiles: {}, defaultExecutionProfiles: {} },
      review: { mediumBlockThreshold: 0 }, // default untouched
      retention: { mergedWorktreeDays: 1, completedRunLogsDays: 30, discardedRunDays: 30 },
    })
    expect(sources).toEqual({
      'logging.level': 'global',
      'concurrency.maxGlobalRuns': 'workspace',
      'concurrency.maxRunsPerWorkspace': 'default',
      'concurrency.maxRunsPerAgent': 'default',
      'watchdog.stalledThresholdMs': 'override',
      'watchdog.preparingTimeoutMs': 'default',
      'watchdog.idleTimeoutMs': 'default',
      'watchdog.idleAction': 'default',
      'environment.defaultDistro': 'default',
      'review.mediumBlockThreshold': 'default',
      'retention.mergedWorktreeDays': 'default',
      'retention.completedRunLogsDays': 'default',
      'retention.discardedRunDays': 'default',
    })
  })

  it('merges partial groups deeply instead of replacing them', () => {
    const service = createConfigService(
      makeDeps({
        [GLOBAL_CONFIG_PATH]: JSON.stringify({ concurrency: { maxRunsPerAgent: 1 } }),
      }),
    )
    const resolved = service.resolve()
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.config.concurrency).toEqual({
      maxGlobalRuns: 4,
      maxRunsPerWorkspace: 3,
      maxRunsPerAgent: 1,
    })
    expect(resolved.data.sources['concurrency.maxRunsPerAgent']).toBe('global')
    expect(resolved.data.sources['concurrency.maxGlobalRuns']).toBe('default')
  })
})

describe('ConfigService.resolve — degradation', () => {
  it('skips a non-JSON global layer with a warning and keeps defaults', () => {
    const service = createConfigService(makeDeps({ [GLOBAL_CONFIG_PATH]: '{ not json' }))
    const resolved = service.resolve()
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.config).toEqual(DEFAULT_CONFIG)
    expect(resolved.data.warnings).toHaveLength(1)
    expect(resolved.data.warnings[0]).toMatchObject({ layer: 'global' })
  })

  it('skips a schema-invalid layer, naming the layer and field path', () => {
    const service = createConfigService(
      makeDeps({
        [GLOBAL_CONFIG_PATH]: JSON.stringify({ concurrency: { maxGlobalRuns: 8 } }),
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          concurrency: { maxGlobalRuns: 0 },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    // The invalid workspace layer is dropped entirely → global wins.
    expect(resolved.data.config.concurrency.maxGlobalRuns).toBe(8)
    expect(resolved.data.sources['concurrency.maxGlobalRuns']).toBe('global')
    expect(resolved.data.warnings).toHaveLength(1)
    expect(resolved.data.warnings[0]).toMatchObject({
      layer: 'workspace',
      fieldPath: 'concurrency.maxGlobalRuns',
    })
  })

  it('warns and continues when the workspace id is unknown', () => {
    const service = createConfigService(makeDeps({}))
    const resolved = service.resolve({ workspaceId: 'ghost' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.config).toEqual(DEFAULT_CONFIG)
    expect(resolved.data.warnings[0]).toMatchObject({ layer: 'workspace' })
  })

  it('rejects an invalid caller-supplied override with a structured error', () => {
    const service = createConfigService(makeDeps({}))
    const resolved = service.resolve({ override: { watchdog: { stalledThresholdMs: -5 } } })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('ConfigService.resolve — repo-local secret scanning', () => {
  it('strips secret-looking fields but still loads the rest of the layer', () => {
    const service = createConfigService(
      makeDeps({
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          githubToken: 'ghp_1234567890abcdef',
          concurrency: { maxGlobalRuns: 6 },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.warnings).toHaveLength(1)
    expect(resolved.data.warnings[0]).toMatchObject({
      layer: 'workspace',
      fieldPath: 'githubToken',
    })
    // The non-secret field from the same file is still applied.
    expect(resolved.data.config.concurrency.maxGlobalRuns).toBe(6)
    expect(resolved.data.sources['concurrency.maxGlobalRuns']).toBe('workspace')
  })

  it('strips values that match a secret shape even under innocent keys', () => {
    const service = createConfigService(
      makeDeps({
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          logging: { level: 'sk-proj-abcd1234' },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.warnings[0]).toMatchObject({
      layer: 'workspace',
      fieldPath: 'logging.level',
    })
    expect(resolved.data.config.logging.level).toBe('info')
    expect(resolved.data.sources['logging.level']).toBe('default')
  })

  it('does not secret-scan the private global layer', () => {
    // A global-layer value that fails the enum is a plain validation issue,
    // not a secret warning.
    const service = createConfigService(
      makeDeps({ [GLOBAL_CONFIG_PATH]: JSON.stringify({ logging: { level: 'sk-x' } }) }),
    )
    const resolved = service.resolve()
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.warnings[0]?.message).toContain('Invalid global config field')
  })

  it('TASK-088 pinning: a committable repo config never contributes secret values', () => {
    const secret = 'ghp_1234567890abcdef'
    const service = createConfigService(
      makeDeps({
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          githubToken: secret,
          concurrency: { maxGlobalRuns: 6 },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    // Stripped on read with a warning; the secret reaches no resolved field.
    expect(resolved.data.warnings[0]).toMatchObject({
      layer: 'workspace',
      fieldPath: 'githubToken',
    })
    expect(JSON.stringify(resolved.data.config)).not.toContain(secret)
    expect(JSON.stringify(resolved.data.sources)).not.toContain(secret)
  })
})

describe('ConfigService — global-only groups (P0-3)', () => {
  it('strips the agents group from the workspace layer with a warning', () => {
    const service = createConfigService(
      makeDeps({
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          agents: { executableOverrides: { 'codex:wsl': '/evil/codex' } },
          concurrency: { maxGlobalRuns: 6 },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.warnings).toHaveLength(1)
    expect(resolved.data.warnings[0]).toMatchObject({
      layer: 'workspace',
      fieldPath: 'agents',
    })
    // The hostile override never reaches the resolved config...
    expect(resolved.data.config.agents.executableOverrides).toEqual({})
    expect(resolved.data.sources['agents.executableOverrides']).toBeUndefined()
    // ...while the sibling group from the same file still applies.
    expect(resolved.data.config.concurrency.maxGlobalRuns).toBe(6)
    expect(resolved.data.sources['concurrency.maxGlobalRuns']).toBe('workspace')
  })

  it('lets the private global layer set agents normally', () => {
    const service = createConfigService(
      makeDeps({
        [GLOBAL_CONFIG_PATH]: JSON.stringify({
          agents: { executableOverrides: { 'codex:wsl': '/usr/local/bin/codex' } },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.warnings).toEqual([])
    expect(resolved.data.config.agents.executableOverrides).toEqual({
      'codex:wsl': '/usr/local/bin/codex',
    })
  })

  it('workspace agents never beats global agents, even merged per-field', () => {
    const service = createConfigService(
      makeDeps({
        [GLOBAL_CONFIG_PATH]: JSON.stringify({
          agents: { executableOverrides: { 'codex:wsl': '/usr/local/bin/codex' } },
        }),
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          agents: { executableOverrides: { 'claude-code:wsl': '/evil/claude' } },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.config.agents.executableOverrides).toEqual({
      'codex:wsl': '/usr/local/bin/codex',
    })
  })

  it('rejects a workspace patch carrying a global-only group', () => {
    const writes: string[] = []
    const service = createConfigService(
      makeDeps({}, { writeFile: (path) => void writes.push(path) }),
    )
    const result = service.updateWorkspace('ws1', {
      agents: { executableOverrides: { 'codex:wsl': '/evil/codex' } },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(writes).toEqual([])
  })
})

describe('ConfigService — workspace trust gate (TASK-118)', () => {
  const restrictedWorkspace: Workspace = { ...stubWorkspace('ws1'), trustLevel: 'restricted' }
  const restrictedDeps = (
    files: Record<string, string>,
    overrides: Partial<ConfigServiceDeps> = {},
  ): ConfigServiceDeps =>
    makeDeps(files, {
      workspaces: {
        getById: (id) => ({ ok: true, data: id === 'ws1' ? restrictedWorkspace : null }),
      },
      ...overrides,
    })

  it('skips the whole workspace layer for a restricted workspace, with a warning', () => {
    const service = createConfigService(
      restrictedDeps({
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          concurrency: { maxGlobalRuns: 6 },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.warnings).toHaveLength(1)
    expect(resolved.data.warnings[0]?.message).toContain('restricted')
    // The repo-local value never applies; the default wins.
    expect(resolved.data.config.concurrency.maxGlobalRuns).toBe(
      DEFAULT_CONFIG.concurrency.maxGlobalRuns,
    )
    expect(resolved.data.sources['concurrency.maxGlobalRuns']).toBe('default')
  })

  it('keeps the global layer fully effective for a restricted workspace', () => {
    const service = createConfigService(
      restrictedDeps({
        [GLOBAL_CONFIG_PATH]: JSON.stringify({
          agents: { executableOverrides: { 'codex:wsl': '/usr/local/bin/codex' } },
        }),
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          agents: { executableOverrides: { 'codex:wsl': '/evil/codex' } },
          concurrency: { maxGlobalRuns: 6 },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.config.agents.executableOverrides).toEqual({
      'codex:wsl': '/usr/local/bin/codex',
    })
    expect(resolved.data.config.concurrency.maxGlobalRuns).toBe(
      DEFAULT_CONFIG.concurrency.maxGlobalRuns,
    )
  })

  it('loads the workspace layer unchanged for a trusted workspace', () => {
    const service = createConfigService(
      makeDeps({
        [`${REPO_ROOT}/.teskra/config.json`]: JSON.stringify({
          concurrency: { maxGlobalRuns: 6 },
        }),
      }),
    )
    const resolved = service.resolve({ workspaceId: 'ws1' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.warnings).toEqual([])
    expect(resolved.data.config.concurrency.maxGlobalRuns).toBe(6)
    expect(resolved.data.sources['concurrency.maxGlobalRuns']).toBe('workspace')
  })
})

describe('ConfigService — real filesystem smoke test', () => {
  let tempHome: string
  let savedTeskraHome: string | undefined

  beforeEach(() => {
    savedTeskraHome = process.env['TESKRA_HOME']
    tempHome = mkdtempSync(join(tmpdir(), 'teskra-config-'))
    process.env['TESKRA_HOME'] = tempHome
  })

  afterEach(() => {
    if (savedTeskraHome === undefined) {
      delete process.env['TESKRA_HOME']
    } else {
      process.env['TESKRA_HOME'] = savedTeskraHome
    }
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('reads the global config through the real paths module', async () => {
    const { createTeskraPaths } = await import('../paths')
    const { writeFileSync } = await import('node:fs')
    const paths = createTeskraPaths()
    writeFileSync(paths.config(), JSON.stringify({ logging: { level: 'warn' } }))
    const service = createConfigService({ paths })
    const resolved = service.resolve()
    expect(resolved.ok && resolved.data.config.logging.level).toBe('warn')
    expect(resolved.ok && resolved.data.sources['logging.level']).toBe('global')
  })

  it('atomically creates and updates the global layer without flattening defaults', async () => {
    const { createTeskraPaths } = await import('../paths')
    const { readFileSync } = await import('node:fs')
    const paths = createTeskraPaths()
    const service = createConfigService({ paths })

    const first = service.updateGlobal({ environment: { defaultDistro: 'Ubuntu-24.04' } })
    expect(first.ok && first.data.config.environment.defaultDistro).toBe('Ubuntu-24.04')
    const second = service.updateGlobal({ logging: { level: 'debug' } })
    expect(second.ok && second.data.config.environment.defaultDistro).toBe('Ubuntu-24.04')

    expect(JSON.parse(readFileSync(paths.config(), 'utf8'))).toEqual({
      environment: { defaultDistro: 'Ubuntu-24.04' },
      logging: { level: 'debug' },
    })
  })

  it('does not overwrite an invalid existing global config', async () => {
    const { createTeskraPaths } = await import('../paths')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const paths = createTeskraPaths()
    writeFileSync(paths.config(), '{ broken')
    const service = createConfigService({ paths })

    const result = service.updateGlobal({ environment: { defaultDistro: 'Ubuntu' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(readFileSync(paths.config(), 'utf8')).toBe('{ broken')
  })
})

describe('ConfigService.updateWorkspace', () => {
  it('writes the repo-local layer and resolves workspace provenance', () => {
    const files: Record<string, string> = {}
    const service = createConfigService(
      makeDeps(files, {
        writeFile: (path, contents) => {
          files[path] = contents
        },
      }),
    )

    const updated = service.updateWorkspace('ws1', {
      concurrency: { maxRunsPerWorkspace: 7 },
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data.config.concurrency.maxRunsPerWorkspace).toBe(7)
    expect(updated.data.sources['concurrency.maxRunsPerWorkspace']).toBe('workspace')
    expect(JSON.parse(files[`${REPO_ROOT}/.teskra/config.json`] ?? '')).toEqual({
      concurrency: { maxRunsPerWorkspace: 7 },
    })
  })

  it('rejects unknown workspaces and secret-looking values', () => {
    const writes: string[] = []
    const service = createConfigService(
      makeDeps({}, { writeFile: (path) => void writes.push(path) }),
    )

    const missing = service.updateWorkspace('ghost', { logging: { level: 'debug' } })
    expect(missing).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } })

    const secret = service.updateWorkspace('ws1', {
      environment: { defaultDistro: 'ghp_1234567890abcdef' },
    })
    expect(secret).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(writes).toEqual([])
  })
})

describe('deepMerge — dangerous keys (P2-19)', () => {
  it('skips __proto__ / constructor / prototype instead of assigning them', () => {
    const layer = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}, "prototype": {"y": 2}, "logging": {"level": "debug"}}',
    ) as Record<string, unknown>

    const merged = deepMerge({ logging: { level: 'info' } }, layer)

    expect(merged).toEqual({ logging: { level: 'debug' } })
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false)
    expect(Object.keys(merged)).not.toContain('constructor')
    expect(Object.keys(merged)).not.toContain('prototype')
    // No prototype mutation leaked into the result or the global chain.
    expect(merged['polluted']).toBeUndefined()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('also skips dangerous keys in nested merge layers', () => {
    const layer = JSON.parse(
      '{"retention": {"__proto__": {"polluted": true}, "mergedWorktreeDays": 7}}',
    ) as Record<string, unknown>

    const merged = deepMerge({ retention: { mergedWorktreeDays: 30 } }, layer)

    expect(merged).toEqual({ retention: { mergedWorktreeDays: 7 } })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})
