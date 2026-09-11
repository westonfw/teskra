import { describe, expect, it } from 'vitest'

import type { AgentDefinition, AgentHealth } from '@teskra/contracts'

import { agentPickerOptions } from './agent-picker'

function definition(id: string, priority: number): AgentDefinition {
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
    defaults: { role: 'implementer' },
    permissionEnforcement: 'native',
    routing: { agentId: id, priority, useWhen: `Use ${id} when…` },
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

describe('agentPickerOptions (TASK-089)', () => {
  const definitions = [definition('fake', 10), definition('codex', 100), definition('claude', 90)]

  it('ranks options by the routing profile', () => {
    expect(agentPickerOptions(definitions).map(({ value }) => value)).toEqual([
      'codex',
      'claude',
      'fake',
    ])
  })

  it('prefers Agents matching the requested role', () => {
    const reviewer = { ...definition('claude', 90), defaults: { role: 'reviewer' as const } }
    const options = agentPickerOptions([definitions[0]!, definitions[1]!, reviewer], [], 'reviewer')
    expect(options[0]?.value).toBe('claude')
  })

  it('greys out unavailable Agents, marks them, and suggests an available alternative', () => {
    const options = agentPickerOptions(definitions, [
      health('codex', { available: false, installed: false, error: 'codex was not found' }),
      health('claude'),
      health('fake'),
    ])
    expect(options.map(({ value }) => value)).toEqual(['claude', 'fake', 'codex'])
    const codex = options.find(({ value }) => value === 'codex')
    expect(codex).toMatchObject({
      availability: 'unavailable',
      disabled: true,
      suggestion: 'Agent claude',
    })
    expect(options.find(({ value }) => value === 'claude')).toMatchObject({
      availability: 'available',
      disabled: false,
    })
  })

  it('flags rate-limited Agents without disabling them and suggests an alternative', () => {
    const options = agentPickerOptions(definitions, [
      health('codex', { rateLimited: true }),
      health('claude'),
    ])
    const codex = options.find(({ value }) => value === 'codex')
    expect(codex).toMatchObject({
      availability: 'rate-limited',
      disabled: false,
      suggestion: 'Agent claude',
    })
  })

  it('shows no suggestion when no probed-available alternative exists', () => {
    const options = agentPickerOptions(definitions, [
      health('codex', { available: false }),
      health('claude', { available: false }),
      health('fake', { available: false }),
    ])
    expect(options.every(({ suggestion }) => suggestion === undefined)).toBe(true)
  })

  it('never switches or drops the selection: every Agent stays a selectable option as health changes', () => {
    const before = agentPickerOptions(definitions)
    const after = agentPickerOptions(definitions, [
      health('codex', { available: false }),
      health('claude'),
      health('fake'),
    ])
    expect([...after.map(({ value }) => value)].sort()).toEqual(
      [...before.map(({ value }) => value)].sort(),
    )
    const selected = after.find(({ value }) => value === 'codex')
    expect(selected).toBeDefined()
    expect(selected?.disabled).toBe(true)
  })
})
