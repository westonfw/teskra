import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { IpcResult, WorkflowDefinition, WorkflowDefinitionFileInfo } from '@teskra/contracts'
import { validateWorkflowDefinition } from '@teskra/shared'

import { type InternalAppError, toPublicError } from '../errors'
import type { TeskraPaths } from '../paths'

/**
 * WorkflowDefinitionLoader (TASK-055; plan §153 / ADR-0005).
 *
 * Workflow definitions are hand-written, repo-local files under
 * `<repo>/.teskra/workflows/` — they are committed with the repo and never
 * written back by the UI. Both `.yaml` / `.yml` and `.json` files are
 * accepted.
 *
 * YAML support: the dependency tree has no YAML parser, and adding one is a
 * deliberate, separate decision. JSON is a subset of YAML 1.2, so a `.yaml`
 * file whose content is JSON parses today; full YAML block syntax is
 * rejected with a precise error until the `yaml` package is adopted.
 *
 * Every candidate file goes through `validateWorkflowDefinition`
 * (@teskra/shared): shape, duplicate ids, dangling dependsOn, acyclicity,
 * conditional-edge cross-check, and per-iteration runOn connectivity. An
 * invalid file is never silently dropped from `list` — it is reported with
 * `status: 'invalid'` and the rejection reasons.
 */

const WORKFLOW_FILE_EXTENSIONS = ['.yaml', '.yml', '.json'] as const

export interface WorkflowDefinitionLoader {
  /** Every workflow file under the repo, loaded or rejected with reasons. */
  list(repoRoot: string): IpcResult<readonly WorkflowDefinitionFileInfo[]>
  /** Loads one definition by id; invalid or unknown ids are rejected. */
  load(repoRoot: string, definitionId: string): IpcResult<WorkflowDefinition>
}

export interface WorkflowDefinitionLoaderDeps {
  readonly paths: TeskraPaths
  /** File read seam for tests; defaults to node:fs (utf-8, throws ENOENT). */
  readonly readFile?: (path: string) => string
  /** Directory listing seam for tests; defaults to node:fs (throws ENOENT). */
  readonly listDir?: (path: string) => readonly string[]
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function isMissingFile(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function createWorkflowDefinitionLoader(
  deps: WorkflowDefinitionLoaderDeps,
): WorkflowDefinitionLoader {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const listDir = deps.listDir ?? ((path: string) => readdirSync(path))

  const loadFile = (path: string): IpcResult<WorkflowDefinitionFileInfo> => {
    let raw: string
    try {
      raw = readFile(path)
    } catch (cause) {
      return fail({
        code: 'UNKNOWN',
        message: 'Failed to read a workflow definition file.',
        retryable: true,
        detail: `read ${path}`,
        cause,
      })
    }

    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (cause) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: `Workflow definition file "${path}" is not parseable.`,
        retryable: false,
        detail: `parse ${path}: only the JSON subset of YAML is supported (no YAML parser dependency yet)`,
        cause,
      })
    }

    const validated = validateWorkflowDefinition(json)
    if (!validated.ok) {
      // Best-effort id so `load` can name the invalid file by definition id.
      const id =
        typeof json === 'object' && json !== null && 'id' in json && typeof json.id === 'string'
          ? json.id
          : undefined
      return {
        ok: true,
        data: {
          path,
          status: 'invalid',
          ...(id === undefined ? {} : { id }),
          issues: validated.issues.map((issue) => issue.message),
        },
      }
    }
    return {
      ok: true,
      data: {
        path,
        status: 'loaded',
        id: validated.definition.id,
        definition: validated.definition,
        issues: [],
      },
    }
  }

  const list = (repoRoot: string): IpcResult<readonly WorkflowDefinitionFileInfo[]> => {
    const directory = deps.paths.repoWorkflowsDir(repoRoot)
    let entries: readonly string[]
    try {
      entries = listDir(directory)
    } catch (cause) {
      // A repo without .teskra/workflows/ simply has no workflow definitions.
      if (isMissingFile(cause)) {
        return { ok: true, data: [] }
      }
      return fail({
        code: 'UNKNOWN',
        message: 'Failed to list the repo-local workflow definitions.',
        retryable: true,
        detail: `readdir ${directory}`,
        cause,
      })
    }

    const infos: WorkflowDefinitionFileInfo[] = []
    for (const entry of entries) {
      if (!WORKFLOW_FILE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        continue
      }
      const loaded = loadFile(join(directory, entry))
      if (!loaded.ok) {
        return loaded
      }
      infos.push(loaded.data)
    }
    return { ok: true, data: infos }
  }

  return {
    list,

    load(repoRoot, definitionId) {
      const listed = list(repoRoot)
      if (!listed.ok) {
        return listed
      }
      const invalidMatch = listed.data.find(
        (info) => info.status === 'invalid' && info.id === definitionId,
      )
      for (const info of listed.data) {
        if (info.status === 'loaded' && info.definition?.id === definitionId) {
          return { ok: true, data: info.definition }
        }
      }
      if (invalidMatch !== undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Workflow definition "${definitionId}" is invalid and cannot be loaded.`,
          retryable: false,
          detail: `${invalidMatch.path}: ${invalidMatch.issues.join('; ')}`,
        })
      }
      return fail({
        code: 'VALIDATION_FAILED',
        message: `Workflow definition "${definitionId}" was not found.`,
        retryable: false,
        detail: `${deps.paths.repoWorkflowsDir(repoRoot)} contains no definition with id ${JSON.stringify(definitionId)}`,
      })
    },
  }
}
