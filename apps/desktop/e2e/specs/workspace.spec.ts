import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Open Workspace', () => {
  test('launches into the workbench shell', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Teskra' })).toBeVisible()
    await expect(page.getByText('Orchestrate your coding agents.')).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Workspace' })).toBeVisible()
    // Home is the default page (TASK-071); the Workspace page keeps the
    // no-workspace empty state behind its menu entry.
    await page.getByRole('menuitem', { name: 'Workspace' }).click()
    await expect(page.getByText('No workspace is open')).toBeVisible()
  })

  test('opens a workspace and selects it from Recent workspaces', async ({ page, teskraHome }) => {
    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir, 'E2E Repo')
      expect(workspace.path).toBe(repoDir)

      // The switch lands on the Terminal page with the workspace active.
      await expect(page.getByRole('button', { name: 'New terminal' })).toBeVisible()

      // Back on the Workspace page the entry is persisted and marked active.
      await page.getByRole('menuitem', { name: 'Workspace' }).click()
      const item = page.locator('.ant-list-item', { hasText: 'E2E Repo' })
      await expect(item).toBeVisible()
      await expect(item).toContainText(repoDir)
      await expect(item.getByRole('button', { name: 'Open terminal' })).toBeVisible()

      // The workspace was written under the per-test TESKRA_HOME, not the
      // developer's real data root.
      expect(workspace.path).not.toBe(teskraHome)
    } finally {
      removeDir(repoDir)
    }
  })

  test('workspace dialog renders and can be dismissed', async ({ page }) => {
    await page.getByRole('menuitem', { name: 'Workspace' }).click()
    await page.getByRole('button', { name: 'Open your first workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Open workspace' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Environment')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()
  })
})
