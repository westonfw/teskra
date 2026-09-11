import { describe, expect, it } from 'vitest'

import type { AgentDefinition, AgentHealth } from '@teskra/contracts'

import { agentAvailability, rankAgents, suggestAlternatives } from './routing'

function definition(
  id: string,
  routing?: AgentDefinition['routing'],
  role?: AgentDefinition['defaults']['role'],
): AgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    executable: { command: id },
    capabilities: {
      interactive: true,
      headless: true,
      resume: true,
      readOnlyMode: true,
      modelSelection: true,
    },
    prompt: {},
    detection: { versionArgs: ['--version'] },
    defaults: { ...(role === undefined ? {} : { role }) },
    permissionEnforcement: 'native',
    ...(routing === undefined ? {} : { routing }),
  }
}

function health(agentId: string, overrides: Partial<AgentHealth> = {}): AgentHealth {
  return {
    agentId,
    runtime: { kind: 'wsl' },
    installed: true,
    available: true,
    checkedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  }
}

const ids = (definitions: readonly AgentDefinition[]) => definitions.map(({ id }) => id)

describe('agentAvailability (TASK-089)', () => {
  it('treats unprobed Agents as unknown, never as unavailable', () => {
    expect(agentAvailability(undefined)).toBe('unknown')
  })

  it('derives the verdict from executable detection, flagging rate limiting separately', () => {
    expect(agentAvailability(health('codex'))).toBe('available')
    expect(agentAvailability(health('codex', { rateLimited: true }))).toBe('rate-limited')
    expect(agentAvailability(health('codex', { available: false, installed: false }))).toBe(
      'unavailable',
    )
  })

  it('never consults quota data — an exhausted or missing quota probe cannot change availability', () => {
    expect(agentAvailability(health('codex', { quota: { remaining: 0 } }))).toBe('available')
    expect(agentAvailability(health('codex', { quota: {} }))).toBe('available')
    expect(
      agentAvailability(
        health('codex', { quota: { remaining: 0 }, available: false, installed: false }),
      ),
    ).toBe('unavailable')
  })
})

describe('rankAgents (TASK-089)', () => {
  it('orders by routing priority, higher first, with a deterministic name tiebreak', () => {
    const ranked = rankAgents([
      definition('low', { agentId: 'low', priority: 10 }),
      definition('none'),
      definition('high', { agentId: 'high', priority: 100 }),
    ])
    expect(ids(ranked)).toEqual(['high', 'low', 'none'])
  })

  it('breaks priority ties by cost class, cheaper first', () => {
    const ranked = rankAgents([
      definition('pricey', { agentId: 'pricey', priority: 50, costClass: 'high' }),
      definition('cheap', { agentId: 'cheap', priority: 50, costClass: 'low' }),
      definition('mid', { agentId: 'mid', priority: 50, costClass: 'medium' }),
    ])
    expect(ids(ranked)).toEqual(['cheap', 'mid', 'pricey'])
  })

  it('prefers Agents whose default role matches the requested role', () => {
    const ranked = rankAgents(
      [
        definition('coder', { agentId: 'coder', priority: 100 }, 'implementer'),
        definition('auditor', { agentId: 'auditor', priority: 10 }, 'reviewer'),
      ],
      [],
      { role: 'reviewer' },
    )
    expect(ids(ranked)).toEqual(['auditor', 'coder'])
  })

  it('prefers Agents advertising a matching strength', () => {
    const ranked = rankAgents(
      [
        definition('generalist', { agentId: 'generalist', priority: 100 }),
        definition('specialist', {
          agentId: 'specialist',
          priority: 10,
          strengths: ['architecture'],
        }),
      ],
      [],
      { strength: 'architecture' },
    )
    expect(ids(ranked)).toEqual(['specialist', 'generalist'])
  })

  it('sinks unavailable Agents below rate-limited ones, which sink below available ones', () => {
    const ranked = rankAgents(
      [
        definition('down', { agentId: 'down', priority: 100 }),
        definition('limited', { agentId: 'limited', priority: 10 }),
        definition('up', { agentId: 'up', priority: 1 }),
      ],
      [
        health('down', { available: false, installed: false }),
        health('limited', { rateLimited: true }),
        health('up'),
      ],
    )
    expect(ids(ranked)).toEqual(['up', 'limited', 'down'])
  })

  it('does not penalize unprobed Agents while health is still loading', () => {
    const ranked = rankAgents(
      [definition('unprobed', { agentId: 'unprobed', priority: 10 }), definition('probed')],
      [health('probed')],
    )
    expect(ids(ranked)).toEqual(['unprobed', 'probed'])
  })

  it('returns a new array without mutating or filtering the input', () => {
    const input = [
      definition('b', { agentId: 'b', priority: 1 }),
      definition('a', { agentId: 'a', priority: 10 }),
    ]
    const ranked = rankAgents(input, [health('a', { available: false, installed: false })])
    expect(ranked).not.toBe(input)
    expect(ids(input)).toEqual(['b', 'a'])
    expect([...ids(ranked)].sort()).toEqual(['a', 'b'])
  })
})

describe('suggestAlternatives (TASK-089)', () => {
  const definitions = [
    definition('codex', { agentId: 'codex', priority: 100 }),
    definition('claude', { agentId: 'claude', priority: 90 }),
    definition('fake', { agentId: 'fake', priority: 10 }),
  ]

  it('suggests ranked available Agents when the target is unavailable, excluding the target itself', () => {
    const alternatives = suggestAlternatives('codex', definitions, [
      health('codex', { available: false, installed: false }),
      health('claude'),
      health('fake'),
    ])
    expect(ids(alternatives)).toEqual(['claude', 'fake'])
  })

  it('only suggests probed-available Agents — unprobed ones are never recommended blindly', () => {
    const alternatives = suggestAlternatives('codex', definitions, [
      health('codex', { rateLimited: true }),
      health('fake', { available: false, installed: false }),
    ])
    expect(ids(alternatives)).toEqual([])
  })

  it('suggests nothing when every alternative is unavailable too', () => {
    const alternatives = suggestAlternatives('codex', definitions, [
      health('codex', { available: false }),
      health('claude', { available: false }),
      health('fake', { available: false }),
    ])
    expect(alternatives).toEqual([])
  })

  it('applies the routing context when ranking alternatives', () => {
    const alternatives = suggestAlternatives(
      'codex',
      [
        definition('codex', { agentId: 'codex', priority: 100 }),
        definition('reviewer-a', { agentId: 'reviewer-a', priority: 1, strengths: ['review'] }),
        definition('reviewer-b', { agentId: 'reviewer-b', priority: 90 }),
      ],
      [health('codex', { available: false }), health('reviewer-a'), health('reviewer-b')],
      { strength: 'review' },
    )
    expect(ids(alternatives)).toEqual(['reviewer-a', 'reviewer-b'])
  })
})
