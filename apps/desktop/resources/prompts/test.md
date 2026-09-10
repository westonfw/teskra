# Test the Change

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

Run the project's test suite and any checks specific to the task. Map the
the acceptance criteria: state clearly which criteria are verified by tests and
which are not covered. Do not fix failures in this phase — report them.

## Handoff (required)

When you finish, write your handoff as a JSON file at
`{{env.TESKRA_HANDOFF_PATH}}` conforming to the WorkerHandoff contract: required
fields `runId`, `type`, `summary`; optional fields `filesChanged`,
`commandsRun`, `tests`, `findings`, `blockers`, `suggestedNextAction`. Use
`"type": "test"` and record every executed check in `tests` (name, passed,
detail) and every command in `commandsRun`. Teskra reads this file after your
process exits — it is the only reliable channel back, so writing it is
mandatory. Store any large outputs (full test logs, coverage reports) as files
under `{{env.TESKRA_ARTIFACT_DIR}}` and reference them from the handoff.
