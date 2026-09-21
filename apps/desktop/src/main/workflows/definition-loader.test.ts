import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTeskraPaths } from '../paths'
import { createWorkflowDefinitionLoader } from './definition-loader'

/**
 * TASK-055 loader tests (ADR-0005): repo-local `<repo>/.teskra/workflows/`
 * files, loadable as `.json` or `.yaml` / `.yml` (full YAML block syntax via
 * the `yaml` package; JSON is a subset of YAML 1.2). Invalid files surface
 * as `status: 'invalid'` with reasons; they are never silently dropped.
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

function makePaths(): ReturnType<typeof createTeskraPaths> {
  const home = mkdtempSync(join(tmpdir(), 'teskra-workflow-loader-'))
  tempDirs.push(home)
  return createTeskraPaths({ TESKRA_HOME: home })
}

const VALID = {
  id: 'full-review',
  steps: [
    { id: 'implement', type: 'agent', agent: 'codex', runOn: 'first' },
    { id: 'gate', type: 'criteria-gate', dependsOn: ['implement'] },
  ],
}

// The loader builds paths with node:path.join (host separators), while the
// seam's matching below is written against '/'; normalize both sides so the
// seam behaves identically on Windows and POSIX hosts.
const toPosixSeps = (value: string): string => value.replaceAll('\\', '/')

function fileSeam(files: Record<string, string>) {
  const byPosixPath = new Map(
    Object.entries(files).map(([path, content]) => [toPosixSeps(path), content] as const),
  )
  return {
    readFile: (path: string) => {
      const entry = byPosixPath.get(toPosixSeps(path))
      if (entry === undefined) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return entry
    },
    listDir: (path: string) => {
      const posixPath = toPosixSeps(path)
      const prefix = posixPath.endsWith('/') ? posixPath : `${posixPath}/`
      const entries = [...byPosixPath.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map((key) => key.slice(prefix.length))
      if (entries.length === 0) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return entries
    },
  }
}

describe('WorkflowDefinitionLoader (TASK-055)', () => {
  it('returns an empty list when the repo has no workflows directory', () => {
    const loader = createWorkflowDefinitionLoader({ paths: makePaths() })
    expect(loader.list('/repo/without-workflows')).toEqual({ ok: true, data: [] })
  })

  it('loads JSON and JSON-subset YAML files; other extensions are ignored', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const seam = fileSeam({
      [join(dir, 'a.json')]: JSON.stringify(VALID),
      [join(dir, 'b.yaml')]: JSON.stringify({ ...VALID, id: 'yaml-subset' }),
      [join(dir, 'notes.md')]: '# not a workflow',
    })
    const loader = createWorkflowDefinitionLoader({ paths, ...seam })

    const listed = loader.list('/repo')
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.map((info) => info.id).sort()).toEqual(['full-review', 'yaml-subset'])
    expect(listed.data.every((info) => info.status === 'loaded')).toBe(true)
    // runOn defaulted to 'always' during validation.
    const loaded = loader.load('/repo', 'yaml-subset')
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.data.steps[1]?.runOn).toBe('always')
    }
  })

  it('reports invalid definitions with their rejection reasons', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const cyclic = {
      id: 'cyclic',
      steps: [
        { id: 'a', type: 'shell', command: 'true', dependsOn: ['b'] },
        { id: 'b', type: 'shell', command: 'true', dependsOn: ['a'] },
      ],
    }
    const seam = fileSeam({
      [join(dir, 'ok.json')]: JSON.stringify(VALID),
      [join(dir, 'cyclic.yaml')]: JSON.stringify(cyclic),
    })
    const loader = createWorkflowDefinitionLoader({ paths, ...seam })

    const listed = loader.list('/repo')
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const invalid = listed.data.find((info) => info.status === 'invalid')
    expect(invalid?.id).toBe('cyclic')
    expect(invalid?.issues.some((issue) => issue.includes('cycle'))).toBe(true)

    const loaded = loader.load('/repo', 'cyclic')
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('VALIDATION_FAILED')
      expect(loaded.error.message).toContain('cyclic')
    }
  })

  it('loads full YAML block syntax (.yaml and .yml)', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const yamlBlock = [
      'id: block-workflow',
      'steps:',
      '  - id: implement',
      '    type: agent',
      '    agent: codex',
      '    runOn: first',
      '  - id: gate',
      '    type: criteria-gate',
      '    dependsOn:',
      '      - implement',
      '',
    ].join('\n')
    const seam = fileSeam({
      [join(dir, 'block.yaml')]: yamlBlock,
      [join(dir, 'block.yml')]: yamlBlock.replace('block-workflow', 'block-workflow-yml'),
    })
    const loader = createWorkflowDefinitionLoader({ paths, ...seam })

    const listed = loader.list('/repo')
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.map((info) => info.id).sort()).toEqual([
      'block-workflow',
      'block-workflow-yml',
    ])
    expect(listed.data.every((info) => info.status === 'loaded')).toBe(true)

    const loaded = loader.load('/repo', 'block-workflow')
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      const first = loaded.data.steps[0]
      if (first?.type !== 'agent') throw new Error('expected the first step to be an agent step')
      expect(first.agent).toBe('codex')
      expect(loaded.data.steps[1]?.dependsOn).toEqual(['implement'])
    }
  })

  it('rejects YAML syntax errors with a precise error', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const seam = fileSeam({
      [join(dir, 'broken.yaml')]: 'id: broken\nsteps:\n  - id: a\n   type: shell\n',
    })
    const loader = createWorkflowDefinitionLoader({ paths, ...seam })
    const listed = loader.list('/repo')
    expect(listed.ok).toBe(false)
    if (!listed.ok) {
      expect(listed.error.code).toBe('VALIDATION_FAILED')
      expect(listed.error.message).toContain('not parseable')
    }
  })

  it('rejects invalid JSON syntax with a precise error', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const seam = fileSeam({
      [join(dir, 'broken.json')]: '{"id": "broken", "steps": [}',
    })
    const loader = createWorkflowDefinitionLoader({ paths, ...seam })
    const listed = loader.list('/repo')
    expect(listed.ok).toBe(false)
    if (!listed.ok) {
      expect(listed.error.code).toBe('VALIDATION_FAILED')
      expect(listed.error.message).toContain('not parseable')
    }
  })

  it('returns not-found for unknown definition ids', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const seam = fileSeam({ [join(dir, 'a.json')]: JSON.stringify(VALID) })
    const loader = createWorkflowDefinitionLoader({ paths, ...seam })
    const loaded = loader.load('/repo', 'missing')
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('VALIDATION_FAILED')
      expect(loaded.error.message).toContain('"missing"')
    }
  })

  it('forces requireConfirmation on every repo-loaded shell node, even when the file says false (P1-7)', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const withShell = {
      id: 'shell-workflow',
      steps: [
        { id: 'build', type: 'shell', command: 'make all', requireConfirmation: false },
        { id: 'test', type: 'shell', command: 'make test', dependsOn: ['build'] },
      ],
    }
    const seam = fileSeam({
      [join(dir, 'shell.yaml')]: [
        'id: shell-workflow',
        'steps:',
        '  - id: build',
        '    type: shell',
        '    command: make all',
        '    requireConfirmation: false',
        '  - id: test',
        '    type: shell',
        '    command: make test',
        '    dependsOn:',
        '      - build',
        '',
      ].join('\n'),
      [join(dir, 'shell.json')]: JSON.stringify({ ...withShell, id: 'shell-json' }),
    })
    const loader = createWorkflowDefinitionLoader({ paths, ...seam })

    for (const id of ['shell-workflow', 'shell-json']) {
      const loaded = loader.load('/repo', id)
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) continue
      const shellNodes = loaded.data.steps.filter((step) => step.type === 'shell')
      expect(shellNodes).toHaveLength(2)
      expect(shellNodes.every((node) => node.requireConfirmation === true)).toBe(true)
    }
  })
})
