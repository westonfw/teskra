import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  promptTemplateNameSchema,
  type PromptTemplateContext,
  type PromptTemplateInfo,
  type PromptTemplateSource,
  type RenderedPrompt,
} from '@teskra/contracts'
import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import type { TeskraPaths } from '../paths'
import { containsSecretValue } from '../redact'

import fixTemplate from '../../../resources/prompts/fix.md?raw'
import implementTemplate from '../../../resources/prompts/implement.md?raw'
import planTemplate from '../../../resources/prompts/plan.md?raw'
import reviewTemplate from '../../../resources/prompts/review.md?raw'
import testTemplate from '../../../resources/prompts/test.md?raw'

/**
 * PromptTemplateService (TASK-079, teskra-tasks.md; plan §102 / ADR-0005).
 *
 * Templates are externalized, never hardcoded:
 *
 *   built-in  apps/desktop/resources/prompts/{plan,implement,review,fix,test}.md
 *             (bundled inline via Vite `?raw` imports — same mechanism as the
 *             SQL migrations — so dev, tests and the packaged build all load
 *             them identically)
 *   override  <repo>/.teskra/prompts/<name>.md  (committable, team-shared)
 *
 * Renderable variables: {{task.title}}, {{task.description}}, {{criteria}},
 * {{role}}, {{memory}} (the ContextBuilder-packed Workspace Memory section,
 * TASK-068 — callers that do not wire a ContextBuilder render it as an empty
 * string), {{previousHandoff}}, {{env.TESKRA_HANDOFF_PATH}},
 * {{env.TESKRA_ARTIFACT_DIR}}. A template referencing an unknown or
 * unprovided variable fails with VALIDATION_FAILED naming the variables —
 * `{{...}}` is never left in the output silently.
 *
 * Secret hygiene: context values that match the TASK-004 redact secret
 * patterns are refused (not redacted — a rejected render beats a leaked
 * prompt), and the fully rendered output is scanned once more as a backstop
 * so a committable repo-local template cannot smuggle a literal secret into
 * the prompt either.
 */

const BUILT_IN_TEMPLATES: Readonly<Record<string, string>> = {
  plan: planTemplate,
  implement: implementTemplate,
  review: reviewTemplate,
  fix: fixTemplate,
  test: testTemplate,
}

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g
const LEFTOVER_PATTERN = /\{\{[^{}]*\}\}/

export interface ResolvedPromptTemplate {
  readonly name: string
  readonly source: PromptTemplateSource
  readonly path?: string
  readonly content: string
}

export interface PromptTemplateService {
  /** Lists built-in templates plus repo-local templates, with their source. */
  listTemplates(repoRoot?: string): IpcResult<readonly PromptTemplateInfo[]>
  /** Resolves the effective template: repo-local override wins over built-in. */
  resolve(name: string, repoRoot?: string): IpcResult<ResolvedPromptTemplate>
  render(
    request: { name: string; context: PromptTemplateContext },
    repoRoot?: string,
  ): IpcResult<RenderedPrompt>
}

