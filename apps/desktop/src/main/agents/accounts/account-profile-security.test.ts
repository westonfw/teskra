import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  agentAccountProfileSchema,
  credentialStoreStatusSchema,
  IPC_CHANNELS,
  workflowDefinitionSchema,
  type AgentDetectionResult,
  type AgentStartRequest,
} from '@teskra/contracts'

import type { ProcessManager } from '../../process/process-manager'
import type { WorkspaceRuntime } from '../../workspace/runtime'
import type { AgentDetector } from '../agent-detector'
import { agentProcessId } from '../adapters/cli-agent-adapter'
import { createClaudeAdapter } from '../adapters/claude-adapter'
import { createProfileAliasManager } from '../profile-alias-manager'
import { assertNoReservedEnvKeys } from './reserved-env-keys'

/**
 * TASK-114 (design §58) — Account Profile Security Tests.
 *
 * This file is the §58 checklist hub. Items whose behavior is module-local
 * live next to their module; they are cited here so the checklist stays
 * auditable in one place:
 *
 *  1. Profile A secret/config never injected into Profile B
 *     — adapter level: accounts/adapters/codex-account-profile-adapter.test.ts
 *       ("projects different profiles into different CODEX_HOME values"),
 *       accounts/adapters/claude-account-profile-adapter.test.ts (same for
 *       CLAUDE_CONFIG_DIR);
 *     — launch level: agents/agent-manager-account-profiles.test.ts
 *       ("projects CODEX_HOME into the ProcessManager env", "runs two
 *       DIFFERENT profiles of the same agent in parallel", and the §58
 *       cross-profile isolation test added there by TASK-114).
 *  2. configHome path traversal blocked (create / update / delete)
 *     — accounts/account-profile-manager.test.ts: slug pattern rejections
 *       (incl. TASK-114's traversal slugs), smuggled configHome update
 *       rejection (§48.1), host-native + WSL mid-chain symlink escapes on
 *       create (§48.2), symlinked-home delete refusal (§48.2).
 *  3. symlink pointing outside the root rejected
 *     — same file: "refuses all profile writes when the agent-profiles root
 *       is a symlink" (host-native + distro) plus the TASK-114 create/delete
 *       symlink cases.
 *  4. external profile home is never deleted
 *     — same file: "deleteHome is unavailable for external profiles" and the
 *       TASK-114 on-disk hardening test.
 *  5. renderer cannot read credential content — THIS FILE (static assertions
 *     over the preload surface, IPC channel inventory, and contracts shapes).
 *  6. repo workflow cannot carry credentialRef / apiKey — THIS FILE
 *     (workflowDefinitionSchema strictObject rejections, §55).
 *  7. untrusted workspace auto-execution restricted (TASK-118)
 *     — config/config-service.test.ts (repo config layer skipped),
 *       runtime/compose.test.ts (repo-local workflow definitions + aliases
 *       gated on trust), workflows/dispatch-service.test.ts +
 *       workflows/full-workflow-service.test.ts (repo-local prompt/full.yaml
 *       overrides ignored), workflows/shell-confirmation.test.ts +
 *       workflows/shell-step-executor.test.ts (requireConfirmation gate).
 *  8. §13.2 reserved keys, four lines
 *     — workspace.env / request.environment rejected AND logged:
 *       agents/agent-manager-account-profiles.test.ts (TASK-114 added the
 *       log assertions);
 *     — workflow node env rejected AND logged:
 *       workflows/workflow-engine-profiles.test.ts (TASK-114 added the log
 *       assertion; the log call itself was the missing piece, fixed in
 *       agents/profile-alias-manager.ts);
 *     — profile env written LAST even when the rejection is bypassed:
 *       agents/agent-manager-account-profiles.test.ts (codex) and THIS FILE
 *       (claude, §13.1 slot order is shared in adapters/cli-agent-adapter.ts).
 *     — P0-1 (code-review-2026-09-21 §2): all four lines compare keys
 *       CASE-INSENSITIVELY — a lowercase `codex_home` smuggled past an
 *       exact-case check wins the Windows env lookup (node-pty does not
 *       dedupe; first case-insensitive match wins). THIS FILE covers the
 *       shared rejection check, the workflow third line, and the adapter's
 *       conflicting-key stripping; process/process-manager-env.test.ts covers
 *       the ProcessManager spawn-env defense plus the real node-pty
 *       [Windows 验证] reproduction.
 *  9. WSL env isolation (CODEX_HOME / CLAUDE_CONFIG_DIR enter WSLENV without
 *     /p; values never rewritten by resolveRuntimePath)
 *     — accounts/adapters/codex-account-profile-adapter.test.ts and
 *       accounts/adapters/claude-account-profile-adapter.test.ts
 *       ("declares … in WSLENV without the /p flag", "passes a WSL configHome
 *       into env verbatim — never rewritten to /mnt/c/…").
 */

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', '..', '..')

