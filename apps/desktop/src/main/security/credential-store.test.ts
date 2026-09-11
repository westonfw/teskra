import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTeskraPaths, type TeskraPaths } from '../paths'
import {
  createCredentialStore,
  createUnavailableCipher,
  plainEnvValues,
  resolveEnvReferences,
  resolveEnvReferencesBestEffort,
  workspaceEnvCredentialKey,
  type CredentialCipher,
} from './credential-store'

// Warning logs from the best-effort resolver are intentional; keep pino quiet.
process.env['TESKRA_LOG_LEVEL'] = 'fatal'

/** Deterministic stand-in for safeStorage: reversibly "encrypts" via base64. */
function mockCipher(available = true): CredentialCipher {
  return {
    isAvailable: () => available,
    encrypt: (plaintext) => {
      if (!available) throw new Error('cipher unavailable')
      return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`
    },
    decrypt: (ciphertext) => Buffer.from(ciphertext.slice('enc:'.length), 'base64').toString('utf8'),
  }
}

let tempHome: string
let paths: TeskraPaths

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'teskra-credentials-'))
  paths = createTeskraPaths({ TESKRA_HOME: tempHome })
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('CredentialStore (TASK-088)', () => {
  it('round-trips set/get/list/delete with only ciphertext on disk', () => {
    const store = createCredentialStore({ paths, cipher: mockCipher() })
    expect(store.isAvailable()).toBe(true)

    expect(store.set('OPENAI_API_KEY', 'sk-test-secret-123')).toEqual({ ok: true, data: undefined })
    expect(store.set('workspace/ws-1/GITHUB_TOKEN', 'ghp_testsecret')).toEqual({
      ok: true,
      data: undefined,
    })

    expect(store.get('OPENAI_API_KEY')).toEqual({ ok: true, data: 'sk-test-secret-123' })
    expect(store.get('workspace/ws-1/GITHUB_TOKEN')).toEqual({ ok: true, data: 'ghp_testsecret' })
    expect(store.get('NOPE')).toEqual({ ok: true, data: null })

    // list exposes key names only.
    expect(store.list()).toEqual({
      ok: true,
      data: ['OPENAI_API_KEY', 'workspace/ws-1/GITHUB_TOKEN'],
    })

    // The persisted file carries ciphertext only — never the plaintext value.
    const onDisk = readFileSync(paths.credentials(), 'utf8')
    expect(onDisk).not.toContain('sk-test-secret-123')
    expect(onDisk).not.toContain('ghp_testsecret')
    expect(onDisk).toContain('enc:')

    expect(store.delete('OPENAI_API_KEY')).toEqual({ ok: true, data: true })
    expect(store.delete('OPENAI_API_KEY')).toEqual({ ok: true, data: false })
    expect(store.get('OPENAI_API_KEY')).toEqual({ ok: true, data: null })
  })

  it('refuses to persist when encryption is unavailable — explicit degrade, no plaintext file', () => {
    const store = createCredentialStore({ paths, cipher: createUnavailableCipher() })
    expect(store.isAvailable()).toBe(false)

    const result = store.set('OPENAI_API_KEY', 'sk-test-secret-123')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      code: 'CAPABILITY_NOT_AVAILABLE',
      message:
        'This environment cannot securely store secrets; sensitive values will not be persisted.',
      retryable: false,
    })
    expect(existsSync(paths.credentials())).toBe(false)
    expect(store.list()).toEqual({ ok: true, data: [] })
  })

  it('cannot decrypt while the cipher is unavailable', () => {
    const writer = createCredentialStore({ paths, cipher: mockCipher() })
    expect(writer.set('OPENAI_API_KEY', 'sk-test-secret-123').ok).toBe(true)

    const reader = createCredentialStore({ paths, cipher: mockCipher(false) })
    const result = reader.get('OPENAI_API_KEY')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
  })

  it('rejects invalid keys and reports a corrupted store file without throwing', () => {
    const store = createCredentialStore({ paths, cipher: mockCipher() })
    const invalid = store.set('BAD KEY', 'value')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_FAILED')

    writeFileSync(paths.credentials(), '{ not json')
    const loaded = store.list()
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.error.code).toBe('UNKNOWN')
  })
})

describe('workspace env secret references (TASK-088)', () => {
  it('builds stable per-workspace store keys', () => {
    expect(workspaceEnvCredentialKey('ws-1', 'OPENAI_API_KEY')).toBe(
      'workspace/ws-1/OPENAI_API_KEY',
    )
  })

  it('resolves refs back to plaintext for process launch', () => {
    const store = createCredentialStore({ paths, cipher: mockCipher() })
    const ref = workspaceEnvCredentialKey('ws-1', 'OPENAI_API_KEY')
    expect(store.set(ref, 'sk-test-secret-123').ok).toBe(true)

    const resolved = resolveEnvReferences(
      { PLAIN_VAR: 'plain', OPENAI_API_KEY: { secretRef: ref } },
      store,
    )
    expect(resolved).toEqual({
      ok: true,
      data: { PLAIN_VAR: 'plain', OPENAI_API_KEY: 'sk-test-secret-123' },
    })
  })

  it('fails explicitly when a ref cannot be resolved', () => {
    const store = createCredentialStore({ paths, cipher: mockCipher() })
    const ref = workspaceEnvCredentialKey('ws-1', 'OPENAI_API_KEY')

    const missing = resolveEnvReferences({ OPENAI_API_KEY: { secretRef: ref } }, store)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('VALIDATION_FAILED')

    const noCipher = resolveEnvReferences(
      { OPENAI_API_KEY: { secretRef: ref } },
      createCredentialStore({ paths, cipher: createUnavailableCipher() }),
    )
    expect(noCipher.ok).toBe(false)
    if (!noCipher.ok) expect(noCipher.error.code).toBe('CAPABILITY_NOT_AVAILABLE')

    const noStore = resolveEnvReferences({ OPENAI_API_KEY: { secretRef: ref } }, undefined)
    expect(noStore.ok).toBe(false)
    if (!noStore.ok) expect(noStore.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
  })

  it('best-effort resolution keeps plain values and omits unresolvable secrets', () => {
    const store = createCredentialStore({ paths, cipher: mockCipher() })
    const ref = workspaceEnvCredentialKey('ws-1', 'OPENAI_API_KEY')
    const env = { PLAIN_VAR: 'plain', OPENAI_API_KEY: { secretRef: ref } }

    expect(resolveEnvReferencesBestEffort(env, store, {})).toEqual({ PLAIN_VAR: 'plain' })
    expect(plainEnvValues(env)).toEqual({ PLAIN_VAR: 'plain' })
  })
})
