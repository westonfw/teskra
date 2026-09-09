import { readFileSync } from 'node:fs'

import {
  DEFAULT_CONFIG,
  teskraConfigLayerSchema,
  teskraConfigSchema,
  type ConfigLayerName,
  type ConfigSources,
  type TeskraConfig,
  type TeskraConfigLayer,
} from '@teskra/contracts'
import type { IpcResult } from '@teskra/contracts'

import type { WorkspaceRepository } from '../db/repositories'
import { toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import { containsSecretValue, looksLikeSecretKey } from '../redact'

/**
 * ConfigService (TASK-080, teskra-tasks.md; plan §151 / §152 / ADR-0005).
 *
 * Four layers, later overriding earlier (objects merge recursively, arrays
 * and scalars replace wholesale):
 *
 *   default   DEFAULT_CONFIG (contracts)
 *   global    ~/.teskra/config.json         (private; Settings UI 回写)
 *   workspace <repo>/.teskra/config.json    (可提交 → secret-scanned)
 *   override  Task / Run override, supplied by the caller
 *
 * This is the ONLY module that reads config files — Managers receive a
 * ConfigService (or a resolved config) by injection. A unit test
 * (no-direct-config-reads.test.ts) guards that boundary.
 *
 * Robustness contract: resolve() never fails startup. An unreadable,
 * unparseable, or schema-invalid layer is skipped (the previous layer's
 * value wins) and reported as a structured warning naming the layer and the
 * field path. resolve() only returns an IpcResult error when the caller's
 * own `override` fails validation — that is a programming error, not a
 * file problem.
 */

export interface ConfigWarning {
  readonly layer: ConfigLayerName
  /** Dotted field path (e.g. "concurrency.maxGlobalRuns") when applicable. */
  readonly fieldPath?: string
  readonly message: string
}

export interface ResolvedConfig {
  readonly config: TeskraConfig
  /** Every leaf field's winning layer, e.g. "logging.level" → "workspace". */
  readonly sources: ConfigSources
  readonly warnings: readonly ConfigWarning[]
}

export interface ResolveConfigOptions {
  /** Loads the workspace layer from the repo at this workspace's path. */
  readonly workspaceId?: string
  /** Task / Run override layer (validated against teskraConfigLayerSchema). */
  readonly override?: unknown
}

export interface ConfigService {
  resolve(options?: ResolveConfigOptions): IpcResult<ResolvedConfig>
}

export interface ConfigServiceDeps {
  readonly paths: TeskraPaths
  /** Maps workspaceId → repo path for the workspace layer. */
  readonly workspaces?: Pick<WorkspaceRepository, 'getById'>
  /** File read seam for tests; defaults to node:fs (utf-8, throws ENOENT). */
  readonly readFile?: (path: string) => string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep merge: plain objects recurse; arrays and scalars replace wholesale. */
function deepMerge(
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) {
      continue
    }
    const existing = result[key]
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value
  }
  return result
}

/** Dotted paths of every leaf (non-plain-object) value. */
function leafPaths(value: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = []
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key
    if (isPlainObject(entry)) {
      paths.push(...leafPaths(entry, path))
    } else {
      paths.push(path)
    }
  }
  return paths
}

