import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowDependency,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@teskra/contracts'

/**
 * WorkflowDefinition graph validation (TASK-055; plan §153「Iterate 与 DAG
 * 的关系」/「每轮的节点激活规则」). Pure functions over the contracts types —
 * no I/O, so they are reusable from Main, preload bundles, and tests.
 *
 * Rules enforced here (on top of the shape-only Zod schema):
 *
 * 1. Node ids are unique.
 * 2. Every dependsOn entry references an existing node.
 * 3. The dependsOn graph is STRICTLY acyclic — a cycle rejects the load and
 *    the error names the nodes on the cycle. Iterate is not a graph cycle:
 *    the same acyclic DAG is executed once per iteration by the outer
 *    IterationController (TASK-062), so the graph never needs loop edges.
 * 4. Conditional edges (`{ node, on }`) cross-check `on` against the
 *    UPSTREAM node type (plan §153 table):
 *      criteria-gate → pass | fail
 *      condition     → true | false
 *      agent / shell → success | failure
 *      review-panel  → approve | changes_requested
 *      checkpoint    → (no outcomes; conditional edges are rejected)
 * 5. runOn filtering: for BOTH iteration phases (first / subsequent) the
 *    filtered subgraph must stay connected to at least one terminal node
 *    (a sink of the full DAG) — every active node must reach an active sink,
 *    otherwise the definition is rejected at load time.
 */

export const WORKFLOW_CONDITION_OUTCOMES: Readonly<Record<WorkflowNodeType, readonly string[]>> = {
  agent: ['success', 'failure'],
  shell: ['success', 'failure'],
  checkpoint: [],
  condition: ['true', 'false'],
  'criteria-gate': ['pass', 'fail'],
  'review-panel': ['approve', 'changes_requested'],
}

export const WORKFLOW_VALIDATION_CODES = [
  'invalid-shape',
  'duplicate-node-id',
  'unknown-dependency',
  'invalid-condition-edge',
  'dependency-cycle',
  'iteration-disconnected',
] as const
export type WorkflowValidationCode = (typeof WORKFLOW_VALIDATION_CODES)[number]

export interface WorkflowValidationIssue {
  readonly code: WorkflowValidationCode
  readonly message: string
}

export type WorkflowValidation =
  | { readonly ok: true; readonly definition: WorkflowDefinition }
  | { readonly ok: false; readonly issues: readonly WorkflowValidationIssue[] }

export interface NormalizedDependency {
  readonly node: string
  readonly on?: string | undefined
}

/** Normalizes the two dependsOn spellings (plan §153) into object form. */
export function normalizeDependsOn(
  dependsOn: readonly WorkflowDependency[] | undefined,
): NormalizedDependency[] {
  return (dependsOn ?? []).map((entry) => (typeof entry === 'string' ? { node: entry } : entry))
}

/**
 * Node ids active in a given 1-based iteration after runOn filtering
 * (plan §153): 'first' runs only in iteration 1, 'subsequent' from
 * iteration 2 on, 'always' (the default) in every iteration.
 */
export function activeNodeIdsForIteration(
  definition: WorkflowDefinition,
  iteration: number,
): ReadonlySet<string> {
  const active = new Set<string>()
  for (const node of definition.steps) {
    const runOn = node.runOn
    if (runOn === 'always' || (iteration === 1 ? runOn === 'first' : runOn === 'subsequent')) {
      active.add(node.id)
    }
  }
  return active
}

/** Finds one dependency cycle; returns the node ids in cycle order, or null. */
export function findDependencyCycle(definition: WorkflowDefinition): string[] | null {
  const byId = new Map(definition.steps.map((node) => [node.id, node]))
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (id: string, stack: string[]): string[] | null => {
    const marker = state.get(id)
    if (marker === 'done') return null
    if (marker === 'visiting') {
      return [...stack.slice(stack.indexOf(id)), id]
    }
    state.set(id, 'visiting')
    const node = byId.get(id)
    for (const dependency of normalizeDependsOn(node?.dependsOn)) {
      if (!byId.has(dependency.node)) continue
      const cycle = visit(dependency.node, [...stack, id])
      if (cycle !== null) return cycle
    }
    state.set(id, 'done')
    return null
  }

  for (const node of definition.steps) {
    const cycle = visit(node.id, [])
    if (cycle !== null) return cycle
  }
  return null
}

/** Sinks of the full DAG: nodes no other node depends on (terminal nodes). */
function terminalNodeIds(definition: WorkflowDefinition): Set<string> {
  const dependedOn = new Set<string>()
  for (const node of definition.steps) {
    for (const dependency of normalizeDependsOn(node.dependsOn)) {
      dependedOn.add(dependency.node)
    }
  }
  return new Set(definition.steps.map((node) => node.id).filter((id) => !dependedOn.has(id)))
}

