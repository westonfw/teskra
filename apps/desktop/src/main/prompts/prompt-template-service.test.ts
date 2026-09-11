import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUILT_IN_PROMPT_TEMPLATES, type PromptTemplateContext } from '@teskra/contracts'

import { createTeskraPaths } from '../paths'
import { createPromptTemplateService } from './prompt-template-service'

const tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

function makeRepo(): { repoRoot: string; writeOverride: (name: string, content: string) => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'teskra-prompts-test-'))
  tempRoots.push(repoRoot)
  return {
    repoRoot,
    writeOverride(name, content) {
      const dir = join(repoRoot, '.teskra', 'prompts')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${name}.md`), content, 'utf8')
    },
  }
}

function makeService() {
  const home = mkdtempSync(join(tmpdir(), 'teskra-prompts-home-'))
  tempRoots.push(home)
  return createPromptTemplateService({ paths: createTeskraPaths({ TESKRA_HOME: home }) })
}

function fullContext(): PromptTemplateContext {
  return {
    task: { title: 'Add dark mode', description: 'Support a dark theme across the app.' },
    criteria: ['Settings page has a theme toggle', 'Choice persists across restarts'],
    role: 'implementer',
    memory: 'Prefers Ant Design components.',
    previousHandoff: '{"runId":"run-0","type":"analysis","summary":"Plan approved."}',
    env: {
      TESKRA_HANDOFF_PATH: '/data/runs/run-1/handoff.json',
      TESKRA_ARTIFACT_DIR: '/data/runs/run-1/artifacts',
    },
  }
}

describe('PromptTemplateService (TASK-079)', () => {
  it('ships exactly the 5 built-in templates and renders each of them', () => {
    const service = makeService()
    expect([...BUILT_IN_PROMPT_TEMPLATES].sort()).toEqual(
      ['fix', 'implement', 'plan', 'review', 'test'].sort(),
    )

    for (const name of BUILT_IN_PROMPT_TEMPLATES) {
      const rendered = service.render({ name, context: fullContext() })
      expect(rendered.ok, `template "${name}" renders`).toBe(true)
      if (!rendered.ok) continue
      expect(rendered.data.source).toBe('builtin')
      expect(rendered.data.content).toContain('Add dark mode')
      expect(rendered.data.content).toContain('Support a dark theme across the app.')
      expect(rendered.data.content).toContain('- Settings page has a theme toggle')
      expect(rendered.data.content).toContain('implementer')
      // Every built-in template carries the ADR-0004 handoff instruction.
      expect(rendered.data.content).toContain('/data/runs/run-1/handoff.json')
      expect(rendered.data.content).toContain('/data/runs/run-1/artifacts')
      expect(rendered.data.content.toLowerCase()).toContain('handoff')
      // No placeholder survives rendering.
      expect(rendered.data.content).not.toMatch(/\{\{[^{}]*\}\}/)
    }
  })

  it('renders {{memory}} as an empty string until ContextBuilder (TASK-068) exists', () => {
    const service = makeService()
    const context = fullContext()
    delete context.memory
    const rendered = service.render({ name: 'plan', context })
    expect(rendered.ok).toBe(true)
    if (rendered.ok) {
      expect(rendered.data.content).toContain('## Workspace Memory\n\n\n')
    }
  })

  it('lets a repo-local template override the built-in one', () => {
    const { repoRoot, writeOverride } = makeRepo()
    writeOverride('implement', 'CUSTOM: {{task.title}} via {{env.TESKRA_HANDOFF_PATH}}')
    const service = makeService()

    const resolved = service.resolve('implement', repoRoot)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.data.source).toBe('repo-local')
      expect(resolved.data.path).toBe(join(repoRoot, '.teskra', 'prompts', 'implement.md'))
    }

    const rendered = service.render({ name: 'implement', context: fullContext() }, repoRoot)
    expect(rendered.ok).toBe(true)
    if (rendered.ok) {
      expect(rendered.data.source).toBe('repo-local')
      expect(rendered.data.content).toBe(
        'CUSTOM: Add dark mode via /data/runs/run-1/handoff.json',
      )
    }
  })

  it('falls back to the built-in template when no override file exists', () => {
    const { repoRoot } = makeRepo()
    const service = makeService()

    const resolved = service.resolve('review', repoRoot)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.data.source).toBe('builtin')
      expect(resolved.data.path).toBeUndefined()
    }
  })

  it('fails with a clear error on unknown variables and never leaves {{...}} behind', () => {
    const { repoRoot, writeOverride } = makeRepo()
    writeOverride('plan', 'Plan for {{task.title}} owned by {{assignee}}.')
    const service = makeService()

    const rendered = service.render({ name: 'plan', context: fullContext() }, repoRoot)
    expect(rendered.ok).toBe(false)
    if (!rendered.ok) {
      expect(rendered.error.code).toBe('VALIDATION_FAILED')
      expect(rendered.error.message).toContain('{{assignee}}')
    }
  })

  it('fails when a known variable was not provided by the context', () => {
    const service = makeService()
    const context = fullContext()
    delete context.role
    const rendered = service.render({ name: 'plan', context })
    expect(rendered.ok).toBe(false)
    if (!rendered.ok) {
      expect(rendered.error.code).toBe('VALIDATION_FAILED')
      expect(rendered.error.message).toContain('{{role}}')
    }
  })

  it('rejects unknown template names and invalid name segments', () => {
    const service = makeService()
    for (const bad of ['nonexistent', '../etc/passwd', 'UPPER', 'a/b']) {
      const resolved = service.resolve(bad)
      expect(resolved.ok, JSON.stringify(bad)).toBe(false)
      if (!resolved.ok) {
        expect(resolved.error.code).toBe('VALIDATION_FAILED')
      }
    }
  })

  it('refuses to inject context values that look like secrets', () => {
    const service = makeService()
    const context = fullContext()
    context.task.description = 'Use the key sk-projSecret123 to call the API.'
    const rendered = service.render({ name: 'implement', context })
    expect(rendered.ok).toBe(false)
    if (!rendered.ok) {
      expect(rendered.error.code).toBe('VALIDATION_FAILED')
      expect(rendered.error.message).toContain('task.description')
      // The error message must not leak the secret value itself.
      expect(rendered.error.message).not.toContain('sk-projSecret123')
    }
  })

  it('refuses a repo-local template that smuggles a literal secret into the prompt', () => {
    const { repoRoot, writeOverride } = makeRepo()
    writeOverride('fix', 'Authenticate with ghp_exampletoken123 then fix {{task.title}}.')
    const service = makeService()

    const rendered = service.render({ name: 'fix', context: fullContext() }, repoRoot)
    expect(rendered.ok).toBe(false)
    if (!rendered.ok) {
      expect(rendered.error.code).toBe('VALIDATION_FAILED')
      expect(rendered.error.message).toContain('secret')
    }
  })

  it('lists templates with their source, including repo-local extras', () => {
    const { repoRoot, writeOverride } = makeRepo()
    writeOverride('review', 'TEAM REVIEW: {{task.title}}')
    writeOverride('security-audit', 'AUDIT: {{task.title}}')
    const service = makeService()

    const listed = service.listTemplates(repoRoot)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const byName = new Map(listed.data.map((info) => [info.name, info]))
    expect(byName.get('review')?.source).toBe('repo-local')
    expect(byName.get('review')?.path).toBe(join(repoRoot, '.teskra', 'prompts', 'review.md'))
    expect(byName.get('plan')?.source).toBe('builtin')
    expect(byName.get('security-audit')?.source).toBe('repo-local')
    expect(listed.data).toHaveLength(BUILT_IN_PROMPT_TEMPLATES.length + 1)
  })

  it('lists only built-in templates without a repo root', () => {
    const service = makeService()
    const listed = service.listTemplates()
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.data.map((info) => info.name).sort()).toEqual(
        [...BUILT_IN_PROMPT_TEMPLATES].sort(),
      )
      expect(listed.data.every((info) => info.source === 'builtin')).toBe(true)
    }
  })
})
