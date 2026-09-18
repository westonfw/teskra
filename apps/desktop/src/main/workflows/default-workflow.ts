import type { AgentDefinition, IpcResult, WorkflowDefinition } from '@teskra/contracts'

import { toPublicError } from '../errors'

/**
 * Default Full Workflow definition (TASK-063, teskra-tasks.md; plan §153):
 *
 *   Acceptance Criteria (anchored at run creation)
 *   → Create Worktree (FullWorkflowService, up-front)
 *   → Implement → Build/Test → Review → Criteria Gate      (round 1)
 *   → Fix → Test → Review → Criteria Gate                  (round ≥ 2)
 *   ├─ PASS → completed → User Review (the UI summary)
 *   └─ FAIL → next iteration via IterationController (plan §124 caps)
 *
 * The DAG stays acyclic — the fix loop is NOT a graph cycle; the outer
 * IterationController (TASK-062) executes one pass per round. Because the
 * engine's runOn semantics activate nothing for future-phase nodes, every
 * stage exists twice ('first' / 'subsequent'), exactly like the iterate
 * definition snapshot. The gate sits behind a conditional `on: 'approve'`
 * edge: it only evaluates the criteria scores once the review panel approved
 * the round, and its pass/fail joins the controller's round verdict.
 *
 * Agent ids are NEVER hardcoded here (plan §21): the built-in defaults come
 * from the AgentRegistry's declared `defaults.role` (Codex ships as
 * 'implementer', Claude Code as 'reviewer'), and a repo-local
 * `<repo>/.teskra/workflows/full.yaml` definition with the same id overrides
 * them (ADR-0005) — this module is the reference shape for such an override.
 */

/** Fixed identity of the default full workflow (and its repo-local override). */
export const DEFAULT_FULL_WORKFLOW_ID = 'full'

/** Default Build/Test step command; overridable per launch or via the repo file. */
export const DEFAULT_FULL_TEST_COMMAND = 'npm test'

/**
 * Node ids of the default full workflow. The agent and review node ids match
 * the IterationController's iterate snapshot exactly — the controller locates
 * the per-round agent step (previous-handoff lookup) and review step (round
 * verdict) by these ids.
 */
export const FULL_WORKFLOW_NODE_IDS = {
  implement: 'implement',
  fix: 'fix',
  testImplement: 'test-implement',
  testFix: 'test-fix',
  reviewImplement: 'review-implement',
  reviewFix: 'review-fix',
  gateImplement: 'gate-implement',
  gateFix: 'gate-fix',
} as const

/** Everything the default full workflow needs that is not fixed structure. */
export interface FullWorkflowConfig {
  /** AgentRegistry id of the implementer/fixer agent. */
  readonly implementer: string
  /** AgentRegistry ids of the review-panel reviewers. */
  readonly reviewers: readonly string[]
  /** Shell step command for the Build/Test step. */
  readonly testCommand: string
  /**
   * TASK-118: mark the Build/Test shell nodes requireConfirmation — used when
   * the test command came from the repo-local definition override, so the
   * user confirms the full command line before it executes.
   */
  readonly shellRequireConfirmation?: boolean
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return {
    ok: false,
    error: toPublicError({ code: 'VALIDATION_FAILED', message, retryable: false, detail }),
  }
}

