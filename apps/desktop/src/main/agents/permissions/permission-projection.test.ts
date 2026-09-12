import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TeskraPermissionProfile } from '@teskra/contracts'

import { createDefaultAgentRegistry } from '../agent-registry'
import { CLAUDE_AGENT } from '../definitions/claude'
import { CODEX_AGENT } from '../definitions/codex'
import { FAKE_AGENT } from '../definitions/fake'
import {
  AGENT_PERMISSION_MAPPINGS,
  CLAUDE_PERMISSION_MAPPING,
  CODEX_PERMISSION_MAPPING,
  prepareAgentPermission,
  permissionProfileForApprovalMode,
} from './permission-projection'

const homes: string[] = []

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teskra-permission-projection-'))
  homes.push(dir)
  return dir
}

function profile(approvalMode: TeskraPermissionProfile['approvalMode']): TeskraPermissionProfile {
  return permissionProfileForApprovalMode('test-agent', approvalMode)
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('built-in Agent permission capability declarations (TASK-077)', () => {
  it('every built-in Agent declares a permissionEnforcement mode', () => {
    const registry = createDefaultAgentRegistry(true)
    if (!registry.ok) throw new Error(registry.error.message)
    for (const definition of registry.data.list()) {
      expect(['native', 'config', 'none']).toContain(definition.permissionEnforcement)
    }
  })

  it('every enforceable built-in Agent has a projection mapping; none-agents have none', () => {
    const registry = createDefaultAgentRegistry(true)
    if (!registry.ok) throw new Error(registry.error.message)
    for (const definition of registry.data.list()) {
      const mapping = AGENT_PERMISSION_MAPPINGS.get(definition.id)
      if (definition.permissionEnforcement === 'none') {
        expect(mapping).toBeUndefined()
      } else {
        expect(mapping?.buildArgs).toBeTypeOf('function')
      }
    }
  })
})

describe('Codex permission projection (TASK-077)', () => {
  it('projects read-only to a read-only sandbox with on-request approval', () => {
    expect(CODEX_PERMISSION_MAPPING.buildArgs?.(profile('read-only'))).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
    ])
  })

  it('projects manual and safe-auto to workspace-write with on-request approval', () => {
    for (const mode of ['manual', 'safe-auto'] as const) {
      expect(CODEX_PERMISSION_MAPPING.buildArgs?.(profile(mode))).toEqual([
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'on-request',
      ])
    }
  })

  it('projects full-auto to workspace-write without approval prompts', () => {
    expect(CODEX_PERMISSION_MAPPING.buildArgs?.(profile('full-auto'))).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
    ])
  })

  it('never emits a rule-list config Codex cannot enforce', () => {
    const prepared = prepareAgentPermission({
      definition: CODEX_AGENT,
      profile: { ...profile('manual'), allow: ['git status'], deny: ['rm'] },
      runDir: runDir(),
    })
    expect(prepared).toEqual({
      ok: true,
      data: { profile: expect.objectContaining({ approvalMode: 'manual' }) },
    })
    if (prepared.ok) expect(prepared.data?.configPath).toBeUndefined()
  })
})

describe('Claude Code permission projection (TASK-077)', () => {
  it('maps every approval mode to a valid Claude --permission-mode', () => {
    const expected = {
      'read-only': 'plan',
      manual: 'default',
      'safe-auto': 'acceptEdits',
      'full-auto': 'bypassPermissions',
    } as const
    for (const [mode, claudeMode] of Object.entries(expected)) {
      const args = CLAUDE_PERMISSION_MAPPING.buildArgs?.(
        profile(mode as TeskraPermissionProfile['approvalMode']),
      )
      expect(args).toEqual(['--permission-mode', claudeMode])
    }
  })

  it('links the generated settings file via --settings when a config path exists', () => {
    expect(
      CLAUDE_PERMISSION_MAPPING.buildArgs?.(profile('manual'), '/run/permission-settings.json'),
    ).toEqual(['--permission-mode', 'default', '--settings', '/run/permission-settings.json'])
  })

  it('builds a settings.json permissions document matching the profile', () => {
    expect(
      CLAUDE_PERMISSION_MAPPING.buildConfig?.({
        ...profile('safe-auto'),
        allow: ['Bash(npm test)'],
        deny: ['Bash(rm *)'],
      }),
    ).toEqual({
      kind: 'claude-code-settings',
      document: {
        permissions: {
          defaultMode: 'acceptEdits',
          allow: ['Bash(npm test)'],
          deny: ['Bash(rm *)'],
        },
      },
    })
  })

  it('omits empty rule lists from the settings document', () => {
    expect(CLAUDE_PERMISSION_MAPPING.buildConfig?.(profile('read-only'))?.document).toEqual({
      permissions: { defaultMode: 'plan' },
    })
  })

  it('writes the settings file into the run directory before launch', () => {
    const dir = runDir()
    const prepared = prepareAgentPermission({
      definition: CLAUDE_AGENT,
      profile: { ...profile('manual'), deny: ['Bash(git push *)'] },
      runDir: dir,
    })
    if (!prepared.ok) throw new Error(prepared.error.message)
    const configPath = prepared.data?.configPath
    expect(configPath).toBe(join(dir, 'permission-settings.json'))
    expect(JSON.parse(readFileSync(configPath as string, 'utf8'))).toEqual({
      permissions: { defaultMode: 'default', deny: ['Bash(git push *)'] },
    })
  })
})

describe('unconstrainable Agents (TASK-077)', () => {
  it('generates no config and no args for a permissionEnforcement=none Agent', () => {
    const dir = runDir()
    const prepared = prepareAgentPermission({
      definition: FAKE_AGENT,
      profile: profile('full-auto'),
      runDir: dir,
    })
    expect(prepared).toEqual({ ok: true, data: undefined })
    expect(readdirSync(dir)).toEqual([])
  })

  it('generates nothing for an enforceable Agent without a registered mapping', () => {
    const dir = runDir()
    const prepared = prepareAgentPermission({
      definition: { ...CODEX_AGENT, id: 'unmapped-agent' },
      profile: profile('manual'),
      runDir: dir,
    })
    expect(prepared).toEqual({ ok: true, data: undefined })
    expect(readdirSync(dir)).toEqual([])
  })
})
