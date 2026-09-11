import { Select, Tag, Typography } from 'antd'
import type { ReactNode } from 'react'

import type { AgentDefinition, AgentHealth, AgentRole } from '@teskra/contracts'
import {
  agentAvailability,
  rankAgents,
  suggestAlternatives,
  type AgentAvailability,
} from '@teskra/shared'

interface AgentPickerProps {
  readonly definitions: readonly AgentDefinition[]
  /** Health snapshots for the current runtime; omit while probes are loading. */
  readonly health?: readonly AgentHealth[]
  /** When set, Agents whose default role matches rank first (TASK-089). */
  readonly role?: AgentRole
  readonly value?: string
  readonly onChange?: (agentId: string) => void
  readonly disabled?: boolean
}

export interface AgentPickerOption {
  readonly value: string
  readonly label: ReactNode
  readonly title?: string
  readonly disabled?: boolean
  readonly availability: AgentAvailability
  /** Name of the suggested alternative, shown when this Agent cannot serve. */
  readonly suggestion?: string
}

/**
 * TASK-089: options are ordered by the Routing Profile (priority / role /
 * strength / cost class) with unavailable Agents sunk to the bottom, greyed
 * out, and annotated with an available alternative. The picker never drops an
 * option and never fires onChange on its own — health changes reorder the
 * list but the user's selection stays put (no automatic Agent switching).
 */
export function agentPickerOptions(
  definitions: readonly AgentDefinition[],
  health: readonly AgentHealth[] = [],
  role?: AgentRole,
): AgentPickerOption[] {
  const context = role === undefined ? {} : { role }
  return rankAgents(definitions, health, context).map((definition) => {
    const availability = agentAvailability(
      health.find((entry) => entry.agentId === definition.id),
    )
    const degraded = availability === 'unavailable' || availability === 'rate-limited'
    const alternative = degraded
      ? suggestAlternatives(definition.id, definitions, health, context)[0]
      : undefined
    return {
      value: definition.id,
      label: (
        <span className="agent-picker-option">
          <span>{definition.name}</span>
          {availability === 'unavailable' && <Tag color="red">Unavailable</Tag>}
          {availability === 'rate-limited' && <Tag color="orange">Rate limited</Tag>}
          {alternative !== undefined && (
            <Typography.Text type="secondary">建议改用 {alternative.name}</Typography.Text>
          )}
        </span>
      ),
      title: definition.routing?.useWhen,
      disabled: availability === 'unavailable',
      availability,
      ...(alternative === undefined ? {} : { suggestion: alternative.name }),
    }
  })
}

export function AgentPicker({
  definitions,
  health,
  role,
  value,
  onChange,
  disabled,
}: AgentPickerProps) {
  return (
    <Select
      className="agent-picker"
      value={value}
      options={agentPickerOptions(definitions, health, role)}
      placeholder="Select an Agent"
      disabled={disabled || definitions.length === 0}
      onChange={onChange}
    />
  )
}
