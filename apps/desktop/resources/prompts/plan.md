# Plan the Task

You are acting as the {{role}} for the following task.

## Task

- **Title:** {{task.title}}
- **Description:** {{task.description}}

## Acceptance Criteria

{{criteria}}

## Workspace Memory

{{memory}}

## Previous Handoff

{{previousHandoff}}

## Instructions

Analyze the task and produce a concrete implementation plan: ordered steps, the
files you expect to touch, the risks you see, and how each acceptance criterion
will be verified. Do not modify code in this phase.

## Handoff (required)

When you finish, write your handoff as a JSON file at
`{{env.TESKRA_HANDOFF_PATH}}` conforming to the WorkerHandoff contract: required
fields `runId`, `type`, `summary`; optional fields `filesChanged`,
`commandsRun`, `tests`, `findings`, `blockers`, `suggestedNextAction`. Use
`"type": "analysis"` for a plan. Teskra reads this file after your process
exits — it is the only reliable channel back, so writing it is mandatory.
Store any large outputs (full plan documents, diagrams, logs) as files under
`{{env.TESKRA_ARTIFACT_DIR}}` and reference them from the handoff.