export interface PromptTemplateServiceDeps {
  readonly paths: TeskraPaths
  /** File read seam for tests; defaults to node:fs (utf-8, throws ENOENT). */
  readonly readFile?: (path: string) => string
  /** Directory listing seam for tests; defaults to node:fs (throws ENOENT). */
  readonly listDir?: (path: string) => readonly string[]
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

function isMissingFile(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Builds the renderable variable map; undefined = known but not provided. */
function buildVariables(context: PromptTemplateContext): Record<string, string | undefined> {
  return {
    'task.title': context.task.title,
    'task.description': context.task.description,
    criteria:
      context.criteria === undefined || context.criteria.length === 0
        ? '_No acceptance criteria provided._'
        : context.criteria.map((criterion) => `- ${criterion}`).join('\n'),
    role: context.role,
    memory: context.memory ?? '',
    previousHandoff: context.previousHandoff ?? '',
    'env.TESKRA_HANDOFF_PATH': context.env.TESKRA_HANDOFF_PATH,
    'env.TESKRA_ARTIFACT_DIR': context.env.TESKRA_ARTIFACT_DIR,
  }
}

export function createPromptTemplateService(
  deps: PromptTemplateServiceDeps,
): PromptTemplateService {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const listDir = deps.listDir ?? ((path: string) => readdirSync(path))

  /** Reads the repo-local override; null = absent, error = unreadable. */
  const readOverride = (
    name: string,
    repoRoot: string,
  ): IpcResult<{ path: string; content: string } | null> => {
    const path = join(deps.paths.repoPromptsDir(repoRoot), `${name}.md`)
    try {
      return { ok: true, data: { path, content: readFile(path) } }
    } catch (cause) {
      if (isMissingFile(cause)) {
        return { ok: true, data: null }
      }
      return fail({
        code: 'UNKNOWN',
        message: `Failed to read the repo-local prompt template "${name}".`,
        retryable: true,
        detail: `read ${path}`,
        cause,
      })
    }
  }

  const resolve = (name: string, repoRoot?: string): IpcResult<ResolvedPromptTemplate> => {
    if (!promptTemplateNameSchema.safeParse(name).success) {
      return invalid(
        `Invalid prompt template name ${JSON.stringify(name)}.`,
        `name must match ^[a-z][a-z0-9-]*$, got ${JSON.stringify(name)}`,
      )
    }
    if (repoRoot !== undefined) {
      const override = readOverride(name, repoRoot)
      if (!override.ok) {
        return override
      }
      if (override.data !== null) {
        return {
          ok: true,
          data: { name, source: 'repo-local', path: override.data.path, content: override.data.content },
        }
      }
    }
    const builtin = BUILT_IN_TEMPLATES[name]
    if (builtin === undefined) {
      return invalid(
        `Unknown prompt template "${name}".`,
        `no built-in or repo-local template named ${JSON.stringify(name)}`,
      )
    }
    return { ok: true, data: { name, source: 'builtin', content: builtin } }
  }

  return {
    resolve,

    listTemplates(repoRoot) {
      const infos: PromptTemplateInfo[] = []
      const seen = new Set<string>()

      for (const name of Object.keys(BUILT_IN_TEMPLATES)) {
        seen.add(name)
        if (repoRoot !== undefined) {
          const override = readOverride(name, repoRoot)
          if (!override.ok) {
            return override
          }
          if (override.data !== null) {
            infos.push({ name, source: 'repo-local', path: override.data.path })
            continue
          }
        }
        infos.push({ name, source: 'builtin' })
      }

      if (repoRoot !== undefined) {
        let entries: readonly string[]
        try {
          entries = listDir(deps.paths.repoPromptsDir(repoRoot))
        } catch (cause) {
          if (isMissingFile(cause)) {
            entries = []
          } else {
            return fail({
              code: 'UNKNOWN',
              message: 'Failed to list the repo-local prompt templates.',
              retryable: true,
              detail: `readdir ${deps.paths.repoPromptsDir(repoRoot)}`,
              cause,
            })
          }
        }
        for (const entry of entries) {
          if (!entry.endsWith('.md')) {
            continue
          }
          const name = entry.slice(0, -'.md'.length)
          if (seen.has(name) || !promptTemplateNameSchema.safeParse(name).success) {
            continue
          }
          seen.add(name)
          infos.push({
            name,
            source: 'repo-local',
            path: join(deps.paths.repoPromptsDir(repoRoot), entry),
          })
        }
      }

      return { ok: true, data: infos }
    },

    render({ name, context }, repoRoot) {
      const template = resolve(name, repoRoot)
      if (!template.ok) {
        return template
      }

      const variables = buildVariables(context)

      for (const [key, value] of Object.entries(variables)) {
        if (value !== undefined && containsSecretValue(value)) {
          return invalid(
            `Refusing to render the prompt: variable "${key}" looks like a secret.`,
            `prompt context variable ${JSON.stringify(key)} matched a secret pattern (see redact.ts)`,
          )
        }
      }

      const unknown = new Set<string>()
      for (const match of template.data.content.matchAll(PLACEHOLDER_PATTERN)) {
        const key = match[1]
        if (key !== undefined && variables[key] === undefined) {
          unknown.add(key)
        }
      }
      if (unknown.size > 0) {
        const names = [...unknown].map((key) => `{{${key}}}`).join(', ')
        return invalid(
          `Prompt template "${name}" references unknown or unprovided variable(s): ${names}.`,
          `template ${template.data.path ?? `${name} (built-in)`}: unresolved placeholders ${names}`,
        )
      }

      const content = template.data.content.replace(
        PLACEHOLDER_PATTERN,
        (_placeholder, key: string) => variables[key] ?? '',
      )

      const leftover = LEFTOVER_PATTERN.exec(content)
      if (leftover !== null) {
        return invalid(
          `Prompt template "${name}" contains a malformed placeholder ${JSON.stringify(leftover[0])}.`,
          `template ${template.data.path ?? `${name} (built-in)`}: leftover ${leftover[0]}`,
        )
      }

      if (containsSecretValue(content)) {
        return invalid(
          'Refusing to use the rendered prompt: it contains a secret-shaped value.',
          `rendered template ${template.data.path ?? `${name} (built-in)`} matched a secret pattern (see redact.ts)`,
        )
      }

      return {
        ok: true,
        data: {
          name: template.data.name,
          source: template.data.source,
          ...(template.data.path === undefined ? {} : { path: template.data.path }),
          content,
        },
      }
    },
  }
}
