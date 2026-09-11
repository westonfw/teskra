import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CreateMemoryRequest,
  IpcResult,
  ListMemoriesRequest,
  Memory,
  MemoryIdRequest,
  MemoryType,
  UpdateMemoryRequest,
  Workspace,
} from '@teskra/contracts'
import { memoryTypeSchema } from '@teskra/contracts'

import type { MemoryRepository } from '../db/repositories/memory-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import { containsSecretValue } from '../redact'

/**
 * MemoryManager (TASK-067, plan §45/§46) — the Workspace Memory domain
 * service on top of MemoryRepository.
 *
 * - Every Memory is bound to a Workspace (`workspace_id` FK, CASCADE).
 * - Manual CRUD goes to the `memories` table; `create`/`update` refuse
 *   content that matches the TASK-004 redact secret patterns — memories are
 *   injected into prompts, so a leaked token here would reach an Agent CLI.
 * - Repo-local markdown files under `<repo>/.teskra/memory/` (committable,
 *   team-shared) are merged into `list` as read-only records with
 *   `file:<name>` ids; `update`/`delete` on them fail with
 *   VALIDATION_FAILED. The file's type comes from a leading frontmatter
 *   block (`---\ntype: architecture\n---`) when present, otherwise from the
 *   plan §45 file-name convention (architecture.md, conventions.md,
 *   decisions.md, commands.md, known-issues.md, preferences.md), falling
 *   back to 'summary'. Files containing secret-shaped values are skipped
 *   with a warning rather than surfaced.
 */

/** Ids/sources of repo-local records; also blocks `file:` ids from CRUD. */
const FILE_SOURCE_PREFIX = 'file:'

const logger = getLogger('memory')

/** plan §45 file-name convention → MemoryType (frontmatter wins). */
const FILE_NAME_TYPES: Readonly<Record<string, MemoryType>> = {
  architecture: 'architecture',
  conventions: 'convention',
  convention: 'convention',
  decisions: 'decision',
  decision: 'decision',
  commands: 'command',
  command: 'command',
  'known-issues': 'known_issue',
  known_issue: 'known_issue',
  preferences: 'preference',
  preference: 'preference',
  summary: 'summary',
}

export interface MemoryManager {
  list(request: ListMemoriesRequest): IpcResult<Memory[]>
  get(request: MemoryIdRequest): IpcResult<Memory | null>
  create(request: CreateMemoryRequest): IpcResult<Memory>
  update(request: UpdateMemoryRequest): IpcResult<Memory | null>
  delete(request: MemoryIdRequest): IpcResult<boolean>
}

