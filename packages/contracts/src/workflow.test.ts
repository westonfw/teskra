import { describe, expect, it } from 'vitest'

import { workflowDefinitionSchema, workflowNodeSchema, type WorkflowNode } from './workflow'

/**
 * TASK-055 shape-level tests: the discriminated union parses every node
 * type, rejects unknown ones, and `runOn` defaults to 'always'. Graph rules
 * (cycles, dangling dependsOn, conditional-edge cross-check, runOn
 * connectivity) are covered in @teskra/shared's workflow tests.
 */
describe('workflow node contracts (TASK-055)', () => {
  it('parses every node type of the §116.3 discriminated union', () => {
    const nodes = [
      { id: 'a', type: 'agent', agent: 'codex', role: 'implementer' },
      { id: 's', type: 'shell', command: 'npm test', timeoutMs: 600000 },
      { id: 'c', type: 'checkpoint', message: 'looks good?' },
      { id: 'cond', type: 'condition', expression: 'steps.test.result == "success"' },
      { id: 'g', type: 'criteria-gate' },
      { id: 'r', type: 'review-panel', agents: ['claude', 'codex'] },
    ]
    for (const node of nodes) {
      const parsed = workflowNodeSchema.safeParse(node)
      expect(parsed.success).toBe(true)
    }
  })

  it('supports exhaustive narrowing on the type discriminator', () => {
    const parsed = workflowNodeSchema.parse({ id: 'a', type: 'agent', agent: 'codex' })
    const narrowed: WorkflowNode = parsed
    switch (narrowed.type) {
      case 'agent':
        expect(narrowed.agent).toBe('codex')
        break
      case 'shell':
      case 'checkpoint':
      case 'condition':
      case 'criteria-gate':
      case 'review-panel':
        break
    }
  })

  it('rejects unknown node types and malformed nodes', () => {
    expect(workflowNodeSchema.safeParse({ id: 'x', type: 'loop' }).success).toBe(false)
    expect(workflowNodeSchema.safeParse({ id: 'x', type: 'shell' }).success).toBe(false)
    expect(workflowNodeSchema.safeParse({ type: 'agent', agent: 'codex' }).success).toBe(false)
  })

  it('defaults runOn to "always" on agent nodes', () => {
    const parsed = workflowNodeSchema.parse({ id: 'a', type: 'agent', agent: 'codex' })
    expect(parsed.runOn).toBe('always')
    const first = workflowNodeSchema.parse({
      id: 'a',
      type: 'agent',
      agent: 'codex',
      runOn: 'first',
    })
    expect(first.runOn).toBe('first')
  })

  it('parses both dependsOn spellings (plan §153)', () => {
    const parsed = workflowNodeSchema.parse({
      id: 'fix',
      type: 'agent',
      agent: 'codex',
      dependsOn: ['implement', { node: 'gate', on: 'fail' }, { node: 'test' }],
    })
    expect(parsed.dependsOn).toEqual(['implement', { node: 'gate', on: 'fail' }, { node: 'test' }])
  })

  it('parses a full definition and rejects unknown top-level keys', () => {
    const definition = {
      id: 'full-review',
      description: 'implement → review → gate → fix → test',
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
          runOn: 'subsequent',
          dependsOn: [{ node: 'gate', on: 'fail' }],
        },
        { id: 'test', type: 'shell', command: 'npm test', dependsOn: ['fix'] },
      ],
    }
    const parsed = workflowDefinitionSchema.safeParse(definition)
    expect(parsed.success).toBe(true)
    expect(workflowDefinitionSchema.safeParse({ ...definition, unexpected: true }).success).toBe(
      false,
    )
    expect(workflowDefinitionSchema.safeParse({ id: 'x', steps: [] }).success).toBe(false)
  })
})
