import { describe, expect, it } from 'vitest'

import { REDACTED, redactSecrets } from './redact'

describe('redactSecrets (TASK-004)', () => {
  it('masks well-known token shapes inside strings', () => {
    expect(redactSecrets('key is sk-abc123XYZ_ok')).toBe(`key is ${REDACTED}`)
    expect(redactSecrets('ghp_abcdefghij1234567890')).toBe(REDACTED)
    expect(redactSecrets('github_pat_11ABCDEFG_abcdefghijklmnopqrstuvwxyz')).toBe(REDACTED)
    expect(redactSecrets('xoxb-1234-5678-abcdef')).toBe(REDACTED)
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(REDACTED)
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ')).toBe(REDACTED)
  })

  it('redacts values of secret-looking keys at any depth', () => {
    const input = {
      env: { GITHUB_TOKEN: 'plain-value', NESTED: { api_key: 'plain-value' } },
      password: 'hunter2',
      list: [{ clientSecret: 's3cr3t' }],
    }
    const redacted = redactSecrets(input) as Record<string, unknown>
    expect(JSON.stringify(redacted)).not.toContain('plain-value')
    expect(JSON.stringify(redacted)).not.toContain('hunter2')
    expect(JSON.stringify(redacted)).not.toContain('s3cr3t')
    const env = redacted['env'] as Record<string, unknown>
    expect(env['GITHUB_TOKEN']).toBe(REDACTED)
  })

  it('masks token shapes embedded in otherwise ordinary values', () => {
    const input = { command: 'curl -H "Authorization: Bearer sk-livekey123" https://api.example' }
    const redacted = redactSecrets(input) as { command: string }
    expect(redacted.command).not.toContain('sk-livekey123')
    expect(redacted.command).toContain('curl -H')
  })

  it('leaves non-secret content untouched', () => {
    const input = {
      runId: 'run-42',
      count: 7,
      ok: true,
      nothing: null,
      message: 'task completed without issues',
    }
    expect(redactSecrets(input)).toEqual(input)
  })

  it('serializes Error instances instead of dropping their message and stack', () => {
    const redacted = redactSecrets({ runId: 'r1', cause: new Error('spawn failed') }) as {
      cause: Record<string, unknown>
    }
    expect(redacted['cause']).toMatchObject({ name: 'Error', message: 'spawn failed' })
    expect(typeof redacted['cause']['stack']).toBe('string')
  })

  it('still redacts secrets inside an Error message and stack', () => {
    const error = new Error('auth failed for ghp_leakedtoken000')
    const redacted = redactSecrets({ cause: error }) as { cause: Record<string, unknown> }
    expect(JSON.stringify(redacted)).not.toContain('ghp_leakedtoken000')
  })

  it('does not mangle ordinary hyphenated words containing "sk-"', () => {
    for (const word of ['task-manager', 'flask-app', 'disk-image', 'mask-based', 'desk-top']) {
      expect(redactSecrets(`working on ${word} now`)).toBe(`working on ${word} now`)
    }
  })

  it('still masks sk- tokens at string boundaries after the word guard', () => {
    expect(redactSecrets('key is sk-abc123XYZ_ok')).toBe(`key is ${REDACTED}`)
    expect(redactSecrets('"sk-abc123XYZ_ok"')).toBe(`"${REDACTED}"`)
    expect(redactSecrets('sk-abc123XYZ_ok')).toBe(REDACTED)
  })

  it('does not recurse forever on cyclic structures', () => {
    const cyclic: Record<string, unknown> = { token: 'x' }
    cyclic['self'] = cyclic
    const redacted = redactSecrets(cyclic) as Record<string, unknown>
    expect(redacted['token']).toBe(REDACTED)
    expect(redacted['self']).toBe(redacted)
  })
})
