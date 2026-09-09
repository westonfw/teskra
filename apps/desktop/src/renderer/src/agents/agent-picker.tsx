import { Select } from 'antd'

import type { AgentDefinition } from '@teskra/contracts'

interface AgentPickerProps {
  readonly definitions: readonly AgentDefinition[]
  readonly value?: string
  readonly onChange?: (agentId: string) => void
  readonly disabled?: boolean
}

export function agentPickerOptions(definitions: readonly AgentDefinition[]) {
  return definitions.map((definition) => ({
    value: definition.id,
    label: definition.name,
    title: definition.routing?.useWhen,
  }))
}

export function AgentPicker({ definitions, value, onChange, disabled }: AgentPickerProps) {
  return (
    <Select
      className="agent-picker"
      value={value}
      options={agentPickerOptions(definitions)}
      placeholder="Select an Agent"
      disabled={disabled || definitions.length === 0}
      onChange={onChange}
    />
  )
}
