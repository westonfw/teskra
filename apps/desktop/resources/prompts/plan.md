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

## Teskra Agent Protocol

{{protocol}}

## Handoff (required)

When you finish, write your handoff as a JSON file at
`{{env.TESKRA_HANDOFF_PATH}}` conforming to the WorkerHandoff contract: required
fields `runId`, `type`, `summary`; optional fields `filesChanged`,
`commandsRun`, `tests`, `findings`, `blockers`, `suggestedNextAction`. Use
`"type": "analysis"` for a plan. Teskra reads this file after your process
exits — it is the only reliable channel back, so writing it is mandatory.
Store any large outputs (full plan documents, diagrams, logs) as files under
`{{env.TESKRA_ARTIFACT_DIR}}` and reference them from the handoff.

## Progress (optional)

While you work you may append progress events — one JSON object per line,
append-only — to `{{env.TESKRA_PROGRESS_PATH}}`, e.g.
`{"kind": "progress", "message": "Drafted the plan outline", "percent": 40}`.
Valid kinds are `progress`, `blocker`, `question`, `note`. This channel is
optional and never replaces the handoff.
