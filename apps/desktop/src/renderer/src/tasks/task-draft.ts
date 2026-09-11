import type { Task } from '@teskra/contracts'

/**
 * Reset key for the Task page's draft fields (title / description / Run
 * prompt). It changes only when the content the draft was initialized from
 * changes — switching Tasks, or the title/description itself being updated —
 * never when a refresh merely replaces the Task object because an unrelated
 * field (status, updatedAt) changed. Keying the reset on object identity
 * wiped in-progress edits on every background task.updated event.
 */
export function taskDraftResetKey(task: Task | undefined): string {
  return task === undefined ? '' : JSON.stringify([task.id, task.title, task.description ?? null])
}
