import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Terminal layout', () => {
  test('terminal fills the window height and follows resizes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const repoDir = createGitRepo()
    try {
      await openAndSwitchWorkspace(page, repoDir)
      await page.getByRole('menuitem', { name: 'Terminal' }).click()
      await page.getByRole('button', { name: 'New terminal' }).click()
      const view = page.locator('.terminal-view').first()
      await expect(view).toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(1000)

      // Regression: the app shell used to cap at ~505px because .ant-app had no
      // height, so the terminal occupied only half of an 800px window.
      const initial = await view.boundingBox()
      expect(initial).not.toBeNull()
      expect(initial!.height).toBeGreaterThan(600)

      await page.setViewportSize({ width: 1280, height: 950 })
      await page.waitForTimeout(800)
      const grown = await view.boundingBox()
      expect(grown).not.toBeNull()
      expect(grown!.height).toBeGreaterThan(initial!.height + 100)

      // Close the session so its PTY does not keep the repo cwd busy on
      // Windows (the app deliberately does not kill PTYs on dispose).
      await page.locator('.terminal-tabs .ant-tabs-tab-remove').first().click()
      await expect(page.getByText('No terminals in this workspace')).toBeVisible({
        timeout: 10_000,
      })
    } finally {
      removeDir(repoDir)
    }
  })
})
