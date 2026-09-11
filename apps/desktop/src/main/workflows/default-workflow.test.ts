import { describe, expect, it } from 'vitest'

import type { AgentDefinition } from '@teskra/contracts'
import { activeNodeIdsForIteration, validateWorkflowDefinition } from '@teskra/shared'

import { FAKE_AGENT } from '../agents/definitions/fake'
import {
  buildDefaultFullWorkflowDefinition,
  DEFAULT_FULL_WORKFLOW_ID,
  extractFullWorkflowConfig,
  FULL_WORKFLOW_NODE_IDS,
  resolveDefaultFullWorkflowConfig,
} from './default-workflow'

const CONFIG = { implementer: 'codex', reviewers: ['claude'], testCommand: 'npm test' }

function agent(id: string, role?: 'implementer' | 'reviewer' | 'fixer'): AgentDefinition {
  return { ...FAKE_AGENT, id, defaults: role === undefined ? {} : { role } }
}

describe('default full workflow definition (TASK-063)', () => {
  it('passes full graph validation (shape, acyclicity, conditional edges, runOn connectivity)', () => {
    const validated = validateWorkflowDefinition(buildDefaultFullWorkflowDefinition(CONFIG))
    expect(validated.ok).toBe(true)
  })

  it('keeps the iterate node ids the IterationController locates (implement / fix / review-*)', () => {
    const definition = buildDefaultFullWorkflowDefinition(CONFIG)
    expect(definition.id).toBe(DEFAULT_FULL_WORKFLOW_ID)
    const ids = definition.steps.map((step) => step.id)
    expect(ids).toContain(FULL_WORKFLOW_NODE_IDS.implement)
    expect(ids).toContain(FULL_WORKFLOW_NODE_IDS.fix)
    expect(ids).toContain(FULL_WORKFLOW_NODE_IDS.reviewImplement)
    expect(ids).toContain(FULL_WORKFLOW_NODE_IDS.reviewFix)
  })

  it('executes implement → test → review → gate in round 1 and fix → test → review → gate later', () => {
    const validated = validateWorkflowDefinition(buildDefaultFullWorkflowDefinition(CONFIG))
    if (!validated.ok) throw new Error('definition must validate')
    expect([...activeNodeIdsForIteration(validated.definition, 1)].sort()).toEqual([
      FULL_WORKFLOW_NODE_IDS.gateImplement,
      FULL_WORKFLOW_NODE_IDS.implement,
      FULL_WORKFLOW_NODE_IDS.reviewImplement,
      FULL_WORKFLOW_NODE_IDS.testImplement,
    ])
    expect([...activeNodeIdsForIteration(validated.definition, 2)].sort()).toEqual([
      FULL_WORKFLOW_NODE_IDS.fix,
      FULL_WORKFLOW_NODE_IDS.gateFix,
      FULL_WORKFLOW_NODE_IDS.reviewFix,
      FULL_WORKFLOW_NODE_IDS.testFix,
    ])
  })

  it('gates only on an approved review (conditional edge cross-check)', () => {
    const definition = buildDefaultFullWorkflowDefinition(CONFIG)
    const gate = definition.steps.find((step) => step.id === FULL_WORKFLOW_NODE_IDS.gateImplement)
    expect(gate?.type).toBe('criteria-gate')
    expect(gate?.dependsOn).toEqual([
      { node: FULL_WORKFLOW_NODE_IDS.reviewImplement, on: 'approve' },
    ])
  })
})

describe('resolveDefaultFullWorkflowConfig (TASK-063)', () => {
  it('picks registry roles: implementer implements, reviewers review', () => {
    const resolved = resolveDefaultFullWorkflowConfig([
      agent('claude', 'reviewer'),
      agent('codex', 'implementer'),
    ])
    expect(resolved).toEqual({
      ok: true,
      data: { implementer: 'codex', reviewers: ['claude'], testCommand: 'npm test' },
    })
  })

  it('falls back to the first registered agent when none declares implementer', () => {
    const resolved = resolveDefaultFullWorkflowConfig([agent('solo'), agent('claude', 'reviewer')])
    expect(resolved.ok && resolved.data.implementer).toBe('solo')
  })

  it('fails clearly on an empty registry or one without a distinct reviewer', () => {
    expect(resolveDefaultFullWorkflowConfig([]).ok).toBe(false)
    const noReviewer = resolveDefaultFullWorkflowConfig([agent('codex', 'implementer')])
    expect(noReviewer.ok).toBe(false)
    if (!noReviewer.ok) expect(noReviewer.error.message).toContain('reviewer')
  })
})

describe('extractFullWorkflowConfig (repo-local override)', () => {
  it('round-trips the built-in shape', () => {
    const extracted = extractFullWorkflowConfig(buildDefaultFullWorkflowDefinition(CONFIG))
    expect(extracted).toEqual({ ok: true, data: CONFIG })
  })

  it('rejects definitions without the required round-1 nodes', () => {
    const noShell = extractFullWorkflowConfig({
      id: 'full',
      steps: [
        { id: 'implement', type: 'agent', agent: 'codex', runOn: 'first' },
        { id: 'review', type: 'review-panel', agents: ['claude'], runOn: 'first' },
      ],
    })
    expect(noShell.ok).toBe(false)
    const noAgent = extractFullWorkflowConfig({
      id: 'full',
      steps: [
        { id: 'test', type: 'shell', command: 'npm test', runOn: 'first' },
        { id: 'review', type: 'review-panel', agents: ['claude'], runOn: 'first' },
      ],
    })
    expect(noAgent.ok).toBe(false)
  })
})