export interface MemoryManagerDeps {
  readonly memory: MemoryRepository
  readonly workspaces: WorkspaceRepository
  readonly paths: TeskraPaths
  readonly createId?: () => string
  readonly now?: () => string
  /** File read seam for tests; defaults to node:fs (utf-8, throws ENOENT). */
  readonly readFile?: (path: string) => string
  /** Directory listing seam for tests; defaults to node:fs (throws ENOENT). */
  readonly listDir?: (path: string) => readonly string[]
  /** Mtime seam for tests; defaults to node:fs statSync (throws ENOENT). */
  readonly modifiedAt?: (path: string) => string
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

function secretRefusal<T>(operation: string): IpcResult<T> {
  return invalid(
    'Refusing to store the memory: its content looks like a secret.',
    `MemoryManager ${operation} rejected content matching a secret pattern (see redact.ts)`,
  )
}

function readOnlyRefusal<T>(id: string): IpcResult<T> {
  return invalid(
    `Memory "${id}" comes from a repo-local file and is read-only; edit the markdown file in the repository instead.`,
    `attempted to mutate repo-local memory id=${JSON.stringify(id)}`,
  )
}

interface ParsedMemoryFile {
  readonly type: MemoryType
  readonly content: string
}

/** Frontmatter `type:` wins; otherwise the file-name convention, else 'summary'. */
export function parseMemoryFile(fileName: string, raw: string): ParsedMemoryFile {
  let body = raw
  let frontmatterType: MemoryType | undefined
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (frontmatter !== null) {
    body = raw.slice(frontmatter[0].length)
    const typeLine = /^type:\s*(\S+)\s*$/m.exec(frontmatter[1] ?? '')
    if (typeLine !== null) {
      const parsed = memoryTypeSchema.safeParse(typeLine[1])
      if (parsed.success) {
        frontmatterType = parsed.data
      }
    }
  }
  const baseName = fileName.replace(/\.md$/i, '')
  return {
    type: frontmatterType ?? FILE_NAME_TYPES[baseName] ?? 'summary',
    content: body.trim(),
  }
}

export function createMemoryManager(deps: MemoryManagerDeps): MemoryManager {
  const createId = deps.createId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const listDir = deps.listDir ?? ((path: string) => readdirSync(path))
  const modifiedAt =
    deps.modifiedAt ?? ((path: string) => statSync(path).mtime.toISOString())

  const requireWorkspace = (workspaceId: string): IpcResult<Workspace> => {
    const workspace = deps.workspaces.getById(workspaceId)
    if (!workspace.ok) {
      return workspace
    }
    if (workspace.data === null) {
      return fail({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'The selected workspace no longer exists.',
        retryable: false,
        detail: `MemoryManager could not resolve workspace id=${JSON.stringify(workspaceId)}`,
      })
    }
    return { ok: true, data: workspace.data }
  }

  /** Reads `<repo>/.teskra/memory/*.md`; unreadable/missing dirs degrade to []. */
  const listRepoLocal = (workspaceId: string, repoRoot: string): Memory[] => {
    const directory = deps.paths.repoMemoryDir(repoRoot)
    let entries: readonly string[]
    try {
      entries = listDir(directory)
    } catch (cause) {
      if (!isMissingFile(cause)) {
        logger.warn({ cause, directory }, 'Failed to list the repo-local memory directory.')
      }
      return []
    }
    const records: Memory[] = []
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) {
        continue
      }
      const path = join(directory, entry)
      let raw: string
      let timestamp: string
      try {
        raw = readFile(path)
        timestamp = modifiedAt(path)
      } catch (cause) {
        logger.warn({ cause, path }, 'Failed to read a repo-local memory file.')
        continue
      }
      const parsed = parseMemoryFile(entry, raw)
      if (parsed.content.length === 0) {
        continue
      }
      if (containsSecretValue(parsed.content)) {
        logger.warn(
          { path },
          'Skipping a repo-local memory file: its content matches a secret pattern.',
        )
        continue
      }
      records.push({
        id: `${FILE_SOURCE_PREFIX}${entry}`,
        workspaceId,
        type: parsed.type,
        content: parsed.content,
        source: `${FILE_SOURCE_PREFIX}${path}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }
    return records
  }

  return {
    list({ workspaceId, type }) {
      const workspace = requireWorkspace(workspaceId)
      if (!workspace.ok) {
        return workspace
      }
      const stored = deps.memory.listByWorkspace(workspaceId, type)
      if (!stored.ok) {
        return stored
      }
      const repoLocal = listRepoLocal(workspaceId, workspace.data.path).filter(
        (record) => type === undefined || record.type === type,
      )
      return {
        ok: true,
        data: [...stored.data, ...repoLocal].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        ),
      }
    },

    get({ id }) {
      // Repo-local records exist only as merged list entries; their content is
      // already fully loaded there, so `get` serves database rows only.
      if (id.startsWith(FILE_SOURCE_PREFIX)) {
        return { ok: true, data: null }
      }
      return deps.memory.getById(id)
    },

    create({ workspaceId, type, content }) {
      const workspace = requireWorkspace(workspaceId)
      if (!workspace.ok) {
        return workspace
      }
      if (containsSecretValue(content)) {
        return secretRefusal('create')
      }
      return deps.memory.create({ id: createId(), workspaceId, type, content, source: 'manual' }, now())
    },

    update({ id, type, content }) {
      if (id.startsWith(FILE_SOURCE_PREFIX)) {
        return readOnlyRefusal(id)
      }
      if (content !== undefined && containsSecretValue(content)) {
        return secretRefusal('update')
      }
      return deps.memory.update(
        id,
        {
          ...(type === undefined ? {} : { type }),
          ...(content === undefined ? {} : { content }),
        },
        now(),
      )
    },

    delete({ id }) {
      if (id.startsWith(FILE_SOURCE_PREFIX)) {
        return readOnlyRefusal(id)
      }
      return deps.memory.delete(id)
    },
  }
}
