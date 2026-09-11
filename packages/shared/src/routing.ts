import type { AgentDefinition, AgentHealth, AgentRole } from '@teskra/contracts'

/**
 * TASK-089 Agent Routing Profile (plan §144/§145). First version: the user
 * always picks the Agent manually — these pure functions only produce
 * ordering and recommendation hints for the UI. Nothing here starts, stops,
 * or switches a Run.
 *
 * Availability verdicts come from executable detection (TASK-024) alone.
 * Quota is a Routing Signal (plan §145), never a dependency: `health.quota`
 * is deliberately never read, so a missing/unparseable quota probe cannot
 * change whether an Agent is considered usable.
 */

export type AgentAvailability = 'available' | 'rate-limited' | 'unavailable' | 'unknown'

export interface AgentRoutingContext {
  /** Runs started for this role rank Agents whose default role matches first. */
  readonly role?: AgentRole
  /** Free-form strength tag (AgentRoutingProfile.strengths entries). */
  readonly strength?: string
}

/**
 * Derives the availability tier from an AgentHealth snapshot. `undefined`
 * health means "not probed yet" and is neutral — an Agent must never sink in
 * the ranking just because its health check has not completed.
 */
export function agentAvailability(health: AgentHealth | undefined): AgentAvailability {
  if (health === undefined) return 'unknown'
  if (!health.available) return 'unavailable'
  if (health.rateLimited === true) return 'rate-limited'
  return 'available'
}

const AVAILABILITY_TIER: Readonly<Record<AgentAvailability, number>> = {
  available: 0,
  unknown: 0,
  'rate-limited': 1,
  unavailable: 2,
}

const COST_CLASS_TIER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2 }

function healthByAgent(health: readonly AgentHealth[]): Map<string, AgentHealth> {
  const indexed = new Map<string, AgentHealth>()
  for (const entry of health) if (!indexed.has(entry.agentId)) indexed.set(entry.agentId, entry)
  return indexed
}

function compareAgents(
  context: AgentRoutingContext,
  health: Map<string, AgentHealth>,
  left: AgentDefinition,
  right: AgentDefinition,
): number {
  const tierDelta =
    AVAILABILITY_TIER[agentAvailability(health.get(left.id))] -
    AVAILABILITY_TIER[agentAvailability(health.get(right.id))]
  if (tierDelta !== 0) return tierDelta

  if (context.role !== undefined) {
    const roleDelta =
      Number(right.defaults.role === context.role) - Number(left.defaults.role === context.role)
    if (roleDelta !== 0) return roleDelta
  }

  if (context.strength !== undefined) {
    const matches = (definition: AgentDefinition) =>
      definition.routing?.strengths?.includes(context.strength as string) === true
    const strengthDelta = Number(matches(right)) - Number(matches(left))
    if (strengthDelta !== 0) return strengthDelta
  }

  const priorityDelta = (right.routing?.priority ?? 0) - (left.routing?.priority ?? 0)
  if (priorityDelta !== 0) return priorityDelta

  const costDelta =
    (COST_CLASS_TIER[left.routing?.costClass ?? 'medium'] ?? 1) -
    (COST_CLASS_TIER[right.routing?.costClass ?? 'medium'] ?? 1)
  if (costDelta !== 0) return costDelta

  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

/**
 * Orders Agent definitions for display: available Agents first (rate-limited
 * then unavailable sink to the bottom), then role/strength match, routing
 * priority (desc), cost class (asc), and a deterministic name tiebreak.
 * Returns a new array; the input is never mutated and no Agent is filtered
 * out — the current selection must always remain selectable.
 */
export function rankAgents(
  definitions: readonly AgentDefinition[],
  health: readonly AgentHealth[] = [],
  context: AgentRoutingContext = {},
): readonly AgentDefinition[] {
  const indexed = healthByAgent(health)
  return [...definitions].sort((left, right) => compareAgents(context, indexed, left, right))
}

/**
 * Ranked alternative Agents to suggest when `agentId` is unavailable or
 * rate-limited. Only Agents probed as available are suggested — unprobed
 * ('unknown') Agents are never recommended blindly, so with no healthy
 * alternative the result is empty and the UI shows no suggestion.
 */
export function suggestAlternatives(
  agentId: string,
  definitions: readonly AgentDefinition[],
  health: readonly AgentHealth[] = [],
  context: AgentRoutingContext = {},
): readonly AgentDefinition[] {
  const indexed = healthByAgent(health)
  const candidates = definitions.filter(
    (definition) =>
      definition.id !== agentId && agentAvailability(indexed.get(definition.id)) === 'available',
  )
  return rankAgents(candidates, health, context)
}
