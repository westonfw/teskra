// P2-15: RELEASE_NOTES must never carry the literal "- TODO" placeholder into
// a release artifact — the 已知问题 section exists only when it has content.
import { describe, expect, it } from 'vitest'

import { buildReleaseNotes, buildVersionEnv } from './release.mjs'

const base = {
  version: '1.2.3',
  date: '2026-09-12',
  changes: '- feat: something (abc1234)',
  changesRange: 'v1.2.2..HEAD',
}

describe('buildVersionEnv (P2-16)', () => {
  it('injects TESKRA_APP_VERSION so the bundle define matches extraMetadata.version', () => {
    const env = buildVersionEnv('2.3.4', { PATH: '/usr/bin', EXISTING: '1' })
    expect(env.TESKRA_APP_VERSION).toBe('2.3.4')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.EXISTING).toBe('1')
  })

  it('overrides a stale TESKRA_APP_VERSION from the base environment', () => {
    const env = buildVersionEnv('2.3.4', { TESKRA_APP_VERSION: '0.0.0' })
    expect(env.TESKRA_APP_VERSION).toBe('2.3.4')
  })
})

describe('buildReleaseNotes (P2-15)', () => {
  it('omits the 已知问题 section when no known issues are supplied', () => {
    const notes = buildReleaseNotes({ ...base, knownIssues: undefined })
    expect(notes).not.toContain('已知问题')
    expect(notes).not.toContain('TODO')
    expect(notes).toContain('# Teskra v1.2.3 — 2026-09-12')
    expect(notes).toContain('## 变更（v1.2.2..HEAD）')
    expect(notes).toContain('## 校验')
  })

  it('omits the section for blank / whitespace-only input too', () => {
    for (const knownIssues of ['', '   ', '\n  \n']) {
      expect(buildReleaseNotes({ ...base, knownIssues })).not.toContain('已知问题')
    }
  })

  it('renders each supplied line as a bullet under 已知问题', () => {
    const notes = buildReleaseNotes({
      ...base,
      knownIssues: 'E2E job is not a merge gate yet\n- second issue',
    })
    expect(notes).toContain('## 已知问题')
    expect(notes).toContain('- E2E job is not a merge gate yet')
    expect(notes).toContain('- second issue')
  })
})
