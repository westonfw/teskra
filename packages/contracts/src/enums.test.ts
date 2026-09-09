import { describe, expect, it } from 'vitest'

import { AGENT_ROLES, AGENT_RUN_STATUSES, APPROVAL_MODES, EXECUTION_MODES } from './agent'
import { ARTIFACT_TYPES } from './artifact'
import { WORKTREE_ISOLATIONS, WORKTREE_STATES } from './git'
import { HANDOFF_PARSE_STATUSES, HANDOFF_TYPES, REVIEW_SEVERITIES } from './handoff'
import { MEMORY_TYPES } from './memory'
import { TASK_STATUSES } from './task'
import { RUNTIME_KINDS } from './workspace'
import { WORKFLOW_NODE_TYPES, WORKFLOW_RUN_STATUSES, WORKFLOW_STEP_STATUSES } from './workflow'

/**
 * Enum values must stay in sync with the §139.1 authoritative database schema
 * comments in docs/teskra-implementation-plan-v2.md (line numbers as of
 * TASK-003). If a schema comment changes, update the contract AND this table.
 */
const schemaAuthority: Array<{ source: string; contract: readonly string[]; ddl: string[] }> = [
  {
    source: '§139.1 workspaces.runtime_kind (line 5200, §116.1)',
    contract: RUNTIME_KINDS,
    ddl: ['windows', 'wsl', 'ssh', 'container'],
  },
  {
    source: '§139.1 tasks.status (line 5221, §138 八态)',
    contract: TASK_STATUSES,
    ddl: [
      'draft',
      'ready',
      'running',
      'needs_review',
      'blocked',
      'completed',
      'failed',
      'cancelled',
    ],
  },
  {
    source: '§139.1 worktrees.state (line 5240, §132 八态)',
    contract: WORKTREE_STATES,
    ddl: ['creating', 'ready', 'dirty', 'conflict', 'merged', 'discarded', 'missing', 'orphaned'],
  },
  {
    source: '§139.1 worktrees.isolation (line 5241)',
    contract: WORKTREE_ISOLATIONS,
    ddl: ['worktree', 'shared-readonly', 'worktree-readonly', 'disposable-snapshot'],
  },
  {
    source: '§139.1 workflow_runs.status (line 5254)',
    contract: WORKFLOW_RUN_STATUSES,
    ddl: ['created', 'running', 'waiting', 'needs_user_review', 'completed', 'failed', 'cancelled'],
  },
  {
    source: '§139.1 workflow_steps.node_type (line 5267)',
    contract: WORKFLOW_NODE_TYPES,
    ddl: ['agent', 'shell', 'checkpoint', 'condition', 'criteria-gate', 'review-panel'],
  },
  {
    source: '§139.1 workflow_steps.status (line 5268)',
    contract: WORKFLOW_STEP_STATUSES,
    ddl: ['pending', 'running', 'completed', 'failed', 'skipped', 'cancelled'],
  },
  {
    source: '§17 AgentRunStatus (lines 936–948, referenced by §139.1 line 5291; 含 interrupted)',
    contract: AGENT_RUN_STATUSES,
    ddl: [
      'created',
      'queued',
      'preparing',
      'running',
      'waiting_for_user',
      'waiting_for_permission',
      'waiting_for_agent',
      'reviewing',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ],
  },
  {
    source: '§139.1 agent_runs.role (line 5287)',
    contract: AGENT_ROLES,
    ddl: ['planner', 'implementer', 'reviewer', 'tester', 'fixer'],
  },
  {
    source: '§139.1 agent_runs.approval_mode (line 5289)',
    contract: APPROVAL_MODES,
    ddl: ['read-only', 'manual', 'safe-auto', 'full-auto'],
  },
  {
    source: '§139.1 agent_runs.execution_mode (line 5298, ADR-0002)',
    contract: EXECUTION_MODES,
    ddl: ['attended', 'orchestrated'],
  },
  {
    source: '§139.1 artifacts.type (line 5410, 七种)',
    contract: ARTIFACT_TYPES,
    ddl: ['plan', 'implementation', 'review', 'test-result', 'diff', 'decision', 'handoff'],
  },
  {
    source: '§139.1 handoffs.type (line 5422, §125 WorkerHandoff)',
    contract: HANDOFF_TYPES,
    ddl: ['implementation', 'review', 'test', 'analysis', 'blocker'],
  },
  {
    source: '§139.1 handoffs.parse_status (line 5426, ADR-0004)',
    contract: HANDOFF_PARSE_STATUSES,
    ddl: ['ok', 'degraded', 'missing'],
  },
  {
    source: '§139.1 memories.type (line 5434, 七种)',
    contract: MEMORY_TYPES,
    ddl: [
      'architecture',
      'convention',
      'decision',
      'command',
      'known_issue',
      'preference',
      'summary',
    ],
  },
  {
    source: '§139.1 review_findings.severity (line 5381)',
    contract: REVIEW_SEVERITIES,
    ddl: ['critical', 'high', 'medium', 'low'],
  },
]

describe('enum consistency with plan §139.1 schema comments', () => {
  for (const { source, contract, ddl } of schemaAuthority) {
    it(`${source}`, () => {
      expect([...contract]).toEqual(ddl)
    })
  }

  it('AgentRunStatus contains interrupted; TaskStatus has exactly 8 states', () => {
    expect(AGENT_RUN_STATUSES).toContain('interrupted')
    expect(TASK_STATUSES).toHaveLength(8)
    expect(WORKTREE_STATES).toHaveLength(8)
    expect(ARTIFACT_TYPES).toHaveLength(7)
    expect(MEMORY_TYPES).toHaveLength(7)
  })
})
