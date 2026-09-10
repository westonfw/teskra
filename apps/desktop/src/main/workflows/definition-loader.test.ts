import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createTeskraPaths } from '../paths'
import { createWorkflowDefinitionLoader } from './definition-loader'

/**
 * TASK-055 loader tests (ADR-0005): repo-local `<repo>/.teskra/workflows/`
 * files, loadable as `.json` or `.yaml` (JSON subset of YAML 1.2 — the
 * dependency tree has no YAML parser yet). Invalid files surface as
 * `status: 'invalid'` with reasons; they are never silently dropped.
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
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

function fileSeam(files: Record<string, string>) {
  return {
    readFile: (path: string) => {
      const entry = files[path]
      if (entry === undefined) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return entry
    },
    listDir: (path: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const entries = Object.keys(files)
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

  it('rejects full YAML block syntax with a precise error (no YAML parser dependency)', () => {
    const paths = makePaths()
    const dir = paths.repoWorkflowsDir('/repo')
    const seam = fileSeam({
      [join(dir, 'block.yaml')]: 'id: block\nsteps:\n  - id: a\n    type: shell\n',
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
})
