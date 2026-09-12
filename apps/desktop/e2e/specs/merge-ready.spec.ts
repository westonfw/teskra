import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

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

test.describe('Merge Ready navigation', () => {
  test('home Merge Ready jumps to the run drawer with the merge panel; topbar shows the live branch', async ({
    page,
  }) => {
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
      await createDialog.getByPlaceholder('Task title').fill('工作流合并巡检')
      await createDialog.getByRole('button', { name: 'OK' }).click()
      await page.locator('.task-list-item', { hasText: '工作流合并巡检' }).click()
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

      // The topbar resolves the live branch from git status, not the
      // (possibly empty) open-time snapshot.
      await expect(page.locator('.workbench-topbar')).toContainText('main', { timeout: 15_000 })

      // Home → Merge Ready lists the workflow's worktree; clicking it opens
      // the owning Run's drawer on the Runs page.
      // Home → Merge Ready lists the workflow's worktree; clicking it opens
      // the owning Run's drawer on the Runs page.
      await page.getByRole('menuitem', { name: 'Home' }).click()
      const mergeReadyCard = page.locator('.dashboard-card', { hasText: 'Merge Ready' })
      const item = mergeReadyCard.locator('.dashboard-item').first()
      await expect(item).toBeVisible({ timeout: 20_000 })
      await item.click()

      const drawer = page.locator('.ant-drawer-open')
      await expect(drawer).toBeVisible({ timeout: 15_000 })
      await expect(drawer.getByText('Worktree', { exact: true })).toBeVisible()
      await expect(drawer.getByRole('button', { name: /Merge into main/u })).toBeVisible()
      await page.screenshot({ path: '/tmp/teskra-ui-shots/mr1-merge-ready-drawer.png' })
    } finally {
      removeDir(repoDir)
    }
  })
})
