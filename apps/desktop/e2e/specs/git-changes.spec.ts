import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('View Diff', () => {
  test('shows working-tree changes and the selected file patch', async ({ page }) => {
    const repoDir = createGitRepo()
    try {
      appendFileSync(join(repoDir, 'hello.txt'), 'teskra e2e change\n')

      await openAndSwitchWorkspace(page, repoDir)
      await page.getByRole('menuitem', { name: 'Git' }).click()

      await expect(page.getByRole('heading', { name: 'Review repository changes' })).toBeVisible()
      await expect(page.getByText('1 file changed')).toBeVisible()

      const row = page.locator('.change-file-row', { hasText: 'hello.txt' })
      await expect(row).toBeVisible()
      await expect(row.getByText('modified')).toBeVisible()
      await row.click()

      await expect(page.locator('.diff-patch')).toContainText('+teskra e2e change')
      await expect(page.locator('.changes-page')).toContainText('main')
    } finally {
      removeDir(repoDir)
    }
  })
})
