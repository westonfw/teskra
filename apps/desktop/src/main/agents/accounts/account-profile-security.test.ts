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
  const runtime: WorkspaceRuntime = {
    ref: { kind: 'wsl', distro: 'Ubuntu' },
    hostNative: true,
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
    validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: true } }),
  }

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
})
