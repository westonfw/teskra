# Implement the Task

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

Implement the task in the current working tree. Keep the change scoped to the
task, follow the conventions of the surrounding code, and verify your work
against every acceptance criterion before finishing.

## Teskra Agent Protocol

{{protocol}}

## Handoff (required)

When you finish, write your handoff as a JSON file at
`{{env.TESKRA_HANDOFF_PATH}}` conforming to the WorkerHandoff contract: required
fields `runId`, `type`, `summary`; optional fields `filesChanged`,
`commandsRun`, `tests`, `findings`, `blockers`, `suggestedNextAction`. Use
`"type": "implementation"`. Teskra reads this file after your process exits —
it is the only reliable channel back, so writing it is mandatory. Store any
large outputs (logs, generated files, screenshots) as files under
`{{env.TESKRA_ARTIFACT_DIR}}` and reference them from the handoff.

## Progress (optional)

While you work you may append progress events — one JSON object per line,
append-only — to `{{env.TESKRA_PROGRESS_PATH}}`, e.g.
`{"kind": "progress", "message": "Implemented the parser", "percent": 60}`.
Valid kinds are `progress`, `blocker`, `question`, `note`. This channel is
optional and never replaces the handoff.
