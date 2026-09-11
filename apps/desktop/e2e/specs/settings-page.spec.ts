import { test, expect } from '../fixtures'

test.describe('Settings page', () => {
  test('renders without a workspace (no renderer crash)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    // Regression: an unstable zustand selector (fresh [] per snapshot) crashed
    // the whole renderer with React #185 when no config was resolved yet.
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    await expect(page.locator('.ant-card', { hasText: 'Logging' }).first()).toBeVisible()
  })
})
