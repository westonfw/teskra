# Fix the Reported Issues

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

Address the findings and blockers described above (see the previous handoff and
the task description). Make the smallest correct change for each issue, keep
the fix scoped to the task, and re-verify every acceptance criterion before
finishing.

## Handoff (required)

When you finish, write your handoff as a JSON file at
`{{env.TESKRA_HANDOFF_PATH}}` conforming to the WorkerHandoff contract: required
fields `runId`, `type`, `summary`; optional fields `filesChanged`,
`commandsRun`, `tests`, `findings`, `blockers`, `suggestedNextAction`. Use
`"type": "implementation"` and list each fixed finding in the summary or in
`suggestedNextAction` if anything remains. Teskra reads this file after your
process exits — it is the only reliable channel back, so writing it is
mandatory. Store any large outputs (logs, before/after diffs) as files under
`{{env.TESKRA_ARTIFACT_DIR}}` and reference them from the handoff.
