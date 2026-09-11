import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { IpcResult, WorkspaceEnvValue } from '@teskra/contracts'
import { isWorkspaceSecretRef } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'

/**
 * Credential Store (TASK-088, teskra-tasks.md; plan §60).
 *
 * Sensitive values (API keys, tokens, ...) are never persisted in SQLite,
 * workspace config, logs, audit trails, or Run directories. They are encrypted
 * through an OS-backed cipher — Electron safeStorage (DPAPI on Windows,
 * kwallet/gnome-keyring on Linux) — and only the ciphertext is written to
 * `<home>/credentials.json` (mode 0600).
 *
 * The cipher is injected at the composition root so this module stays
 * Electron-free (Runtime layer rule). When the OS provider is unavailable
 * (`safeStorage.isEncryptionAvailable() === false`, or no cipher injected)
 * the store degrades explicitly: `set` refuses with CAPABILITY_NOT_AVAILABLE
 * instead of silently falling back to plaintext.
 *
 * Log discipline: messages and error details may name credential KEYS but
 * never values; the ciphertext file is the only place a value lands on disk.
 */

export interface CredentialCipher {
  isAvailable(): boolean
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string
}

/** Fallback when no OS-backed cipher exists (tests, headless startup). */
export function createUnavailableCipher(): CredentialCipher {
  return {
    isAvailable: () => false,
    encrypt: () => {
      throw new Error('Credential cipher is unavailable.')
    },
    decrypt: () => {
      throw new Error('Credential cipher is unavailable.')
    },
  }
}

export interface CredentialStore {
  isAvailable(): boolean
  set(key: string, value: string): IpcResult<void>
  /** null when the key is unknown; an error when decryption is impossible. */
  get(key: string): IpcResult<string | null>
  delete(key: string): IpcResult<boolean>
  /** Key names only — values never leave the Main process through here. */
  list(): IpcResult<readonly string[]>
}

export interface CredentialStoreDeps {
  readonly paths: TeskraPaths
  readonly cipher: CredentialCipher
  /** File read seam for tests; defaults to node:fs (utf-8, throws ENOENT). */
  readonly readFile?: (path: string) => string
  /** Atomic file-write seam for tests. The default creates the data root. */
  readonly writeFile?: (path: string, contents: string) => void
}

interface CredentialFile {
  readonly version: 1
  readonly entries: Record<string, string>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function unavailable<T>(operation: string): IpcResult<T> {
  return fail({
    code: 'CAPABILITY_NOT_AVAILABLE',
    message:
      'This environment cannot securely store secrets; sensitive values will not be persisted.',
    retryable: false,
    detail: `Credential cipher unavailable during ${operation} (safeStorage.isEncryptionAvailable() === false)`,
  })
}

function invalidKey<T>(key: string): IpcResult<T> {
  return fail({
    code: 'VALIDATION_FAILED',
    message: 'Invalid credential key.',
    retryable: false,
    detail: `credential key must be non-empty and free of whitespace/control characters, got ${JSON.stringify(key)}`,
  })
}

function isValidKey(key: string): boolean {
  return key.length > 0 && !/[\s\p{Cc}]/u.test(key)
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

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const writeFile = deps.writeFile ?? atomicWriteFile
  const filePath = deps.paths.credentials()

  /** Missing file = empty store; unreadable/corrupt file = structured error. */
  const load = (): IpcResult<Record<string, string>> => {
    let raw: string
    try {
      raw = readFile(filePath)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ok: true, data: {} }
      }
      return fail({
        code: 'UNKNOWN',
        message: 'Failed to read the credential store.',
        retryable: true,
        detail: `read ${filePath}`,
        cause,
      })
    }
    try {
      const parsed = JSON.parse(raw) as CredentialFile
      return { ok: true, data: { ...parsed.entries } }
    } catch (cause) {
      return fail({
        code: 'UNKNOWN',
        message: 'The credential store is corrupted.',
        retryable: false,
        detail: `parse ${filePath}`,
        cause,
      })
    }
  }

  const save = (entries: Record<string, string>): IpcResult<void> => {
    try {
      writeFile(filePath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
      return { ok: true, data: undefined }
    } catch (cause) {
      return fail({
        code: 'UNKNOWN',
        message: 'Failed to write the credential store.',
        retryable: true,
        detail: `write ${filePath}`,
        cause,
      })
    }
  }

  return {
    isAvailable: () => deps.cipher.isAvailable(),

    set(key, value) {
      if (!isValidKey(key)) return invalidKey(key)
      if (!deps.cipher.isAvailable()) return unavailable('set')
      const entries = load()
      if (!entries.ok) return entries
      let ciphertext: string
      try {
        ciphertext = deps.cipher.encrypt(value)
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to encrypt the credential.',
          retryable: true,
          detail: `cipher encrypt failed for key ${JSON.stringify(key)}`,
          cause,
        })
      }
      return save({ ...entries.data, [key]: ciphertext })
    },

    get(key) {
      if (!isValidKey(key)) return invalidKey(key)
      const entries = load()
      if (!entries.ok) return entries
      const ciphertext = entries.data[key]
      if (ciphertext === undefined) return { ok: true, data: null }
      if (!deps.cipher.isAvailable()) return unavailable('get')
      try {
        return { ok: true, data: deps.cipher.decrypt(ciphertext) }
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to decrypt the credential.',
          retryable: true,
          detail: `cipher decrypt failed for key ${JSON.stringify(key)}`,
          cause,
        })
      }
    },

    delete(key) {
      if (!isValidKey(key)) return invalidKey(key)
      const entries = load()
      if (!entries.ok) return entries
      if (entries.data[key] === undefined) return { ok: true, data: false }
      const remaining = { ...entries.data }
      delete remaining[key]
      const saved = save(remaining)
      return saved.ok ? { ok: true, data: true } : saved
    },

    list() {
      const entries = load()
      return entries.ok
        ? { ok: true, data: Object.keys(entries.data).sort() }
        : entries
    },
  }
}

