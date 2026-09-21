import type {
  AgentDefinition,
  AgentHealth,
  AgentRole,
  IpcResult,
  ResolveRunDefaultsRequest,
  ResolvedRunDefaults,
  RunDefaultReason,
  TeskraConfig,
  WorkflowRunDefaults,
  Workspace,
} from '@teskra/contracts'

import type { ConfigService } from '../config/config-service'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import { type InternalAppError, toPublicError } from '../errors'
import type { AccountProfileManager } from './accounts/account-profile-manager'
import type { AgentHealthManager } from './agent-health-manager'
import type { AgentRegistry } from './agent-registry'

/**
 * TASK-134 (Milestone 26 §6) — DefaultSelectionService: explainable run
 * defaults for the thread-first quick-start input.
 *
 * `agentType` falls back through five levels, each one recorded in
 * `reasons` so the UI can show why the value was picked:
 *
 *   1. `config.agents.defaultAgent` (global / workspace layer);
 *   2. the Agent of this Workspace's most recent successful Run;
 *   3. among installed AND healthy Agents (AgentHealth excluding
 *      `unavailable` / `rate-limited`, TASK-024) whose `defaults.role`
 *      matches the requested role (default 'implementer'), the highest
 *      `routing.priority`;
 *   4. among any installed Agents, the highest `routing.priority`;
 *   5. none → VALIDATION_FAILED (the UI links to Settings → Agents).
 *
 * Levels 1–2 are unconditional picks (an explicit configuration / proven
 * history wins over a probe); health gating starts at level 3 per the
 * acceptance criteria. A configured or historical Agent id that is no
 * longer registered is skipped — Agent ids always come from the
 * AgentRegistry, never hardcoded.
 *
 * The account / execution profile ids follow the selected Agent
 * (AccountProfileManager.getDefault + config.agents.defaultExecutionProfiles);
 * `mode` / `executionMode` / `approvalMode` / `isolation` are fixed by the
 * thread-mode hard constraints (exec only, orchestrated + worktree,
 * safe-auto).
 */

/** Renderer dictionary keys (`runDefaults.reason.*` in en-US / zh-CN). */
export const RUN_DEFAULT_REASON_KEYS = {
  agentConfigured: 'runDefaults.reason.agent.configured',
  agentLastSuccessfulRun: 'runDefaults.reason.agent.lastSuccessfulRun',
  agentRoleMatch: 'runDefaults.reason.agent.roleMatch',
  agentInstalledFallback: 'runDefaults.reason.agent.installedFallback',
  accountProfileDefault: 'runDefaults.reason.accountProfile.default',
  accountProfileNone: 'runDefaults.reason.accountProfile.none',
  executionProfileDefault: 'runDefaults.reason.executionProfile.default',
  executionProfileNone: 'runDefaults.reason.executionProfile.none',
  modeFixed: 'runDefaults.reason.mode.fixed',
  executionModeFixed: 'runDefaults.reason.executionMode.fixed',
  approvalModeFixed: 'runDefaults.reason.approvalMode.fixed',
  isolationFixed: 'runDefaults.reason.isolation.fixed',
} as const

export interface DefaultSelectionService {
  resolveDefaults(request: ResolveRunDefaultsRequest): Promise<IpcResult<ResolvedRunDefaults>>
  /** Workflow launcher defaults (design doc §6, consumed by TASK-137). */
  resolveWorkflowDefaults(workspaceId: string): Promise<IpcResult<WorkflowRunDefaults>>
}

