import { agentDefinitionSchema, type AgentDefinition, type IpcResult } from '@teskra/contracts'

import { toPublicError } from '../errors'
import { CLAUDE_AGENT } from './definitions/claude'
import { CODEX_AGENT } from './definitions/codex'

export interface AgentRegistry {
  register(definition: unknown): IpcResult<AgentDefinition>
  get(id: string): AgentDefinition | undefined
  list(): readonly AgentDefinition[]
  has(id: string): boolean
}

export function createAgentRegistry(initial: readonly unknown[] = []): IpcResult<AgentRegistry> {
  const definitions = new Map<string, AgentDefinition>()

  const registry: AgentRegistry = {
    register(candidate) {
      const parsed = agentDefinitionSchema.safeParse(candidate)
      if (!parsed.success) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: 'An Agent definition is invalid.',
            retryable: false,
            detail: JSON.stringify(parsed.error.issues),
          }),
        }
      }
      if (definitions.has(parsed.data.id)) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: `Agent "${parsed.data.id}" is already registered.`,
            retryable: false,
            detail: `duplicate AgentDefinition id=${parsed.data.id}`,
          }),
        }
      }
      definitions.set(parsed.data.id, parsed.data)
      return { ok: true, data: parsed.data }
    },
    get: (id) => definitions.get(id),
    list: () => [...definitions.values()],
    has: (id) => definitions.has(id),
  }

  for (const definition of initial) {
    const registered = registry.register(definition)
    if (!registered.ok) return registered
  }
  return { ok: true, data: registry }
}

export function createBuiltInAgentRegistry(): IpcResult<AgentRegistry> {
  return createAgentRegistry([CODEX_AGENT, CLAUDE_AGENT])
}
