import { randomUUID } from 'node:crypto'

import type {
  AgentDefinition,
  AgentRole,
  ApprovalMode,
  CreatePermissionRuleRequest,
  IpcResult,
  ListPermissionAuditRequest,
  ListPermissionRulesRequest,
  PermissionAuditEntry,
  PermissionDecisionResult,
  PermissionNotice,
  PermissionRule,
  PermissionRuleIdRequest,
  ResolvePermissionDecisionRequest,
  ResolvePermissionProfileRequest,
  ResolvedPermissionProfile,
  UpdatePermissionRuleRequest,
  WorkbenchEvents,
} from '@teskra/contracts'

import {
  prepareAgentPermission,
  type PreparedAgentPermission,
} from '../agents/permissions/permission-projection'
import type { AgentRegistry } from '../agents/agent-registry'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { PermissionRepository } from '../db/repositories/permission-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import { classifyCommand } from './command-classifier'
import { extractExecutedCommands } from './command-extraction'

/**
 * TASK-065 — PermissionManager (ADR-0002: policy projection + audit, NO
 * pre-execution interception; Teskra is a PTY host, not a syscall gateway).
 *
 * Responsibilities:
 *  1. Rule CRUD over `permission_rules` (global ← workspace ← agent layers).
 *  2. `resolveProfile` merges the applicable rules into a
 *     TeskraPermissionProfile (deny wins on conflict) and reports `ask`
 *     downgrades as notices; `prepareRunPermission` feeds the resolved
 *     profile into the TASK-077 projection before a Run launches.
 *  3. Post-hoc audit: `agent.output` chunks are scanned for prompt lines,
 *     recognized commands are risk-labelled by the TASK-064 classifier and
 *     persisted to `permission_audit` (`detectedAt` = "recognized at", never
 *     "blocked at"). Auditing is best-effort and never blocks the Run.
 */

/** Matches a stored rule pattern against a detected command line. */
export function matchCommandPattern(pattern: string, command: string): boolean {
  const trimmed = pattern.trim()
  if (trimmed.length === 0) return false
  if (trimmed === '*') return true
  if (trimmed.endsWith('*')) return command.startsWith(trimmed.slice(0, -1).trimEnd())
  return command === trimmed || command.startsWith(`${trimmed} `)
}