// ---------------------------------------------------------------------------
// §58 (6): a repo workflow cannot carry credentials (§55)
// ---------------------------------------------------------------------------

describe('workflow definitions cannot carry credentials (§55/§58)', () => {
  const validDefinition = {
    id: 'w',
    steps: [{ id: 'impl', type: 'agent', agent: 'codex' }],
  }

  it('accepts a clean definition (control)', () => {
    expect(workflowDefinitionSchema.safeParse(validDefinition).success).toBe(true)
  })

  it.each(['credentialRef', 'apiKey', 'oauthToken', 'token', 'secret'])(
    'rejects a definition-level %j field',
    (field) => {
      const parsed = workflowDefinitionSchema.safeParse({ ...validDefinition, [field]: 'x' })
      expect(parsed.success).toBe(false)
    },
  )

  it.each(['credentialRef', 'apiKey', 'oauthToken', 'token'])(
    'rejects an agent node carrying %j',
    (field) => {
      const parsed = workflowDefinitionSchema.safeParse({
        id: 'w',
        steps: [{ id: 'impl', type: 'agent', agent: 'codex', [field]: 'acct_123' }],
      })
      expect(parsed.success).toBe(false)
    },
  )

  it.each(['credentialRef', 'apiKey'])('rejects a shell node carrying %j', (field) => {
    const parsed = workflowDefinitionSchema.safeParse({
      id: 'w',
      steps: [{ id: 'build', type: 'shell', command: 'make', [field]: 'x' }],
    })
    expect(parsed.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §58 (5): the renderer cannot read credential / profile-home content
// ---------------------------------------------------------------------------

describe('renderer credential isolation (§58)', () => {
  const preloadSource = readFileSync(join(srcDir, 'preload/index.ts'), 'utf8')

  it('the preload bridge never touches the filesystem or profile-home files', () => {
    expect(preloadSource).not.toMatch(/\breadFile(?:Sync)?\b/)
    expect(preloadSource).not.toContain('auth.json')
    expect(preloadSource).not.toContain('.credentials')
    expect(preloadSource).not.toContain('configHome')
    expect(preloadSource).not.toMatch(/safeStorage/i)
  })

  it('the preload account namespace exposes exactly the audited channel set', () => {
    const referenced = [
      ...new Set(
        [...preloadSource.matchAll(/IPC_CHANNELS\.(account\w+)/g)].map((match) => match[1]),
      ),
    ].sort()
    expect(referenced).toEqual(
      [
        'accountAliasBind',
        'accountAliasList',
        'accountAliasUnbind',
        'accountCreate',
        'accountDetect',
        'accountDisable',
        'accountEnable',
        'accountGet',
        'accountList',
        'accountLoginCancel',
        'accountLoginResize',
        'accountLoginStart',
        'accountLoginWrite',
        'accountRemove',
        'accountSetDefault',
        'accountUpdate',
      ].sort(),
    )
  })

  it('no IPC channel reads credential values or profile-home file content', () => {
    for (const [key, name] of Object.entries(IPC_CHANNELS)) {
      // Credential store (TASK-088): status / set / delete / list only — there
      // is deliberately no get/read channel returning plaintext.
      expect(key, `channel ${name}`).not.toMatch(/credential(get|read|value)/i)
      // Account domain: no channel returns file content from a profile home.
      expect(key, `channel ${name}`).not.toMatch(/account.*(file|content|credential|auth)/i)
    }
    // Lock the credential surface to exactly the four audited channels.
    const credentialChannels = Object.keys(IPC_CHANNELS).filter((key) =>
      key.startsWith('credential'),
    )
    expect(credentialChannels.sort()).toEqual([
      'credentialDelete',
      'credentialList',
      'credentialSet',
      'credentialStatus',
    ])
  })

  it('the public account profile shape has no slot for secret material', () => {
    const base = {
      id: 'p1',
      agentId: 'codex',
      name: 'Work',
      authType: 'subscription',
      runtime: { kind: 'windows' },
      status: 'ready',
      enabled: true,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
    }
    expect(agentAccountProfileSchema.safeParse(base).success).toBe(true)
    // strictObject: smuggled credential payloads never survive the contract.
    for (const field of ['authJson', 'credentials', 'accessToken', 'apiKey']) {
      expect(agentAccountProfileSchema.safeParse({ ...base, [field]: 'secret' }).success).toBe(
        false,
      )
    }
  })

  it('the credential store status shape carries availability only, never a value', () => {
    expect(credentialStoreStatusSchema.safeParse({ available: true }).success).toBe(true)
    expect(
      credentialStoreStatusSchema.safeParse({ available: true, value: 'sk-live' }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §58 (8) fourth line: profile env is written LAST — claude variant (§13.1).
// The codex variant lives in agents/agent-manager-account-profiles.test.ts;
// both go through the shared slot order in adapters/cli-agent-adapter.ts.
// ---------------------------------------------------------------------------

describe('profile env wins over smuggled env even when §13.2 is bypassed (§13.1, claude)', () => {
  const makeRuntime = (ref: WorkspaceRuntime['ref'], hostNative = true): WorkspaceRuntime => ({
    ref,
    hostNative,
    resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
    resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: [] } }),
    resolveCwd: (path) => path,
    resolveHostPath: (path) => ({ ok: true, data: path }),
    resolveDataRoot: () => '/home/test',
    resolveAgentProfilesRoot: () => '/home/test/agent-profiles',
    resolveAgentProfileHome: (agentId, slug) => ({
      ok: true,
      data: `/home/test/agent-profiles/${agentId}/${slug}`,
    }),
    validate: () => ({ ok: true, data: { kind: ref.kind, hostNative: true } }),
  })
  const runtime = makeRuntime({ kind: 'wsl', distro: 'Ubuntu' })

  const PROFILE_HOME = '/home/test/agent-profiles/claude/work'

  function dependencies() {
    const starts: Parameters<ProcessManager['start']>[0][] = []
    const processes: Pick<ProcessManager, 'start' | 'write' | 'resize' | 'stop'> = {
      start: (request) => {
        starts.push(request)
        return {
          ok: true as const,
          data: {
            id: agentProcessId('run-claude-security'),
            pid: 4343,
            workspaceId: request.workspaceId,
            agentRunId: 'run-claude-security',
            startedAt: '2026-09-14T00:00:00.000Z',
          },
        }
      },
      write: vi.fn(() => ({ ok: true as const, data: undefined })),
      resize: vi.fn(() => ({ ok: true as const, data: undefined })),
      stop: vi.fn(async () => ({
        ok: true as const,
        data: {
          stage: 'interrupt' as const,
          exit: { processId: agentProcessId('run-claude-security'), exitCode: 0 },
        },
      })),
    }
    const detection: AgentDetectionResult = {
      agentId: 'claude',
      runtime: runtime.ref,
      installed: true,
      executable: 'claude',
      version: '2.1.236 (Claude Code)',
      overridden: false,
      fromCache: false,
      checkedAt: '2026-09-14T00:00:00.000Z',
    }
    const detector: Pick<AgentDetector, 'detect' | 'getExecutableOverride'> = {
      detect: vi.fn(async () => ({ ok: true as const, data: detection })),
      getExecutableOverride: vi.fn(() => ({ ok: true as const, data: null })),
    }
    return { processes, detector, starts }
  }

  it('CLAUDE_CONFIG_DIR from workspace.env / request.environment is overwritten by the profile', async () => {
    const deps = dependencies()
    const claude = createClaudeAdapter({
      processes: deps.processes,
      detector: deps.detector,
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })
    const request: AgentStartRequest = {
      runId: 'run-claude-security',
      workspace: {
        id: 'workspace-1',
        name: 'Demo',
        runtime: runtime.ref,
        path: '/repo',
        trustLevel: 'trusted',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
        // Bypass of the §13.2 rejection — this is what the slot order defends.
        env: { CLAUDE_CONFIG_DIR: '/attacker/workspace' },
      },
      environment: { CLAUDE_CONFIG_DIR: '/attacker/request' },
      profileEnvironment: { CLAUDE_CONFIG_DIR: PROFILE_HOME },
      approvalMode: 'read-only',
    }

    const started = await claude.start(request)

    expect(started.ok).toBe(true)
    expect(deps.starts).toHaveLength(1)
    const env = deps.starts[0]?.env
    expect(env?.CLAUDE_CONFIG_DIR).toBe(PROFILE_HOME)
    expect(env?.TESKRA_RUN_ID).toBe('run-claude-security')
  })

  // [Windows 验证] P0-1: before the fix this env object carried BOTH
  // `claude_config_dir` (smuggled, first) and `CLAUDE_CONFIG_DIR` (profile),
  // and the smuggled casing won the case-insensitive Windows lookup.
  it('on a windows runtime, case-variant smuggled keys are stripped so the profile casing is the only one present', async () => {
    const windowsRuntime = makeRuntime({ kind: 'windows' })
    const deps = dependencies()
    const claude = createClaudeAdapter({
      processes: deps.processes,
      detector: deps.detector,
      resolveRuntime: () => ({ ok: true, data: windowsRuntime }),
    })
    const request: AgentStartRequest = {
      runId: 'run-claude-security',
      workspace: {
        id: 'workspace-1',
        name: 'Demo',
        runtime: windowsRuntime.ref,
        path: '/repo',
        trustLevel: 'trusted',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
        env: { claude_config_dir: '/attacker/workspace' },
      },
      environment: { Claude_Config_Dir: '/attacker/request', teskra_run_id: 'forged' },
      profileEnvironment: { CLAUDE_CONFIG_DIR: PROFILE_HOME },
      approvalMode: 'read-only',
    }

    const started = await claude.start(request)

    expect(started.ok).toBe(true)
    expect(deps.starts).toHaveLength(1)
    const env = deps.starts[0]?.env ?? {}
    expect(env['CLAUDE_CONFIG_DIR']).toBe(PROFILE_HOME)
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toEqual([
      'CLAUDE_CONFIG_DIR',
    ])
    // The system-owned TESKRA_* keys get the same defense.
    expect(env['TESKRA_RUN_ID']).toBe('run-claude-security')
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'TESKRA_RUN_ID')).toEqual([
      'TESKRA_RUN_ID',
    ])
  })

  // WSL-on-Windows depth-in-depth (code-review-2026-09-21 §2 follow-up): the
  // request env is first set on the wsl.exe WINDOWS process and only then
  // forwarded into Linux by name via WSLENV. The wsl.exe layer resolves env
  // names case-insensitively (first match wins), so on a Windows host a WSL
  // runtime needs the same stripping as a windows runtime.
  it('on a wsl runtime on a Windows host, case-variant smuggled keys are stripped like on windows', async () => {
    const wslOnWindows = makeRuntime({ kind: 'wsl', distro: 'Ubuntu' }, /* hostNative */ false)
    const deps = dependencies()
    const claude = createClaudeAdapter({
      processes: deps.processes,
      detector: deps.detector,
      resolveRuntime: () => ({ ok: true, data: wslOnWindows }),
    })
    const request: AgentStartRequest = {
      runId: 'run-claude-security',
      workspace: {
        id: 'workspace-1',
        name: 'Demo',
        runtime: wslOnWindows.ref,
        path: '/repo',
        trustLevel: 'trusted',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
        env: { claude_config_dir: '/attacker/workspace' },
      },
      environment: { Claude_Config_Dir: '/attacker/request', teskra_run_id: 'forged' },
      profileEnvironment: { CLAUDE_CONFIG_DIR: PROFILE_HOME },
      approvalMode: 'read-only',
    }

    const started = await claude.start(request)

    expect(started.ok).toBe(true)
    expect(deps.starts).toHaveLength(1)
    const env = deps.starts[0]?.env ?? {}
    expect(env['CLAUDE_CONFIG_DIR']).toBe(PROFILE_HOME)
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toEqual([
      'CLAUDE_CONFIG_DIR',
    ])
    expect(env['TESKRA_RUN_ID']).toBe('run-claude-security')
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'TESKRA_RUN_ID')).toEqual([
      'TESKRA_RUN_ID',
    ])
  })

  // A WSL workspace on a LINUX host is the native runtime (hostNative): the
  // env is case-sensitive there, `teskra_run_id` and `TESKRA_RUN_ID` are two
  // DISTINCT variables, so the adapter must NOT drop the base key — silently
  // discarding a user variable would be wrong, and keeping it is harmless
  // because nothing case-folds it over the system key.
  it('on a wsl runtime on a Linux host, case-variant keys survive next to the profile/system keys', async () => {
    const deps = dependencies()
    const claude = createClaudeAdapter({
      processes: deps.processes,
      detector: deps.detector,
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })
    const request: AgentStartRequest = {
      runId: 'run-claude-security',
      workspace: {
        id: 'workspace-1',
        name: 'Demo',
        runtime: runtime.ref,
        path: '/repo',
        trustLevel: 'trusted',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
        env: { claude_config_dir: '/attacker/workspace' },
      },
      environment: { Claude_Config_Dir: '/attacker/request', teskra_run_id: 'forged' },
      profileEnvironment: { CLAUDE_CONFIG_DIR: PROFILE_HOME },
      approvalMode: 'read-only',
    }

    const started = await claude.start(request)

    expect(started.ok).toBe(true)
    expect(deps.starts).toHaveLength(1)
    const env = deps.starts[0]?.env ?? {}
    // The case variants are preserved as their own variables…
    expect(env['claude_config_dir']).toBe('/attacker/workspace')
    expect(env['Claude_Config_Dir']).toBe('/attacker/request')
    expect(env['teskra_run_id']).toBe('forged')
    // …while the profile/system keys still land with their own casing and value.
    expect(env['CLAUDE_CONFIG_DIR']).toBe(PROFILE_HOME)
    expect(env['TESKRA_RUN_ID']).toBe('run-claude-security')
  })
})

// ---------------------------------------------------------------------------
// P0-1 (docs/code-review-2026-09-21.md §2): reserved-key checks fold case.
// [Windows 验证] the underlying platform behavior was reproduced on
// Windows 11 with the repo's node-pty (`cmd /c echo %CODEX_HOME%` with a
// case-conflicting env block — the first case-insensitive match wins); the
// live reproduction test lives in process/process-manager-env.test.ts.
// ---------------------------------------------------------------------------

describe('§13.2 reserved keys reject case variants on every runtime (P0-1)', () => {
  const RESERVED = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']

  it.each([
    ['workspace.env', { codex_home: '/elsewhere' }],
    ['workspace.env', { CLAUDE_config_DIR: '/elsewhere' }],
    ['request.environment', { Codex_Home: '/elsewhere' }],
    ['request.environment', { claude_config_dir: '/elsewhere' }],
    ['workflow node "implement" env', { codex_home: '/elsewhere' }],
  ])('rejects %s carrying %o', (source, env) => {
    const result = assertNoReservedEnvKeys(env, source, RESERVED)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(result.error.message).toContain(source)
  })

  it('still passes env without reserved keys in any casing', () => {
    expect(assertNoReservedEnvKeys(undefined, 'workspace.env', RESERVED)).toEqual({
      ok: true,
      data: undefined,
    })
    expect(
      assertNoReservedEnvKeys({ PATH: '/bin', home: '/u', codex: 'cli' }, 'workspace.env', RESERVED)
        .ok,
    ).toBe(true)
  })
})

describe('workflow node env case variants rejected at the §13.2 third line (P0-1)', () => {
  function aliasManager() {
    // The env screen runs before any repository call, so the repositories
    // are never touched in these cases.
    return createProfileAliasManager({
      aliases: {} as never,
      accountProfiles: {} as never,
      executionProfiles: {} as never,
      reservedEnvKeys: () => ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'],
    })
  }

  it.each(['codex_home', 'Codex_Home', 'claude_config_dir', 'CLAUDE_CONFIG_DIR'])(
    'resolveAgentNodeProfiles rejects workflow env key %j',
    (key) => {
      const result = aliasManager().resolveAgentNodeProfiles({
        agentId: 'codex',
        env: { [key]: '/elsewhere' },
        source: 'workflow node "implement"',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('VALIDATION_FAILED')
      expect(result.error.message).toContain('workflow node "implement" env')
    },
  )

  it('passes clean workflow env through untouched', () => {
    expect(
      aliasManager().resolveAgentNodeProfiles({
        agentId: 'codex',
        env: { EDITOR: 'vim' },
        source: 'workflow node "implement"',
      }),
    ).toEqual({ ok: true, data: { env: { EDITOR: 'vim' } } })
  })
})
