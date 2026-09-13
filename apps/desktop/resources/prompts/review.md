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
`commandsRun`, `tests`, `findings`, `criterionScores`, `targetRunId`,
`blockers`, `suggestedNextAction`. Use `"type": "review"` and put every review
finding into `findings` (each with `severity`, `title`, and where applicable
`file`, `line`, `criterionId`, `evidence`). Score every acceptance criterion in
`criterionScores` as `{ "criterionId", "result": "pass" | "fail" | "unknown",
"evidence": [...] }` — each `criterionId` MUST be copied verbatim from the
bracketed id in the Acceptance Criteria list above (never invent ordinals or
short ids; scores with unknown ids are discarded and the criterion is recorded
as unreviewed). Use `unknown` when you cannot verify a criterion, never
guess `pass`. When `TESKRA_REVIEW_TARGET_RUN_ID` is set in your environment,
echo it as `targetRunId` so the scores are attributed to the reviewed run.
Teskra reads this file after your process exits — it is the only reliable
channel back, so writing it is mandatory. Store any large outputs (full
review reports, diffs) as files under `{{env.TESKRA_ARTIFACT_DIR}}` and
reference them from the handoff.