function specificity(rule: PermissionRule): number {
  return (rule.workspaceId === undefined ? 0 : 1) + (rule.agentType === undefined ? 0 : 1)
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid(message: string, detail: string): InternalAppError {
  return { code: 'VALIDATION_FAILED', message, retryable: false, detail }
}

/**
 * The slice of PermissionManager AgentManager needs before launching a Run.
 * AgentManager depends on this interface; the composition root injects the
 * concrete manager, so the agents/ module never imports the permissions/
 * module's stateful parts.
 */
export interface AgentPermissionPreparer {
  prepareRunPermission(options: {
    definition: AgentDefinition
    workspaceId: string
    role?: AgentRole
    approvalMode: ApprovalMode
    runDir: string
  }): IpcResult<PreparedAgentPermission | undefined>
}

export interface PermissionManager extends AgentPermissionPreparer {
  listRules(request?: ListPermissionRulesRequest): IpcResult<PermissionRule[]>
  createRule(request: CreatePermissionRuleRequest): IpcResult<PermissionRule>
  updateRule(request: UpdatePermissionRuleRequest): IpcResult<PermissionRule | null>
  deleteRule(request: PermissionRuleIdRequest): IpcResult<boolean>
  listAudit(request?: ListPermissionAuditRequest): IpcResult<PermissionAuditEntry[]>
  resolveProfile(request: ResolvePermissionProfileRequest): IpcResult<ResolvedPermissionProfile>
  recordDecision(request: ResolvePermissionDecisionRequest): IpcResult<PermissionDecisionResult>
  dispose(): void
}

export interface PermissionManagerDeps {
  readonly permissions: PermissionRepository
  readonly runs: AgentRunRepository
  readonly registry: AgentRegistry
  readonly events: EventBus<WorkbenchEvents>
  readonly now?: () => string
  readonly createRuleId?: () => string
}

interface SessionDecisions {
  readonly allow: string[]
  readonly deny: string[]
  readonly once: string[]
}

const ASK_DEGRADED_PREFIX = `Agent "`

function sessionKey(workspaceId: string | undefined, agentType: string): string {
  return `${workspaceId ?? '*'}::${agentType}`
}

function dedupe(patterns: readonly string[]): string[] {
  return [...new Set(patterns)]
}

export function createPermissionManager(deps: PermissionManagerDeps): PermissionManager {
  const logger = getLogger('runtime')
  const now = deps.now ?? (() => new Date().toISOString())
  const createRuleId = deps.createRuleId ?? randomUUID
  /** App-session decisions (never persisted), keyed by workspace + agent. */
  const sessionDecisions = new Map<string, SessionDecisions>()
  /** Commands already audited per Run (the extractor may re-see a line). */
  const auditedCommands = new Map<string, Set<string>>()

  const mergeSession = (
    key: string,
    allow: readonly string[],
    deny: readonly string[],
  ): { allow: string[]; deny: string[] } => {
    const decisions = sessionDecisions.get(key)
    if (decisions === undefined) return { allow: [...allow], deny: [...deny] }
    // One-shot grants are consumed by exactly one profile resolution.
    const merged = {
      allow: [...allow, ...decisions.allow, ...decisions.once],
      deny: [...deny, ...decisions.deny],
    }
    if (decisions.once.length > 0) {
      sessionDecisions.set(key, { ...decisions, once: [] })
    }
    return merged
  }

  const findMatchedRule = (runId: string, command: string): string | undefined => {
    const run = deps.runs.getById(runId)
    if (!run.ok || run.data === null) return undefined
    const listed = deps.permissions.listApplicableRules(run.data.workspaceId, run.data.agentType)
    if (!listed.ok) return undefined
    const matches = listed.data.filter((rule) => matchCommandPattern(rule.commandPattern, command))
    matches.sort((left, right) => specificity(right) - specificity(left))
    return matches[0]?.id
  }

  const auditChunk = (runId: string, data: string): void => {
    try {
      const commands = extractExecutedCommands(data)
      if (commands.length === 0) return
      const seen = auditedCommands.get(runId) ?? new Set<string>()
      auditedCommands.set(runId, seen)
      for (const command of commands) {
        if (seen.has(command)) continue
        seen.add(command)
        const risk = classifyCommand(command)
        const matchedRuleId = findMatchedRule(runId, command)
        const recorded = deps.permissions.recordAudit({
          runId,
          command,
          riskLevel: risk,
          ...(matchedRuleId === undefined ? {} : { matchedRuleId }),
          detectedAt: now(),
        })
        if (!recorded.ok) {
          logger.error(
            { runId, error: recorded.error },
            'Failed to persist a permission audit entry; the Run is unaffected.',
          )
          continue
        }
        deps.events.emit('permission.audit_recorded', { runId, riskLevel: risk })
      }
    } catch (cause) {
      logger.error({ runId, cause }, 'Permission audit failed; the Run is unaffected.')
    }
  }

  const stopAudit = deps.events.subscribe('agent.output', ({ runId, data }) => {
    auditChunk(runId, data)
  })

  const manager: PermissionManager = {
    listRules(request = {}) {
      return deps.permissions.listApplicableRules(request.workspaceId)
    },

    createRule(request) {
      if (request.agentType !== undefined && deps.registry.get(request.agentType) === undefined) {
        return fail(
          invalid(
            `Agent "${request.agentType}" is not registered.`,
            `createRule agentType=${JSON.stringify(request.agentType)}`,
          ),
        )
      }
      return deps.permissions.createRule({
        id: createRuleId(),
        commandPattern: request.commandPattern,
        action: request.action,
        scope: request.scope,
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        ...(request.agentType === undefined ? {} : { agentType: request.agentType }),
        ...(request.riskLevel === undefined ? {} : { riskLevel: request.riskLevel }),
      })
    },

    updateRule(request) {
      const { ruleId, ...patch } = request
      return deps.permissions.updateRule(ruleId, patch)
    },

    deleteRule(request) {
      return deps.permissions.deleteRule(request.ruleId)
    },

    listAudit(request = {}) {
      return deps.permissions.listAudit(request)
    },

    resolveProfile(request) {
      const definition = deps.registry.get(request.agentType)
      if (definition === undefined) {
        return fail(
          invalid(
            `Agent "${request.agentType}" is not registered.`,
            `resolveProfile agentType=${JSON.stringify(request.agentType)}`,
          ),
        )
      }
      const approvalMode = request.approvalMode ?? 'manual'
      const listed = deps.permissions.listApplicableRules(request.workspaceId, request.agentType)
      if (!listed.ok) return listed

      const allow: string[] = []
      const deny: string[] = []
      const notices: PermissionNotice[] = []
      for (const rule of listed.data) {
        switch (rule.action) {
          case 'allow':
            allow.push(rule.commandPattern)
            break
          case 'deny':
            deny.push(rule.commandPattern)
            break
          case 'ask':
            // ADR-0002: only `native` Agents have their own approval prompt.
            // Everywhere else `ask` cannot prompt, so it degrades to
            // audit-only and the notice carries that reason to the UI.
            notices.push({
              ruleId: rule.id,
              action: 'ask',
              reason:
                definition.permissionEnforcement === 'native'
                  ? 'Handled by the Agent CLI’s own approval prompt.'
                  : `${ASK_DEGRADED_PREFIX}${definition.id}" cannot prompt for approval (permissionEnforcement=${definition.permissionEnforcement}); this rule is audit-only and does not constrain execution.`,
            })
            break
          case 'audit':
            break
        }
      }
      const merged = mergeSession(sessionKey(request.workspaceId, request.agentType), allow, deny)
      // Conservative merge: deny wins over allow for the same pattern.
      const effectiveDeny = dedupe(merged.deny)
      const effectiveAllow = dedupe(merged.allow).filter(
        (pattern) => !effectiveDeny.includes(pattern),
      )
      return {
        ok: true,
        data: {
          profile: {
            id: `workspace:${request.workspaceId ?? 'global'}:agent:${request.agentType}:${approvalMode}`,
            approvalMode,
            allow: effectiveAllow,
            deny: effectiveDeny,
          },
          notices,
        },
      }
    },

    prepareRunPermission({ definition, workspaceId, role, approvalMode, runDir }) {
      const resolved = manager.resolveProfile({
        agentType: definition.id,
        workspaceId,
        approvalMode,
        ...(role === undefined ? {} : { role }),
      })
      if (!resolved.ok) return resolved
      for (const notice of resolved.data.notices) {
        if (notice.reason.startsWith(ASK_DEGRADED_PREFIX)) {
          logger.warn(
            { runDir, ruleId: notice.ruleId, reason: notice.reason },
            'Permission rule cannot prompt on this Agent; audit-only.',
          )
        }
      }
      return prepareAgentPermission({ definition, profile: resolved.data.profile, runDir })
    },

    recordDecision(request) {
      if (deps.registry.get(request.agentType) === undefined) {
        return fail(
          invalid(
            `Agent "${request.agentType}" is not registered.`,
            `recordDecision agentType=${JSON.stringify(request.agentType)}`,
          ),
        )
      }
      let result: PermissionDecisionResult
      if (request.decision === 'always-allow' || request.decision === 'deny') {
        const created = manager.createRule({
          commandPattern: request.commandPattern,
          action: request.decision === 'deny' ? 'deny' : 'allow',
          scope: 'persistent',
          agentType: request.agentType,
          ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        })
        if (!created.ok) return created
        result = { decision: request.decision, persistedAs: 'rule', rule: created.data }
      } else {
        // TASK-066 honesty constraint: session/once decisions are policy input
        // consumed by the NEXT Run's projection — nothing here gates a command
        // that is already running.
        const key = sessionKey(request.workspaceId, request.agentType)
        const current = sessionDecisions.get(key) ?? { allow: [], deny: [], once: [] }
        sessionDecisions.set(key, {
          allow:
            request.decision === 'allow-session'
              ? [...current.allow, request.commandPattern]
              : current.allow,
          deny: current.deny,
          once:
            request.decision === 'allow-once'
              ? [...current.once, request.commandPattern]
              : current.once,
        })
        result = {
          decision: request.decision,
          persistedAs: request.decision === 'allow-once' ? 'once' : 'session',
        }
      }
      if (request.runId !== undefined) {
        deps.events.emit('permission.resolved', {
          runId: request.runId,
          command: request.commandPattern,
        })
      }
      return { ok: true, data: result }
    },

    dispose() {
      stopAudit()
      sessionDecisions.clear()
      auditedCommands.clear()
    },
  }

  return manager
}