/** Store key for a workspace env secret, e.g. `workspace/<id>/OPENAI_API_KEY`. */
export function workspaceEnvCredentialKey(workspaceId: string, envKey: string): string {
  return `workspace/${workspaceId}/${envKey}`
}

/** The non-secret entries of a workspace env map (secret refs dropped). */
export function plainEnvValues(
  env: Readonly<Record<string, WorkspaceEnvValue>>,
): Record<string, string> {
  const plain: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isWorkspaceSecretRef(value)) {
      plain[key] = value
    }
  }
  return plain
}

/**
 * Restores a persisted workspace env map to launch-time plaintext: secret
 * refs are resolved through the Credential Store. Fails — never silently
 * drops a variable — when a ref cannot be resolved. The result is for process
 * launch only; it must never be written to disk, logs, or the audit trail.
 */
export function resolveEnvReferences(
  env: Readonly<Record<string, WorkspaceEnvValue>>,
  store: CredentialStore | undefined,
): IpcResult<Record<string, string>> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isWorkspaceSecretRef(value)) {
      resolved[key] = value
      continue
    }
    if (store === undefined || !store.isAvailable()) {
      return fail({
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: `The secret for environment variable "${key}" cannot be decrypted in this environment.`,
        retryable: false,
        detail: `credential ref ${JSON.stringify(value.secretRef)}: cipher unavailable`,
      })
    }
    const secret = store.get(value.secretRef)
    if (!secret.ok) return secret
    if (secret.data === null) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: `The stored credential for environment variable "${key}" no longer exists.`,
        retryable: false,
        detail: `credential ref ${JSON.stringify(value.secretRef)} missing from the store`,
      })
    }
    resolved[key] = secret.data
  }
  return { ok: true, data: resolved }
}

/**
 * Best-effort variant for interactive terminals: unresolvable refs are
 * omitted (with a warning naming only the key) instead of blocking the
 * terminal. Never returns plaintext-less silent success — every dropped
 * secret is logged by key name.
 */
export function resolveEnvReferencesBestEffort(
  env: Readonly<Record<string, WorkspaceEnvValue>>,
  store: CredentialStore | undefined,
  logContext: Record<string, unknown>,
): Record<string, string> {
  const resolved = resolveEnvReferences(env, store)
  if (resolved.ok) {
    return resolved.data
  }
  const plain = plainEnvValues(env)
  const dropped = Object.keys(env).filter((key) => isWorkspaceSecretRef(env[key] as WorkspaceEnvValue))
  if (dropped.length > 0) {
    getLogger('security').warn(
      { ...logContext, keys: dropped, error: resolved.error },
      'Secret environment variables could not be decrypted and were omitted.',
    )
  }
  return plain
}
