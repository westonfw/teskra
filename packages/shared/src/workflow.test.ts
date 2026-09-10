import { describe, expect, it } from 'vitest'

import {
  activeNodeIdsForIteration,
  findDependencyCycle,
  normalizeDependsOn,
  validateWorkflowDefinition,
} from './workflow'

/**
 * TASK-055 graph-rule tests (plan §153). The valid baseline mirrors the
 * §153 default workflow: implement(first) → review → gate → fix(subsequent)
 * → test, with a conditional edge gate --fail--> fix.
 */
function validDefinition() {
  return {
    id: 'full-review',
    steps: [
      { id: 'implement', type: 'agent', agent: 'codex', role: 'implementer', runOn: 'first' },
      {
        id: 'review',
        type: 'review-panel',
        agents: ['claude', 'codex'],
        dependsOn: ['implement'],
      },
      { id: 'gate', type: 'criteria-gate', dependsOn: ['review'] },
      {
        id: 'fix',
        type: 'agent',
        agent: 'codex',
        role: 'fixer',
        runOn: 'subsequent',
        dependsOn: [{ node: 'gate', on: 'fail' }],
      },
      { id: 'test', type: 'shell', command: 'npm test', dependsOn: ['fix'] },
    ],
  }
}

describe('validateWorkflowDefinition (TASK-055)', () => {
  it('accepts the plan §153 default workflow', () => {
    const result = validateWorkflowDefinition(validDefinition())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.definition.id).toBe('full-review')
      expect(result.definition.steps.map((node) => node.runOn)).toEqual([
        'first',
        'always',
        'always',
        'subsequent',
        'always',
      ])
    }
  })

  it('rejects shape errors with invalid-shape issues', () => {
    const result = validateWorkflowDefinition({ id: 'x', steps: [{ id: 'a', type: 'nope' }] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.every((issue) => issue.code === 'invalid-shape')).toBe(true)
    }
  })

  it('rejects a dependency cycle and names the nodes on the cycle', () => {
    const definition = {
      id: 'cyclic',
      steps: [
        { id: 'a', type: 'shell', command: 'true', dependsOn: ['c'] },
        { id: 'b', type: 'shell', command: 'true', dependsOn: ['a'] },
        { id: 'c', type: 'shell', command: 'true', dependsOn: ['b'] },
      ],
    }
    const result = validateWorkflowDefinition(definition)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const cycle = result.issues.find((issue) => issue.code === 'dependency-cycle')
      expect(cycle).toBeDefined()
      // The error message points out the nodes on the cycle.
      expect(cycle?.message).toContain('a -> ')
      expect(cycle?.message).toContain('b')
      expect(cycle?.message).toContain('c')
    }
  })

  it('finds no cycle in an acyclic definition', () => {
    const validated = validateWorkflowDefinition(validDefinition())
    if (!validated.ok) throw new Error('expected valid definition')
    expect(findDependencyCycle(validated.definition)).toBeNull()
  })

  it('rejects a self-loop', () => {
    const result = validateWorkflowDefinition({
      id: 'self',
      steps: [{ id: 'a', type: 'shell', command: 'true', dependsOn: ['a'] }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const cycle = result.issues.find((issue) => issue.code === 'dependency-cycle')
      expect(cycle?.message).toContain('a -> a')
    }
  })

  it('rejects dependsOn entries referencing unknown nodes', () => {
    const definition = {
      id: 'dangling',
      steps: [
        { id: 'implement', type: 'agent', agent: 'codex' },
        { id: 'review', type: 'review-panel', agents: ['claude'], dependsOn: ['ghost'] },
      ],
    }
    const result = validateWorkflowDefinition(definition)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.code === 'unknown-dependency')
      expect(issue?.message).toContain('"review"')
      expect(issue?.message).toContain('"ghost"')
    }
  })

  it('rejects duplicate node ids', () => {
    const result = validateWorkflowDefinition({
      id: 'dup',
      steps: [
        { id: 'test', type: 'shell', command: 'npm test' },
        { id: 'test', type: 'shell', command: 'npm run lint' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'duplicate-node-id')).toBe(true)
    }
  })

  describe('conditional edge cross-check (plan §153 table)', () => {
    const edgeCase = (
      upstreamType: string,
      on: string,
    ): ReturnType<typeof validateWorkflowDefinition> => {
      const upstream: Record<string, unknown> = { id: 'up', type: upstreamType }
      if (upstreamType === 'agent') upstream['agent'] = 'codex'
      if (upstreamType === 'shell') upstream['command'] = 'true'
      if (upstreamType === 'condition') upstream['expression'] = 'true'
      if (upstreamType === 'review-panel') upstream['agents'] = ['claude']
      return validateWorkflowDefinition({
        id: 'edges',
        steps: [
          upstream,
          { id: 'down', type: 'shell', command: 'true', dependsOn: [{ node: 'up', on }] },
        ],
      })
    }

    it.each([
      ['criteria-gate', 'pass', true],
      ['criteria-gate', 'fail', true],
      ['criteria-gate', 'success', false],
      ['condition', 'true', true],
      ['condition', 'false', true],
      ['condition', 'pass', false],
      ['agent', 'success', true],
      ['agent', 'failure', true],
      ['agent', 'fail', false],
      ['shell', 'success', true],
      ['shell', 'failure', true],
      ['review-panel', 'approve', true],
      ['review-panel', 'changes_requested', true],
      ['review-panel', 'pass', false],
      ['checkpoint', 'approve', false],
    ])('%s --%s--> downstream valid=%s', (upstreamType, on, valid) => {
      const result = edgeCase(upstreamType, on)
      expect(result.ok).toBe(valid)
      if (!valid && !result.ok) {
        const issue = result.issues.find((entry) => entry.code === 'invalid-condition-edge')
        expect(issue?.message).toContain(`"${on}"`)
        expect(issue?.message).toContain(`"${upstreamType}"`)
      }
    })
  })

  describe('runOn iteration filtering (plan §153 每轮的节点激活规则)', () => {
    it('computes the active node set per iteration', () => {
      const validated = validateWorkflowDefinition(validDefinition())
      if (!validated.ok) throw new Error('expected valid definition')
      expect([...activeNodeIdsForIteration(validated.definition, 1)].sort()).toEqual([
        'gate',
        'implement',
        'review',
        'test',
      ])
      expect([...activeNodeIdsForIteration(validated.definition, 2)].sort()).toEqual([
        'fix',
        'gate',
        'review',
        'test',
      ])
    })

    it('rejects a definition whose only terminal node is filtered out of a phase', () => {
      const result = validateWorkflowDefinition({
        id: 'first-only-terminal',
        steps: [
          { id: 'implement', type: 'agent', agent: 'codex', runOn: 'first' },
          { id: 'test', type: 'shell', command: 'npm test', dependsOn: ['implement'] },
        ],
      })
      // terminal "test" is always active; make IT first-only instead:
      expect(result.ok).toBe(true)
      const rejected = validateWorkflowDefinition({
        id: 'first-only-terminal',
        steps: [
          { id: 'implement', type: 'agent', agent: 'codex' },
          {
            id: 'test',
            type: 'shell',
            command: 'npm test',
            runOn: 'first',
            dependsOn: ['implement'],
          },
        ],
      })
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        expect(
          rejected.issues.some(
            (entry) =>
              entry.code === 'iteration-disconnected' && entry.message.includes('subsequent'),
          ),
        ).toBe(true)
      }
    })

    it('rejects a definition where filtering disconnects a node from every terminal', () => {
      // first phase: "sink" (runOn subsequent) is inactive, so "branch" has no
      // path to any active terminal.
      const result = validateWorkflowDefinition({
        id: 'disconnected',
        steps: [
          { id: 'root', type: 'shell', command: 'true' },
          { id: 'branch', type: 'shell', command: 'true', dependsOn: ['root'] },
          {
            id: 'sink',
            type: 'shell',
            command: 'true',
            runOn: 'subsequent',
            dependsOn: ['branch'],
          },
        ],
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(
          result.issues.some(
            (entry) =>
              entry.code === 'iteration-disconnected' &&
              entry.message.includes('"branch"') &&
              entry.message.includes('"first"'),
          ),
        ).toBe(true)
      }
    })
  })

  it('normalizeDependsOn normalizes both spellings', () => {
    expect(normalizeDependsOn(['a', { node: 'b' }, { node: 'c', on: 'fail' }])).toEqual([
      { node: 'a' },
      { node: 'b' },
      { node: 'c', on: 'fail' },
    ])
    expect(normalizeDependsOn(undefined)).toEqual([])
  })
})
