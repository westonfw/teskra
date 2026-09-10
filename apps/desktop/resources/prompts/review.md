# Review the Change

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

Review the current changes in the working tree against the task and its
acceptance criteria. Report findings with severity (`critical`, `high`,
`medium`, `low`), each with a title and, where applicable, the file and line.
Do not modify code in this phase.

## Handoff (required)

When you finish, write your handoff as a JSON file at
`{{env.TESKRA_HANDOFF_PATH}}` conforming to the WorkerHandoff contract: required
fields `runId`, `type`, `summary`; optional fields `filesChanged`,
`commandsRun`, `tests`, `findings`, `blockers`, `suggestedNextAction`. Use
`"type": "review"` and put every review finding into `findings`. Teskra reads
this file after your process exits — it is the only reliable channel back, so
writing it is mandatory. Store any large outputs (full review reports, diffs)
as files under `{{env.TESKRA_ARTIFACT_DIR}}` and reference them from the
handoff.
