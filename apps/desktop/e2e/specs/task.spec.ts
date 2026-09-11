import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Create Task', () => {
  test('creates a task through the UI and shows its detail', async ({ page }) => {
    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir)

      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      await expect(page.getByText('Create your first Task')).toBeVisible()

      await page.getByRole('button', { name: 'Create Task' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create Task' })
      await expect(dialog).toBeVisible()
      await dialog.getByPlaceholder('Task title').fill('E2E Test Task')
      await dialog
        .getByPlaceholder('Description and desired outcome')
        .fill('Created by the TASK-076 E2E suite.')
      await dialog.getByRole('button', { name: 'OK' }).click()
      await expect(dialog).not.toBeVisible()

      // The task appears in the list and selecting it opens the detail card.
      const item = page.locator('.task-list-item', { hasText: 'E2E Test Task' })
      await expect(item).toBeVisible()
      await expect(item.locator('.ant-tag').first()).toHaveText('draft')
      await item.click()
      const detail = page.locator('.task-detail-card', { hasText: 'Task detail' }).first()
      await expect(detail).toBeVisible()
      await expect(detail.locator('input').first()).toHaveValue('E2E Test Task')

      // Persisted through the real IPC boundary.
      const titles = await page.evaluate(async (workspaceId) => {
        const listed = await window.teskra.task.list({ workspaceId })
        if (!listed.ok) throw new Error(`task.list failed: ${listed.error.message}`)
        return listed.data.map((task) => task.title)
      }, workspace.id)
      expect(titles).toContain('E2E Test Task')
    } finally {
      removeDir(repoDir)
    }
  })
})