function getPath(value: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = value
  for (const segment of dotted.split('.')) {
    if (!isPlainObject(current)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

/** Marks every leaf the layer actually set as coming from that layer. */
function setSourceForLeaves(
  sources: ConfigSources,
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
  name: ConfigLayerName,
): void {
  for (const path of leafPaths(layer)) {
    if (getPath(target, path) !== undefined) {
      sources[path] = name
    }
  }
}

/**
 * Strips secret-looking fields from raw repo-local config JSON (plan §152:
 * no API keys / tokens / session ids in a committable file). Returns the
 * sanitized object plus one warning per stripped field. Reuses TASK-004's
 * redact patterns so "looks like a secret" means exactly one thing across
 * the codebase.
 */
function stripSecrets(layer: Record<string, unknown>): {
  sanitized: Record<string, unknown>
  warnings: ConfigWarning[]
} {
  const warnings: ConfigWarning[] = []

  const walk = (node: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      const fieldPath = prefix.length > 0 ? `${prefix}.${key}` : key
      const suspect =
        looksLikeSecretKey(key) || (typeof value === 'string' && containsSecretValue(value))
      if (suspect) {
        warnings.push({
          layer: 'workspace',
          fieldPath,
          message: `Field "${fieldPath}" looks like a secret and was not loaded from the repo-local config (secrets belong in the Credential Store, not a committable file).`,
        })
        continue
      }
      clean[key] = isPlainObject(value) ? walk(value, fieldPath) : value
    }
    return clean
  }

  return { sanitized: walk(layer, ''), warnings }
}

export function createConfigService(deps: ConfigServiceDeps): ConfigService {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))

  const report = (
    warnings: ConfigWarning[],
    warning: ConfigWarning,
    logFields: Record<string, unknown> = {},
  ): void => {
    warnings.push(warning)
    getLogger('app').warn({ ...warning, ...logFields }, warning.message)
  }

  /** Loads + validates one JSON layer file; null = layer absent or skipped. */
  const loadLayerFile = (
    layer: 'global' | 'workspace',
    path: string,
    warnings: ConfigWarning[],
    options: { scanSecrets?: boolean } = {},
  ): TeskraConfigLayer | null => {
    let raw: string
    try {
      raw = readFile(path)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      // A missing file is the normal case (layer absent), not a warning.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        report(
          warnings,
          { layer, message: `Failed to read the ${layer} config file; ignoring this layer.` },
          { path, cause: String(cause) },
        )
      }
      return null
    }

    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (cause) {
      report(
        warnings,
        { layer, message: `The ${layer} config file is not valid JSON; ignoring this layer.` },
        { path, cause: String(cause) },
      )
      return null
    }

    // Secret scanning runs on the RAW json, before schema validation:
    // a committable repo config smuggling `{"githubToken": "ghp_…"}` must
    // lose exactly that field (with a warning), not silently fall into the
    // generic "unknown key" rejection.
    if (options.scanSecrets === true && isPlainObject(json)) {
      const { sanitized, warnings: secretWarnings } = stripSecrets(json)
      for (const warning of secretWarnings) {
        report(warnings, warning, { path })
      }
      json = sanitized
    }

    const parsed = teskraConfigLayerSchema.safeParse(json)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        report(
          warnings,
          {
            layer,
            fieldPath: issue.path.join('.'),
            message: `Invalid ${layer} config field "${issue.path.join('.')}": ${issue.message}; ignoring this layer.`,
          },
          { path },
        )
      }
      return null
    }
    return parsed.data
  }

  return {
    resolve(options = {}) {
      const warnings: ConfigWarning[] = []
      const sources: ConfigSources = {}
      let merged: Record<string, unknown> = DEFAULT_CONFIG
      for (const path of leafPaths(DEFAULT_CONFIG)) {
        sources[path] = 'default'
      }

      const globalLayer = loadLayerFile('global', deps.paths.config(), warnings)
      if (globalLayer !== null) {
        merged = deepMerge(merged, globalLayer)
        setSourceForLeaves(sources, merged, globalLayer, 'global')
      }

      if (options.workspaceId !== undefined) {
        if (deps.workspaces === undefined) {
          report(warnings, {
            layer: 'workspace',
            message: 'No workspace repository configured; skipping the workspace config layer.',
          })
        } else {
          const workspace = deps.workspaces.getById(options.workspaceId)
          if (!workspace.ok) {
            return workspace
          }
          if (workspace.data === null) {
            report(warnings, {
              layer: 'workspace',
              message: `Unknown workspace "${options.workspaceId}"; skipping the workspace config layer.`,
            })
          } else {
            const layer = loadLayerFile(
              'workspace',
              deps.paths.repoConfig(workspace.data.path),
              warnings,
              { scanSecrets: true },
            )
            if (layer !== null) {
              merged = deepMerge(merged, layer)
              setSourceForLeaves(sources, merged, layer, 'workspace')
            }
          }
        }
      }

      if (options.override !== undefined) {
        const parsed = teskraConfigLayerSchema.safeParse(options.override)
        if (!parsed.success) {
          return {
            ok: false,
            error: toPublicError({
              code: 'VALIDATION_FAILED',
              message: 'Invalid Task/Run config override.',
              retryable: false,
              detail: `override: ${JSON.stringify(parsed.error.issues)}`,
            }),
          }
        }
        merged = deepMerge(merged, parsed.data)
        setSourceForLeaves(sources, merged, parsed.data, 'override')
      }

      // Complete by construction (defaults supply every field; layers only
      // replace with validated values) — parsed once as a backstop against a
      // broken DEFAULT_CONFIG.
      const final = teskraConfigSchema.safeParse(merged)
      if (!final.success) {
        return {
          ok: false,
          error: toPublicError({
            code: 'UNKNOWN',
            message: 'The built-in default configuration is invalid.',
            retryable: false,
            detail: `defaults: ${JSON.stringify(final.error.issues)}`,
          }),
        }
      }

      return { ok: true, data: { config: final.data, sources, warnings } }
    },
  }
}