/** The 8-node DAG snapshot persisted on every default full workflow run. */
export function buildDefaultFullWorkflowDefinition(config: FullWorkflowConfig): WorkflowDefinition {
  const ids = FULL_WORKFLOW_NODE_IDS
  return {
    id: DEFAULT_FULL_WORKFLOW_ID,
    description:
      'TASK-063 default full workflow: Implement → Test → Review → Criteria Gate (round 1), ' +
      'Fix → Test → Review → Criteria Gate (later rounds); the FAIL loop is driven by the ' +
      'IterationController safety caps (plan §124), not by graph cycles.',
    steps: [
      {
        id: ids.implement,
        type: 'agent',
        agent: config.implementer,
        role: 'implementer',
        runOn: 'first',
      },
      { id: ids.fix, type: 'agent', agent: config.implementer, role: 'fixer', runOn: 'subsequent' },
      {
        id: ids.testImplement,
        type: 'shell',
        command: config.testCommand,
        runOn: 'first',
        dependsOn: [ids.implement],
        ...(config.shellRequireConfirmation === true ? { requireConfirmation: true } : {}),
      },
      {
        id: ids.testFix,
        type: 'shell',
        command: config.testCommand,
        runOn: 'subsequent',
        dependsOn: [ids.fix],
        ...(config.shellRequireConfirmation === true ? { requireConfirmation: true } : {}),
      },
      {
        id: ids.reviewImplement,
        type: 'review-panel',
        agents: [...config.reviewers],
        runOn: 'first',
        dependsOn: [ids.testImplement],
      },
      {
        id: ids.reviewFix,
        type: 'review-panel',
        agents: [...config.reviewers],
        runOn: 'subsequent',
        dependsOn: [ids.testFix],
      },
      {
        id: ids.gateImplement,
        type: 'criteria-gate',
        runOn: 'first',
        dependsOn: [{ node: ids.reviewImplement, on: 'approve' }],
      },
      {
        id: ids.gateFix,
        type: 'criteria-gate',
        runOn: 'subsequent',
        dependsOn: [{ node: ids.reviewFix, on: 'approve' }],
      },
    ],
  }
}

/**
 * Registry-derived defaults: the first agent declaring `defaults.role`
 * 'implementer' implements (falling back to the first registered agent), and
 * every agent declaring 'reviewer' reviews. An empty registry — or one with
 * no reviewer distinct from the implementer — is a clear error, never a
 * silent hardcoded fallback.
 */
export function resolveDefaultFullWorkflowConfig(
  agents: readonly Pick<AgentDefinition, 'id' | 'defaults'>[],
): IpcResult<FullWorkflowConfig> {
  const implementer =
    agents.find((agent) => agent.defaults.role === 'implementer')?.id ?? agents[0]?.id
  if (implementer === undefined) {
    return invalid(
      'No agent is registered; the default full workflow cannot start.',
      'AgentRegistry is empty',
    )
  }
  const reviewers = agents
    .filter((agent) => agent.defaults.role === 'reviewer' && agent.id !== implementer)
    .map((agent) => agent.id)
  if (reviewers.length === 0) {
    return invalid(
      'No reviewer agent is registered; the default full workflow cannot start.',
      `AgentRegistry has no agent with defaults.role 'reviewer' besides ${JSON.stringify(implementer)}`,
    )
  }
  return {
    ok: true,
    data: { implementer, reviewers, testCommand: DEFAULT_FULL_TEST_COMMAND },
  }
}

/**
 * Extracts the config from a repo-local override definition (same id): the
 * round-1 agent node is the implementer, the round-1 review-panel node's
 * agents are the reviewers, and the round-1 shell node's command is the
 * Build/Test command. Missing pieces are a clear error — a partial override
 * would silently fall back to defaults the user did not ask for.
 */
export function extractFullWorkflowConfig(
  definition: WorkflowDefinition,
): IpcResult<FullWorkflowConfig> {
  const implementer = definition.steps.find(
    (node) => node.type === 'agent' && node.runOn === 'first',
  )
  if (implementer === undefined || implementer.type !== 'agent') {
    return invalid(
      `Workflow definition "${definition.id}" has no round-1 agent node to implement with.`,
      `definition ${JSON.stringify(definition.id)}: expected an agent node with runOn 'first'`,
    )
  }
  const review = definition.steps.find(
    (node) => node.type === 'review-panel' && node.runOn === 'first',
  )
  if (review === undefined || review.type !== 'review-panel') {
    return invalid(
      `Workflow definition "${definition.id}" has no round-1 review-panel node.`,
      `definition ${JSON.stringify(definition.id)}: expected a review-panel node with runOn 'first'`,
    )
  }
  const test = definition.steps.find((node) => node.type === 'shell' && node.runOn === 'first')
  if (test === undefined || test.type !== 'shell') {
    return invalid(
      `Workflow definition "${definition.id}" has no round-1 shell (Build/Test) node.`,
      `definition ${JSON.stringify(definition.id)}: expected a shell node with runOn 'first'`,
    )
  }
  return {
    ok: true,
    data: {
      implementer: implementer.agent,
      reviewers: review.agents,
      testCommand: test.command,
    },
  }
}