/**
 * After runOn filtering for a phase, every active node must still reach an
 * active terminal node of the original DAG (plan §153「每轮的节点激活规则」).
 * Filtered nodes are treated as skipped with their out-edges STILL
 * activating, so a path may pass through inactive nodes — filtering must
 * never strand an active node without a route to a terminal. Returns the
 * active nodes that are stranded, plus the terminals that survived.
 */
function unreachableAfterFiltering(
  definition: WorkflowDefinition,
  phase: 'first' | 'subsequent',
): { readonly disconnected: string[]; readonly terminals: string[] } {
  const active = activeNodeIdsForIteration(definition, phase === 'first' ? 1 : 2)
  const byId = new Map(definition.steps.map((node) => [node.id, node]))
  const terminals = [...terminalNodeIds(definition)].filter((id) => active.has(id))

  // A node reaches a terminal iff the terminal's transitive dependsOn closure
  // contains it — walk backwards from the active terminals. Intermediate
  // nodes may be inactive in this phase (skipped nodes pass their out-edges
  // through), so the walk ignores the active filter.
  const reaching = new Set<string>()
  const queue = [...terminals]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (reaching.has(id)) continue
    reaching.add(id)
    for (const dependency of normalizeDependsOn(byId.get(id)?.dependsOn)) {
      queue.push(dependency.node)
    }
  }

  const disconnected = [...active].filter((id) => !reaching.has(id)).sort()
  return { disconnected, terminals }
}

function validateGraph(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = []
  const byId = new Map<string, WorkflowNode>()

  for (const node of definition.steps) {
    const existing = byId.get(node.id)
    if (existing !== undefined) {
      issues.push({
        code: 'duplicate-node-id',
        message: `Duplicate workflow node id "${node.id}" (types: ${existing.type}, ${node.type}).`,
      })
    } else {
      byId.set(node.id, node)
    }
  }
  if (issues.length > 0) return issues

  for (const node of definition.steps) {
    for (const dependency of normalizeDependsOn(node.dependsOn)) {
      const upstream = byId.get(dependency.node)
      if (upstream === undefined) {
        issues.push({
          code: 'unknown-dependency',
          message: `Workflow node "${node.id}" depends on unknown node "${dependency.node}".`,
        })
        continue
      }
      if (dependency.on !== undefined) {
        const allowed = WORKFLOW_CONDITION_OUTCOMES[upstream.type]
        if (!allowed.includes(dependency.on)) {
          issues.push({
            code: 'invalid-condition-edge',
            message:
              allowed.length > 0
                ? `Workflow node "${node.id}" has edge on "${dependency.on}" from "${upstream.type}" node "${upstream.id}"; allowed: ${allowed.join(' | ')}.`
                : `Workflow node "${node.id}" declares a conditional edge on "${dependency.on}" from "${upstream.type}" node "${upstream.id}", which has no outcomes.`,
          })
        }
      }
    }
  }

  const cycle = findDependencyCycle(definition)
  if (cycle !== null) {
    issues.push({
      code: 'dependency-cycle',
      message: `Workflow definition contains a dependency cycle: ${cycle.join(' -> ')}. Iterate is not a graph cycle — repeat the acyclic DAG across iterations instead (plan §153).`,
    })
  }

  for (const phase of ['first', 'subsequent'] as const) {
    const { disconnected, terminals } = unreachableAfterFiltering(definition, phase)
    if (disconnected.length > 0) {
      issues.push({
        code: 'iteration-disconnected',
        message: `Workflow node(s) ${disconnected.map((id) => `"${id}"`).join(', ')} cannot reach an active terminal node in the "${phase}" iteration phase after runOn filtering.`,
      })
    }
    if (terminals.length === 0) {
      issues.push({
        code: 'iteration-disconnected',
        message: `No terminal node is active in the "${phase}" iteration phase after runOn filtering; the filtered subgraph must stay connected to at least one terminal node.`,
      })
    }
  }

  return issues
}

/**
 * Parses and fully validates an unknown input as a WorkflowDefinition.
 * Never throws: shape errors and graph-rule violations both come back as
 * structured issues.
 */
export function validateWorkflowDefinition(input: unknown): WorkflowValidation {
  const parsed = workflowDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalid-shape' as const,
        message: `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`,
      })),
    }
  }
  const issues = validateGraph(parsed.data)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, definition: parsed.data }
}
