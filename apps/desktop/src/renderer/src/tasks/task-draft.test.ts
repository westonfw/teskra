import type { Task } from '@teskra/contracts'
import { describe, expect, it } from 'vitest'

import { taskDraftResetKey } from './task-draft'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: 'workspace-1',
    title: 'Demo',
    status: 'draft',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('taskDraftResetKey', () => {
  it('does not change when a refresh only touches unrelated fields', () => {
    // Regression: the Task page reset its draft fields whenever the selected
    // Task object identity changed, so a status change (or any background
    // task.updated event) wiped the title/description/prompt being edited.
    const before = task()
    const refreshed = task({ status: 'running', updatedAt: '2026-09-10T01:00:00.000Z' })
    expect(taskDraftResetKey(refreshed)).toBe(taskDraftResetKey(before))
  })

  it('changes when the draft source content changes', () => {
    const before = task()
    expect(taskDraftResetKey(task({ id: 'task-2' }))).not.toBe(taskDraftResetKey(before))
    expect(taskDraftResetKey(task({ title: 'Renamed' }))).not.toBe(taskDraftResetKey(before))
    expect(taskDraftResetKey(task({ description: 'Details' }))).not.toBe(taskDraftResetKey(before))
    expect(taskDraftResetKey(undefined)).not.toBe(taskDraftResetKey(before))
  })
})
