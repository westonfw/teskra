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

  it('does not recurse forever on cyclic structures', () => {
    const cyclic: Record<string, unknown> = { token: 'x' }
    cyclic['self'] = cyclic
    const redacted = redactSecrets(cyclic) as Record<string, unknown>
    expect(redacted['token']).toBe(REDACTED)
    expect(redacted['self']).toBe(redacted)
  })
})
