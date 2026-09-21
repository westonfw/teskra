// Milestone <-> design doc consistency check:
//
//   docs/teskra-tasks.md is the sole authority for TASK ids, priorities, and
//   dependencies. Each Milestone that has a companion design doc keeps a copy
//   of the same entries there so the rationale sits next to the acceptance
//   criteria. The two drifted apart in past revisions (TASK-100 / TASK-117 /
//   TASK-118), so this script compares the Task set, per-Task priority, and
//   per-Task dependency set of both documents and exits non-zero on any
//   difference.
//
//   Pairs checked (see TASK_DOC_PAIRS):
//     Milestone 24 <-> docs/teskra-multi-account-subscription-implementation.md §59
//     Milestone 25 <-> docs/teskra-run-observability-and-decisions-implementation.md §16
//     Milestone 26 <-> docs/teskra-thread-first-interaction-implementation.md §14
//
// Usage:
//   npm run check:task-docs
//
// When changing dependencies, edit docs/teskra-tasks.md first, then sync the
// design doc and re-run this script.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const TASKS_DOC = join(repoRoot, 'docs/teskra-tasks.md')
export const DESIGN_DOC = join(repoRoot, 'docs/teskra-multi-account-subscription-implementation.md')
export const M25_DESIGN_DOC = join(
  repoRoot,
  'docs/teskra-run-observability-and-decisions-implementation.md',
)
export const M26_DESIGN_DOC = join(
  repoRoot,
  'docs/teskra-thread-first-interaction-implementation.md',
)

// One entry per (Milestone, design doc) pair. `milestoneStart` matches the
// level-1 heading in teskra-tasks.md; `designStart` / `designEnd` bracket the
// task-list section of the design doc.
export const TASK_DOC_PAIRS = [
  {
    label: 'Milestone 24 <-> design doc §59',
    designDoc: DESIGN_DOC,
    milestoneStart: /^# Milestone 24\b/,
    designStart: /^## 59\. 任务拆分/,
    designEnd: /^## 60\./,
  },
  {
    label: 'Milestone 25 <-> design doc §16',
    designDoc: M25_DESIGN_DOC,
    milestoneStart: /^# Milestone 25\b/,
    designStart: /^## 16\. 任务拆分/,
    designEnd: /^## 17\./,
  },
  {
    label: 'Milestone 26 <-> design doc §14',
    designDoc: M26_DESIGN_DOC,
    milestoneStart: /^# Milestone 26\b/,
    designStart: /^## 14\. 任务拆分/,
    designEnd: /^## 15\./,
  },
]

// Slice the lines of `markdown` between the first line matching `startRe`
// (inclusive) and the next line matching `endRe` (exclusive).
export function extractSection(markdown, startRe, endRe) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => startRe.test(line))
  if (start === -1) {
    throw new Error(`section start not found: ${startRe}`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// Parse `## TASK-NNN — title` / `### TASK-NNN — title` entries into a Map of
// id -> { id, title, priority, deps }. Priority comes from a `**优先级：Pn**`
// line, dependencies from a `**依赖：...**` line (comma-separated, `无` = none).
export function parseTaskEntries(section) {
  const headingRe = /^#{2,3} TASK-(\d+) — (.+)$/gm
  const headings = []
  let match
  while ((match = headingRe.exec(section)) !== null) {
    headings.push({ id: match[1], title: match[2].trim(), start: match.index })
  }

  const tasks = new Map()
  for (let i = 0; i < headings.length; i++) {
    const { id, title, start } = headings[i]
    const body = section.slice(start, i + 1 < headings.length ? headings[i + 1].start : undefined)

    const priorityMatch = body.match(/\*\*优先级：P(\d)\*\*/)
    if (!priorityMatch) {
      throw new Error(`TASK-${id} has no **优先级：Pn** line`)
    }
    const depsMatch = body.match(/\*\*依赖：([^*]+)\*\*/)
    if (!depsMatch) {
      throw new Error(`TASK-${id} has no **依赖：...** line`)
    }
    const deps = new Set(
      depsMatch[1]
        .split(/[,，]/)
        .map((dep) => dep.trim())
        .filter((dep) => dep.length > 0 && dep !== '无'),
    )

    if (tasks.has(id)) {
      throw new Error(`TASK-${id} appears more than once`)
    }
    tasks.set(id, { id: `TASK-${id}`, title, priority: `P${priorityMatch[1]}`, deps })
  }
  return tasks
}

// Compare two parsed task maps; returns a list of human-readable differences
// (empty when the documents agree).
export function compareTaskEntries(authoritative, design) {
  const diffs = []

  for (const id of authoritative.keys()) {
    if (!design.has(id)) {
      diffs.push(`TASK-${id}: missing from the design doc task section`)
    }
  }
  for (const id of design.keys()) {
    if (!authoritative.has(id)) {
      diffs.push(
        `TASK-${id}: present in the design doc task section but missing from teskra-tasks.md`,
      )
    }
  }

  for (const [id, expected] of authoritative) {
    const actual = design.get(id)
    if (!actual) continue

    if (actual.priority !== expected.priority) {
      diffs.push(
        `TASK-${id}: priority mismatch — teskra-tasks.md says ${expected.priority}, ` +
          `design doc says ${actual.priority}`,
      )
    }

    const missing = [...expected.deps].filter((dep) => !actual.deps.has(dep))
    const extra = [...actual.deps].filter((dep) => !expected.deps.has(dep))
    if (missing.length > 0 || extra.length > 0) {
      const parts = []
      if (missing.length > 0) parts.push(`design doc is missing deps: ${missing.join(', ')}`)
      if (extra.length > 0) parts.push(`design doc has extra deps: ${extra.join(', ')}`)
      diffs.push(`TASK-${id}: dependency mismatch — ${parts.join('; ')}`)
    }
  }

  return diffs
}

// Check one pair. Defaults to the Milestone 24 pair for backward compatibility
// with existing callers and tests.
export function checkTaskDocs(tasksMarkdown, designMarkdown, pair = TASK_DOC_PAIRS[0]) {
  const milestone = extractSection(tasksMarkdown, pair.milestoneStart, /^# /)
  const designSection = extractSection(designMarkdown, pair.designStart, pair.designEnd)
  return compareTaskEntries(parseTaskEntries(milestone), parseTaskEntries(designSection))
}

// Check every registered pair; returns [{ label, diffs }] with one entry per pair.
export function checkAllTaskDocs(readFile = (path) => readFileSync(path, 'utf8')) {
  const tasksMarkdown = readFile(TASKS_DOC)
  return TASK_DOC_PAIRS.map((pair) => ({
    label: pair.label,
    diffs: checkTaskDocs(tasksMarkdown, readFile(pair.designDoc), pair),
  }))
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const results = checkAllTaskDocs()
  const failed = results.filter((result) => result.diffs.length > 0)
  if (failed.length > 0) {
    for (const { label, diffs } of failed) {
      console.error(`check-task-docs: ${diffs.length} difference(s) — ${label}:`)
      for (const diff of diffs) {
        console.error(`  - ${diff}`)
      }
    }
    console.error('\nteskra-tasks.md is authoritative: edit it first, then sync the design doc.')
    process.exit(1)
  }
  for (const { label } of results) {
    console.log(`check-task-docs: ${label} agree (set, priority, deps).`)
  }
}
