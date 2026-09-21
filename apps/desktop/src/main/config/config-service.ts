import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  DEFAULT_CONFIG,
  teskraConfigLayerSchema,
  teskraConfigSchema,
  type ConfigLayerName,
  type ConfigSources,
  type ConfigWarning,
  type ResolvedConfig,
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
 *   workspace <repo>/.teskra/config.json    (可提交 → secret-scanned;
 *                                             global-only groups stripped)
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

export interface ResolveConfigOptions {
  /** Loads the workspace layer from the repo at this workspace's path. */
  readonly workspaceId?: string | undefined
  /** Task / Run override layer (validated against teskraConfigLayerSchema). */
  readonly override?: unknown
}

export interface ConfigService {
  resolve(options?: ResolveConfigOptions): IpcResult<ResolvedConfig>
  /** Deep-merges a validated patch into the private global config layer. */
  updateGlobal(patch: unknown): IpcResult<ResolvedConfig>
  /** Deep-merges a validated, secret-free patch into a repo-local layer. */
  updateWorkspace(workspaceId: string, patch: unknown): IpcResult<ResolvedConfig>
}

export interface ConfigServiceDeps {
  readonly paths: TeskraPaths
  /** Maps workspaceId → repo path for the workspace layer. */
  readonly workspaces?: Pick<WorkspaceRepository, 'getById'>
  /** File read seam for tests; defaults to node:fs (utf-8, throws ENOENT). */
  readonly readFile?: (path: string) => string
  /** Atomic file-write seam for tests. The default creates the data root. */
  readonly writeFile?: (path: string, contents: string) => void
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, path)
  } catch (cause) {
    rmSync(temporaryPath, { force: true })
    throw cause
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Keys a merge layer must never set. `result[key] = value` with key
 * `__proto__` would mutate the result's prototype instead of adding an own
 * property; `constructor` / `prototype` are skipped with it so a hostile or
 * corrupted config JSON cannot smuggle prototype-chain keys through the
 * merge. deepMerge already returns a fresh object (no global prototype
 * pollution, P2-19) — skipping these keys makes that safety explicit instead
 * of depending on non-obvious reasoning.
 */
const DANGEROUS_MERGE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Deep merge: plain objects recurse; arrays and scalars replace wholesale.
 * Exported for direct unit tests (P2-19 dangerous-key guard).
 */
export function deepMerge(
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined || DANGEROUS_MERGE_KEYS.has(key)) {
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
 * Config groups that only the private global layer (and caller overrides)
 * may set. The workspace layer is a committable file controlled by the repo
 * author: `agents.executableOverrides` points Agent executables at arbitrary
 * paths, so loading it from `<repo>/.teskra/config.json` would be RCE on
 * "open repo + run agent" (docs/code-review-2026-09-12.md P0-3). Other
 * groups carry no executable/path references, so they stay workspace-writable.
 * Exception: WORKSPACE_SAFE_AGENT_FIELDS names the individual agents fields
 * the workspace layer may still set (TASK-134).
 */
const GLOBAL_ONLY_GROUPS = ['agents'] as const

/**
 * TASK-134 (Milestone 26 §6): fields inside a global-only group that the
 * workspace layer may still set. `agents.defaultAgent` is a plain
 * AgentDefinition.id — no executable path, no secret — so a committable
 * repo config naming the team's default Agent carries no RCE risk, unlike
 * `agents.executableOverrides` (P0-3).
 */
const WORKSPACE_SAFE_AGENT_FIELDS = ['defaultAgent'] as const

/**
 * Picks the workspace-safe fields out of an `agents` group object; anything
 * else is stripped by the caller with a warning.
 */
function pickWorkspaceSafeAgentFields(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {}
  const kept: Record<string, unknown> = {}
  for (const field of WORKSPACE_SAFE_AGENT_FIELDS) {
    if (field in value) kept[field] = value[field]
  }
  return kept
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

/**
 * Removes global-only groups (see GLOBAL_ONLY_GROUPS) from raw repo-local
 * config JSON. Runs alongside stripSecrets on the workspace layer so the
 * resolved config can never take `agents.*` from a committable file — even
 * if a future caller passes `resolve({ workspaceId })` to agent detection.
 * Workspace-safe fields (WORKSPACE_SAFE_AGENT_FIELDS) survive the strip.
 */
function stripGlobalOnlyGroups(layer: Record<string, unknown>): {
  sanitized: Record<string, unknown>
  warnings: ConfigWarning[]
} {
  const warnings: ConfigWarning[] = []
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(layer)) {
    if ((GLOBAL_ONLY_GROUPS as readonly string[]).includes(key)) {
      // TASK-134: workspace-safe fields of the agents group survive; the rest
      // of the group stays global-only.
      const kept = key === 'agents' ? pickWorkspaceSafeAgentFields(value) : {}
      const stripped = isPlainObject(value)
        ? Object.keys(value).filter((field) => !(field in kept))
        : []
      if (stripped.length > 0 || !isPlainObject(value)) {
        warnings.push({
          layer: 'workspace',
          fieldPath: key,
          message: `Group "${key}" is global-only and was not loaded from the repo-local config (it can point Agent executables at arbitrary paths; set it in the private global config instead).`,
        })
      }
      if (Object.keys(kept).length > 0) {
        clean[key] = kept
      }
      continue
    }
    clean[key] = value
  }
  return { sanitized: clean, warnings }
}

export function createConfigService(deps: ConfigServiceDeps): ConfigService {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const writeFile = deps.writeFile ?? atomicWriteFile

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
    // generic "unknown key" rejection. Global-only groups (agents.*) are
    // stripped here too — same trust boundary, same warning mechanism.
    if (options.scanSecrets === true && isPlainObject(json)) {
      const { sanitized, warnings: secretWarnings } = stripSecrets(json)
      for (const warning of secretWarnings) {
        report(warnings, warning, { path })
      }
      const groups = stripGlobalOnlyGroups(sanitized)
      for (const warning of groups.warnings) {
        report(warnings, warning, { path })
      }
      json = groups.sanitized
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

  const writeLayerFile = (
    layer: 'global' | 'workspace',
    path: string,
    patch: unknown,
  ): IpcResult<void> => {
    if (layer === 'workspace' && isPlainObject(patch)) {
      const globalOnly = Object.keys(patch).filter((key) => {
        if (!(GLOBAL_ONLY_GROUPS as readonly string[]).includes(key)) return false
        // TASK-134: an agents patch carrying only workspace-safe fields
        // (defaultAgent) is allowed; any other agents field stays rejected.
        if (key === 'agents') {
          const value: unknown = patch[key]
          if (!isPlainObject(value)) return true
          const kept = pickWorkspaceSafeAgentFields(value)
          return Object.keys(value).some((field) => !(field in kept))
        }
        return true
      })
      if (globalOnly.length > 0) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message:
              'Workspace config cannot contain global-only groups; set them in the global config instead.',
            retryable: false,
            detail: globalOnly.join(', '),
          }),
        }
      }
      const scan = stripSecrets(patch)
      if (scan.warnings.length > 0) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: 'Workspace config cannot contain sensitive values.',
            retryable: false,
            detail: scan.warnings.map((warning) => warning.fieldPath).join(', '),
          }),
        }
      }
    }

    const parsedPatch = teskraConfigLayerSchema.safeParse(patch)
    if (!parsedPatch.success) {
      return {
        ok: false,
        error: toPublicError({
          code: 'VALIDATION_FAILED',
          message: `Invalid ${layer} config update.`,
          retryable: false,
          detail: `${layer} patch: ${JSON.stringify(parsedPatch.error.issues)}`,
        }),
      }
    }

    let current: TeskraConfigLayer = {}
    try {
      const raw = readFile(path)
      const json: unknown = JSON.parse(raw)
      const parsedCurrent = teskraConfigLayerSchema.safeParse(json)
      if (!parsedCurrent.success) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: `The existing ${layer} config is invalid and was not overwritten.`,
            retryable: false,
            detail: `${layer} config ${path}: ${JSON.stringify(parsedCurrent.error.issues)}`,
          }),
        }
      }
      current = parsedCurrent.data
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return {
          ok: false,
          error: toPublicError({
            code: code === undefined ? 'VALIDATION_FAILED' : 'UNKNOWN',
            message:
              code === undefined
                ? `The existing ${layer} config is not valid JSON and was not overwritten.`
                : `Failed to read the ${layer} config before updating it.`,
            retryable: false,
            detail: `${layer} config ${path}`,
            cause,
          }),
        }
      }
    }

    const merged = deepMerge(current, parsedPatch.data)
    const validated = teskraConfigLayerSchema.safeParse(merged)
    if (!validated.success) {
      return {
        ok: false,
        error: toPublicError({
          code: 'VALIDATION_FAILED',
          message: `The merged ${layer} config is invalid.`,
          retryable: false,
          detail: `merged ${layer} config: ${JSON.stringify(validated.error.issues)}`,
        }),
      }
    }

    try {
      writeFile(path, `${JSON.stringify(validated.data, null, 2)}\n`)
    } catch (cause) {
      return {
        ok: false,
        error: toPublicError({
          code: 'UNKNOWN',
          message: `Failed to save the ${layer} config.`,
          retryable: true,
          detail: `write ${layer} config ${path}`,
          cause,
        }),
      }
    }
    return { ok: true, data: undefined }
  }

  const service: ConfigService = {
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
          } else if (workspace.data.trustLevel !== 'trusted') {
            // TASK-118 (code-review P0-3): the repo-local config layer is
            // repo-controlled content; it only loads for trusted workspaces.
            report(
              warnings,
              {
                layer: 'workspace',
                message:
                  'The workspace is restricted; the repo-local config layer was not loaded (trust the workspace to enable it).',
                kind: 'workspace-restricted',
              },
              { workspaceId: options.workspaceId },
            )
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

    updateGlobal(patch) {
      const written = writeLayerFile('global', deps.paths.config(), patch)
      if (!written.ok) return written
      return service.resolve()
    },

    updateWorkspace(workspaceId, patch) {
      if (deps.workspaces === undefined) {
        return {
          ok: false,
          error: toPublicError({
            code: 'CAPABILITY_NOT_AVAILABLE',
            message: 'Workspace configuration is not available.',
            retryable: false,
            detail: 'ConfigService has no WorkspaceRepository',
          }),
        }
      }
      const workspace = deps.workspaces.getById(workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) {
        return {
          ok: false,
          error: toPublicError({
            code: 'WORKSPACE_NOT_FOUND',
            message: 'The selected workspace no longer exists.',
            retryable: false,
            detail: `workspaceId=${workspaceId}`,
          }),
        }
      }
      const written = writeLayerFile('workspace', deps.paths.repoConfig(workspace.data.path), patch)
      if (!written.ok) return written
      return service.resolve({ workspaceId })
    },
  }

  return service
}
