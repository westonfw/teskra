import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Theme switching', () => {
  test('switches between light and dark and persists the choice', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const repoDir = createGitRepo()
    try {
      await openAndSwitchWorkspace(page, repoDir)

      // Default theme is light.
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 247, 250)')

      // Switch to dark via the topbar switcher.
      await page.locator('.theme-switcher').click()
      await page.locator('.ant-select-item-option', { hasText: 'Dark' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 15, 23)')

      // The persistent ADR-0002 attended warning must stay visible in dark mode.
      await page.getByRole('menuitem', { name: 'Runs' }).click()
      await expect(page.getByText('Direct writes to the main workspace').first()).toBeVisible()

      // The terminal surface follows the theme (xterm's light ANSI palette is
      // contrast-asserted in xterm-themes.test.ts).
      await page.getByRole('menuitem', { name: 'Terminal' }).click()
      await page.getByRole('button', { name: 'New terminal' }).click()
      const terminalView = page.locator('.terminal-view').first()
      await expect(terminalView).toBeVisible({ timeout: 20_000 })
      await expect(terminalView).toHaveCSS('background-color', 'rgb(9, 13, 20)')

      // The choice survives a reload (localStorage persistence).
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 15, 23)')

      // Switch back to light.
      await page.locator('.theme-switcher').click()
      await page.locator('.ant-select-item-option', { hasText: 'Light' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 247, 250)')
    } finally {
      removeDir(repoDir)
    }
  })
})
