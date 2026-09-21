// Guards the Milestone <-> design doc consistency check: the parser must
// read both heading levels and every registered doc pair must currently agree
// end-to-end.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  checkAllTaskDocs,
  checkTaskDocs,
  compareTaskEntries,
  DESIGN_DOC,
  extractSection,
  parseTaskEntries,
  TASK_DOC_PAIRS,
  TASKS_DOC,
} from './check-task-docs.mjs'

const tasksFixture = `# Milestone 24 — Multi-Account & Agent Profiles

## TASK-094 — Account Profile Contracts

**优先级：P0**

**依赖：TASK-003**

## TASK-095 — Account Profile Database Migration

**优先级：P0**

**依赖：TASK-006, TASK-094**

---

# 24. 建议的实际执行顺序
`

const designFixture = `## 59. 任务拆分

### TASK-094 — Account Profile Contracts

**优先级：P0**

**依赖：TASK-003**

### TASK-095 — Account Profile Database Migration

**优先级：P0**

**依赖：TASK-006, TASK-094**

## 60. 推荐实施顺序
`

describe('extractSection', () => {
  it('stops at the next level-1 heading for the milestone section', () => {
    const section = extractSection(tasksFixture, /^# Milestone 24\b/, /^# /)
    expect(section).toContain('TASK-095')
    expect(section).not.toContain('建议的实际执行顺序')
  })
})

describe('parseTaskEntries', () => {
  it('parses both heading levels with priority and dependency sets', () => {
    const tasks = parseTaskEntries(extractSection(designFixture, /^## 59\./, /^## 60\./))
    expect([...tasks.keys()]).toEqual(['094', '095'])
    expect(tasks.get('094')).toMatchObject({ priority: 'P0', title: 'Account Profile Contracts' })
    expect([...tasks.get('095').deps]).toEqual(['TASK-006', 'TASK-094'])
  })
})

describe('compareTaskEntries', () => {
  it('reports missing tasks, priority drift, and dependency drift', () => {
    const authoritative = parseTaskEntries(extractSection(tasksFixture, /^# Milestone 24\b/, /^# /))
    const drifted = designFixture
      .replace('**优先级：P0**\n\n**依赖：TASK-003**', '**优先级：P1**\n\n**依赖：TASK-003**')
      .replace('**依赖：TASK-006, TASK-094**', '**依赖：TASK-006**')
    const design = parseTaskEntries(extractSection(drifted, /^## 59\./, /^## 60\./))

    const diffs = compareTaskEntries(authoritative, design)
    expect(diffs.some((d) => d.includes('TASK-094: priority mismatch'))).toBe(true)
    expect(diffs.some((d) => d.includes('TASK-095: dependency mismatch'))).toBe(true)

    design.delete('095')
    expect(
      compareTaskEntries(authoritative, design).some((d) =>
        d.includes('TASK-095: missing from the design doc'),
      ),
    ).toBe(true)
  })
})

describe('checkTaskDocs', () => {
  it('accepts a custom pair so a second milestone can be checked with its own section anchors', () => {
    const pair = {
      label: 'fixture',
      designDoc: 'unused',
      milestoneStart: /^# Milestone 24\b/,
      designStart: /^## 59\./,
      designEnd: /^## 60\./,
    }
    expect(checkTaskDocs(tasksFixture, designFixture, pair)).toEqual([])
  })
})

describe('repository documents', () => {
  it('Milestone 24 and the design doc §59 currently agree', () => {
    const diffs = checkTaskDocs(readFileSync(TASKS_DOC, 'utf8'), readFileSync(DESIGN_DOC, 'utf8'))
    expect(diffs).toEqual([])
  })

  it('every registered milestone/design-doc pair currently agrees', () => {
    const results = checkAllTaskDocs()
    expect(results.map((result) => result.label)).toEqual(TASK_DOC_PAIRS.map((pair) => pair.label))
    for (const { label, diffs } of results) {
      expect(diffs, label).toEqual([])
    }
  })
})
