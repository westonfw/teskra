# Teskra Agent Protocol

Teskra runs you (the coding agent) as a child process and communicates with
you through environment variables and files — never through your terminal
output. This document is the authoritative description of that contract.

## Environment variables

Teskra injects these variables into your process environment:

- `TESKRA_RUN_ID` — the id of the current Agent Run. Echo it verbatim in your
  handoff.
- `TESKRA_HANDOFF_PATH` — absolute path of the handoff JSON file you MUST
  write before exiting (see below).
- `TESKRA_ARTIFACT_DIR` — directory for large outputs (logs, diffs, generated
  files, screenshots). Store them here and reference them from the handoff
  instead of inlining them.
- `TESKRA_PROGRESS_PATH` — append-only progress file in JSON Lines format (see
  below). Writing it is optional.

These paths may point outside your working directory; write to them verbatim,
exactly as given.

## Handoff (required)

Before your process exits, write a single JSON file at `TESKRA_HANDOFF_PATH`
conforming to the WorkerHandoff contract:

- Required fields: `runId` (must equal `TESKRA_RUN_ID`), `type`, `summary`.
- Optional fields: `filesChanged`, `commandsRun`, `tests`, `findings`,
  `blockers`, `suggestedNextAction`; reviewers also use `criterionScores` and
  `targetRunId`.

Teskra reads this file after your process exits. It is the only reliable
channel back, so writing it is mandatory even when the run failed — use
`blockers` and `suggestedNextAction` to describe what remains.

## Progress events (optional)

While running you MAY append progress events to `TESKRA_PROGRESS_PATH`. The
file is JSON Lines: exactly one JSON object per line, append-only — never
rewrite, reorder, or truncate it. Each line is validated against this schema:

```json
{
  "kind": "progress | blocker | question | note",
  "message": "<1-2000 chars>",
  "percent": 40,
  "at": "<ISO 8601>",
  "data": {}
}
```

- `kind` (required): `progress` for status updates, `blocker` when you cannot
  continue without a human, `question` when you need clarification but can
  keep working, `note` for anything else worth recording.
- `message` (required): 1–2000 characters, human-readable.
- `percent` (optional): integer 0–100.
- `at` (optional): ISO 8601 timestamp; Teskra records the read time when
  absent.
- `data` (optional): small object, at most 4 KiB serialized.

Limits: lines over 8 KiB are skipped; once the file exceeds 4 MiB Teskra
stops following it. Invalid lines are skipped and never fail your run.

## What Teskra does NOT read

- Your stdout/stderr is never treated as a result: terminal output is for
  humans only. Nothing you print becomes a handoff, a finding, a score, or a
  status change.
- Your exit code does not replace the handoff file.
- Progress events are observation-only: they never change the run state, stop
  your process, or answer a `question` by themselves.
- Never write secrets (tokens, API keys, passwords) into the handoff, the
  progress file, or artifacts.
