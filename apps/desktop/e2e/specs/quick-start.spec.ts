import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

import type { AgentRun, Task } from '@teskra/contracts'

/**
 * TASK-135 (Milestone 26) — the thread-first quick-start input on the Tasks
 * page: two lines of text create the Task (first line = title, rest =
 * description) and start the first Run from the resolved defaults. The
 * (per-test isolated) global layer pins agents.defaultAgent to the Fake
 * Agent so the default resolution is deterministic on hosts that have real
 * CLIs installed — the workspace layer would need a trusted workspace.
 */
test.describe('Quick start (TASK-135)', () => {
  test('Tasks page input creates the Task and starts the first Run', async ({ page }) => {
    test.setTimeout(120_000)
    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir)
      await page.evaluate(
        async ({ runtime, nodePath }) => {
          const overridden = await window.teskra.agent.setExecutableOverride({
            agentId: 'fake',
            runtime,
            path: nodePath,
          })
          if (!overridden.ok) throw new Error(overridden.error.message)
          const configured = await window.teskra.settings.updateConfig({
            layer: 'global',
            patch: { agents: { defaultAgent: 'fake' } },
          })
          if (!configured.ok) throw new Error(configured.error.message)
        },
        { runtime: workspace.runtime, nodePath: process.execPath },
      )

      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      const composer = page.locator('.quick-start-input').first()
      // The defaults line shows the resolved Agent before sending.
      await expect(composer.locator('.quick-start-defaults-summary')).toContainText('fake')
      await composer
        .getByPlaceholder('Describe what you want done…')
        .fill('E2E Quick Task\nDetails for the first run')
      await composer.getByRole('button', { name: 'Send' }).click()

      // The Task appears with the first line as its title and is selected.
      await expect(page.locator('.task-list-item', { hasText: 'E2E Quick Task' })).toBeVisible()

      // Persisted through the real IPC boundary: title/description split and
      // the first Run bound to the new Task inside a pre-built worktree. The
      // send resolves only after the worktree is built and the process is
      // up, so poll until the Run row exists.
      let outcome: { task: Task; run: AgentRun } | undefined
      await expect
        .poll(
          async () => {
            outcome = await page.evaluate(async (workspaceId) => {
              const tasks = await window.teskra.task.list({ workspaceId })
              if (!tasks.ok) throw new Error(tasks.error.message)
              const task = tasks.data.find((entry) => entry.title === 'E2E Quick Task')
              if (task === undefined) return undefined
              const runs = await window.teskra.agent.list({ workspaceId })
              if (!runs.ok) throw new Error(runs.error.message)
              const run = runs.data.find((entry) => entry.taskId === task.id)
              return run === undefined ? undefined : { task, run }
            }, workspace.id)
            return outcome !== undefined
          },
          { timeout: 30_000, intervals: [500] },
        )
        .toBe(true)
      if (outcome === undefined) throw new Error('the first Run was not started')
      expect(outcome.task.description).toBe('Details for the first run')
      expect(outcome.run.agentType).toBe('fake')
      expect(outcome.run.executionMode).toBe('orchestrated')
      expect(outcome.run.prompt).toBe('E2E Quick Task\nDetails for the first run')
      expect(outcome.run.worktreeId).toBeDefined()

      // The Fake Agent settles the first run.
      const runId = outcome.run.id
      await expect
        .poll(
          async () => {
            const status = await page.evaluate(async (id) => {
              const run = await window.teskra.agent.get({ runId: id })
              if (!run.ok) throw new Error(run.error.message)
              return run.data?.status
            }, runId)
            return status
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBe('completed')
    } finally {
      removeDir(repoDir)
    }
  })
})