export interface DefaultSelectionServiceDeps {
  readonly registry: Pick<AgentRegistry, 'has' | 'list'>
  readonly health: Pick<AgentHealthManager, 'list'>
  readonly runs: Pick<AgentRunRepository, 'findLastSuccessfulByWorkspace'>
  readonly accounts: Pick<AccountProfileManager, 'getDefault'>
  readonly config: Pick<ConfigService, 'resolve'>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

/**
 * Healthy for default selection: installed, available, and not rate-limited
 * (the `unavailable` / `rate-limited` exclusions of the acceptance criteria).
 */
function isHealthy(health: AgentHealth | undefined): boolean {
  return health !== undefined && health.installed && health.available && health.rateLimited !== true
}

/** Highest routing.priority first; missing priority = 0; id tiebreak keeps the pick deterministic. */
function byPriorityDesc(left: AgentDefinition, right: AgentDefinition): number {
  const delta = (right.routing?.priority ?? 0) - (left.routing?.priority ?? 0)
  return delta !== 0 ? delta : left.id.localeCompare(right.id)
}

interface SelectionContext {
  readonly workspace: Workspace
  readonly config: TeskraConfig
  readonly healthById: ReadonlyMap<string, AgentHealth>
}

interface AgentSelection {
  readonly agentType: string
  readonly reason: RunDefaultReason
}

export function createDefaultSelectionService(
  deps: DefaultSelectionServiceDeps,
): DefaultSelectionService {
  const loadContext = async (workspaceId: string): Promise<IpcResult<SelectionContext>> => {
    const workspace = deps.workspaces.getById(workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return fail({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'The selected workspace no longer exists.',
        retryable: false,
        detail: `workspaceId=${workspaceId}`,
      })
    }
    const resolved = deps.config.resolve({ workspaceId })
    if (!resolved.ok) return resolved
    const health = await deps.health.list({ runtime: workspace.data.runtime })
    if (!health.ok) return health
    const healthById = new Map<string, AgentHealth>()
    for (const entry of health.data) {
      if (!healthById.has(entry.agentId)) healthById.set(entry.agentId, entry)
    }
    return {
      ok: true,
      data: { workspace: workspace.data, config: resolved.data.config, healthById },
    }
  }

  const selectAgent = (
    context: SelectionContext,
    role: AgentRole,
    lastSuccessfulAgentType: string | undefined,
  ): AgentSelection | undefined => {
    const definitions = deps.registry.list()
    // Level 1: configured default.
    const configured = context.config.agents.defaultAgent
    if (configured !== null && deps.registry.has(configured)) {
      return {
        agentType: configured,
        reason: { key: RUN_DEFAULT_REASON_KEYS.agentConfigured, params: { agent: configured } },
      }
    }
    // Level 2: this workspace's most recent successful Run.
    if (lastSuccessfulAgentType !== undefined && deps.registry.has(lastSuccessfulAgentType)) {
      return {
        agentType: lastSuccessfulAgentType,
        reason: {
          key: RUN_DEFAULT_REASON_KEYS.agentLastSuccessfulRun,
          params: { agent: lastSuccessfulAgentType },
        },
      }
    }
    // Level 3: role-matched, installed and healthy, highest priority.
    const roleMatched = definitions
      .filter(
        (definition) =>
          definition.defaults.role === role && isHealthy(context.healthById.get(definition.id)),
      )
      .sort(byPriorityDesc)
    const rolePick = roleMatched[0]
    if (rolePick !== undefined) {
      return {
        agentType: rolePick.id,
        reason: {
          key: RUN_DEFAULT_REASON_KEYS.agentRoleMatch,
          params: { agent: rolePick.id, role },
        },
      }
    }
    // Level 4: any installed Agent, highest priority.
    const installed = definitions
      .filter((definition) => context.healthById.get(definition.id)?.installed === true)
      .sort(byPriorityDesc)
    const fallback = installed[0]
    if (fallback !== undefined) {
      return {
        agentType: fallback.id,
        reason: {
          key: RUN_DEFAULT_REASON_KEYS.agentInstalledFallback,
          params: { agent: fallback.id },
        },
      }
    }
    return undefined
  }

  const noAgentAvailable = <T>(workspaceId: string): IpcResult<T> =>
    fail({
      code: 'VALIDATION_FAILED',
      message:
        'No installed Agent is available. Install an Agent under Settings → Agents, then try again.',
      retryable: false,
      detail: `workspaceId=${workspaceId}: every fallback level exhausted`,
    })

  const buildDefaults = async (
    context: SelectionContext,
    selection: AgentSelection,
  ): Promise<IpcResult<ResolvedRunDefaults>> => {
    const reasons: RunDefaultReason[] = [selection.reason]

    const account = await deps.accounts.getDefault(selection.agentType)
    if (!account.ok) return account
    reasons.push(
      account.data === undefined
        ? {
            key: RUN_DEFAULT_REASON_KEYS.accountProfileNone,
            params: { agent: selection.agentType },
          }
        : {
            key: RUN_DEFAULT_REASON_KEYS.accountProfileDefault,
            params: { agent: selection.agentType, profileId: account.data },
          },
    )

    const executionProfileId =
      context.config.agents.defaultExecutionProfiles[selection.agentType] ?? undefined
    reasons.push(
      executionProfileId === undefined
        ? {
            key: RUN_DEFAULT_REASON_KEYS.executionProfileNone,
            params: { agent: selection.agentType },
          }
        : {
            key: RUN_DEFAULT_REASON_KEYS.executionProfileDefault,
            params: { agent: selection.agentType, profileId: executionProfileId },
          },
    )

    reasons.push(
      { key: RUN_DEFAULT_REASON_KEYS.modeFixed, params: { mode: 'exec' } },
      {
        key: RUN_DEFAULT_REASON_KEYS.executionModeFixed,
        params: { executionMode: 'orchestrated' },
      },
      { key: RUN_DEFAULT_REASON_KEYS.approvalModeFixed, params: { approvalMode: 'safe-auto' } },
      { key: RUN_DEFAULT_REASON_KEYS.isolationFixed, params: { isolation: 'worktree' } },
    )

    return {
      ok: true,
      data: {
        agentType: selection.agentType,
        ...(account.data === undefined ? {} : { accountProfileId: account.data }),
        ...(executionProfileId === undefined ? {} : { executionProfileId }),
        mode: 'exec',
        executionMode: 'orchestrated',
        approvalMode: 'safe-auto',
        isolation: 'worktree',
        reasons,
      },
    }
  }

  return {
    async resolveDefaults(request) {
      const context = await loadContext(request.workspaceId)
      if (!context.ok) return context

      const lastSuccessful = deps.runs.findLastSuccessfulByWorkspace(request.workspaceId)
      if (!lastSuccessful.ok) return lastSuccessful

      const selection = selectAgent(
        context.data,
        request.role ?? 'implementer',
        lastSuccessful.data?.agentType,
      )
      if (selection === undefined) return noAgentAvailable(request.workspaceId)
      return buildDefaults(context.data, selection)
    },

    async resolveWorkflowDefaults(workspaceId) {
      const context = await loadContext(workspaceId)
      if (!context.ok) return context

      const lastSuccessful = deps.runs.findLastSuccessfulByWorkspace(workspaceId)
      if (!lastSuccessful.ok) return lastSuccessful

      const implementerSelection = selectAgent(
        context.data,
        'implementer',
        lastSuccessful.data?.agentType,
      )
      if (implementerSelection === undefined) return noAgentAvailable(workspaceId)
      const implementer = await buildDefaults(context.data, implementerSelection)
      if (!implementer.ok) return implementer

      const reviewers = deps.registry
        .list()
        .filter(
          (definition) =>
            definition.defaults.role === 'reviewer' &&
            definition.id !== implementer.data.agentType &&
            isHealthy(context.data.healthById.get(definition.id)),
        )
        .sort(byPriorityDesc)
        .map((definition) => definition.id)

      return { ok: true, data: { implementer: implementer.data, reviewers } }
    },
  }
}
