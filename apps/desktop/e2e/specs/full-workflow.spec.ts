import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

/**
 * End-to-end drive of the default full workflow (TASK-063) through the real
 * UI. The registry-derived implementer/reviewers are real CLIs, so the repo
 * overrides `full` (ADR-0005 repo-local definitions) with Fake Agents and a
 * trivially-successful test command — the override path is part of what this
 * test exercises.
 */
const FULL_WORKFLOW_OVERRIDE = {
  id: 'full',
  description: 'e2e override: fake implementer + fake reviewer + trivial test',
  steps: [
    { id: 'implement', type: 'agent', agent: 'fake', role: 'implementer', runOn: 'first' },
    { id: 'fix', type: 'agent', agent: 'fake', role: 'fixer', runOn: 'subsequent' },
    {
      id: 'test-implement',
      type: 'shell',
      command: 'git --version',
      dependsOn: ['implement'],
      runOn: 'first',
    },
    {
      id: 'test-fix',
      type: 'shell',
      command: 'git --version',
      dependsOn: ['fix'],
      runOn: 'subsequent',
    },
    {
      id: 'review-implement',
      type: 'review-panel',
      agents: ['fake'],
      dependsOn: ['test-implement'],
      runOn: 'first',
    },
    {
      id: 'review-fix',
      type: 'review-panel',
      agents: ['fake'],
      dependsOn: ['test-fix'],
      runOn: 'subsequent',
    },
    {
      id: 'gate-implement',
      type: 'criteria-gate',
      dependsOn: [{ node: 'review-implement', on: 'approve' }],
      runOn: 'first',
    },
    {
      id: 'gate-fix',
      type: 'criteria-gate',
      dependsOn: [{ node: 'review-fix', on: 'approve' }],
      runOn: 'subsequent',
    },
  ],
}

test.describe('Full workflow', () => {
  test('runs the overridden default workflow to a terminal state', async ({ page }) => {
    test.setTimeout(240_000)
    const repoDir = createGitRepo()
    try {
      mkdirSync(join(repoDir, '.teskra', 'workflows'), { recursive: true })
      writeFileSync(
        join(repoDir, '.teskra', 'workflows', 'full.json'),
        JSON.stringify(FULL_WORKFLOW_OVERRIDE, null, 2),
      )

      const workspace = await openAndSwitchWorkspace(page, repoDir)
      await page.evaluate(
        async ({ runtime, nodePath }) => {
          const overridden = await window.teskra.agent.setExecutableOverride({
            agentId: 'fake',
            runtime,
            path: nodePath,
          })
          if (!overridden.ok) throw new Error(overridden.error.message)
        },
        { runtime: workspace.runtime, nodePath: process.execPath },
      )
      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      await page.getByRole('button', { name: 'Create Task' }).click()
      const createDialog = page.getByRole('dialog', { name: 'Create Task' })
      await createDialog.getByPlaceholder('Task title').fill('Workflow E2E')
      await createDialog.getByRole('button', { name: 'OK' }).click()
      await page.locator('.task-list-item', { hasText: 'Workflow E2E' }).click()

      // The default full workflow requires a confirmed criteria set.
      await page.getByRole('button', { name: 'Create criteria' }).click()
      await expect(page.getByText('draft').first()).toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: 'Add criterion' }).click()
      const criterionDialog = page.getByRole('dialog')
      await criterionDialog
        .getByPlaceholder('What must be true for this Task to be accepted?')
        .fill('unit tests pass')
      await criterionDialog.getByRole('button', { name: 'OK' }).click()
      await expect(criterionDialog).not.toBeVisible({ timeout: 10_000 })
      await page.getByRole('button', { name: 'Confirm version' }).click()
      await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Confirm' }).click()
      await expect(page.getByText('confirmed').first()).toBeVisible({ timeout: 10_000 })

      await page.getByRole('button', { name: 'Start full workflow' }).click()

      // The run converges through implement → test → review → gate rounds.
      await expect
        .poll(
          async () => {
            const status = await page.evaluate(async () => {
              const runs = await window.teskra.workflow.listRuns({})
              if (!runs.ok || runs.data.length === 0) return undefined
              return runs.data[0]?.status
            })
            return status
          },
          { timeout: 180_000, intervals: [2_000] },
        )
        .toMatch(/^(completed|failed|needs_user_review)$/u)

      const finalStatus = await page.evaluate(async () => {
        const runs = await window.teskra.workflow.listRuns({})
        if (!runs.ok || runs.data[0] === undefined) throw new Error('no workflow run')
        const summary = await window.teskra.workflow.runSummary({ runId: runs.data[0].id })
        if (!summary.ok) throw new Error(summary.error.message)
        return {
          status: runs.data[0].status,
          steps: summary.data.steps.map((step) => `${step.nodeId}:${step.status}`),
        }
      })
      // Round 1 must have executed the full chain; later rounds depend on the
      // gate verdict (the Fake Agent never scores criteria, so the FAIL loop
      // iterates until the controller's caps hand over to the user).
      expect(finalStatus.steps).toContain('implement:completed')
      expect(finalStatus.steps).toContain('test-implement:completed')
      expect(finalStatus.steps).toContain('review-implement:completed')
      expect(finalStatus.steps).toContain('gate-implement:completed')
      expect(['completed', 'failed', 'needs_user_review']).toContain(finalStatus.status)

      // The panel reflects the run in the UI.
      const panel = page.locator('.task-detail-card', { hasText: 'Full workflow' }).first()
      await expect(panel).toContainText('Full workflow · 1')
    } finally {
      removeDir(repoDir)
    }
  })
})
