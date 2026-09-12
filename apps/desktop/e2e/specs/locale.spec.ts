import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Locale switching', () => {
  test('switches the UI between English and Chinese and persists the choice', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const repoDir = createGitRepo()
    try {
      await openAndSwitchWorkspace(page, repoDir)

      // Default locale is English.
      await expect(page.getByRole('menuitem', { name: 'Tasks' })).toBeVisible()

      // Switch to Chinese via the topbar switcher.
      await page.locator('.locale-switcher').click()
      await page.locator('.ant-select-item-option', { hasText: '中文' }).click()
      await expect(page.getByRole('menuitem', { name: '任务' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: '设置' })).toBeVisible()

      // The previously hardcoded Chinese warning is now locale-driven: it must
      // appear in Chinese and disappear when switching back.
      await page.getByRole('menuitem', { name: '运行' }).click()
      await expect(page.getByText('直接修改主工作区，未做隔离').first()).toBeVisible()

      // The choice survives a reload (localStorage persistence).
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByRole('menuitem', { name: '任务' })).toBeVisible()

      // Switch back to English.
      await page.locator('.locale-switcher').click()
      await page.locator('.ant-select-item-option', { hasText: 'English' }).click()
      await expect(page.getByRole('menuitem', { name: 'Tasks' })).toBeVisible()
      await page.getByRole('menuitem', { name: 'Runs' }).click()
      await expect(page.getByText('Direct writes to the main workspace').first()).toBeVisible()
      await expect(page.getByText('直接修改主工作区，未做隔离')).toHaveCount(0)
    } finally {
      removeDir(repoDir)
    }
  })
})
