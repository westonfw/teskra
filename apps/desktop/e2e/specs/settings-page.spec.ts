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

  test('field controls stay inside their card at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 })
    await page.getByRole('menuitem', { name: 'Settings' }).click()

    const card = page.locator('.ant-card', { hasText: 'Logging' }).first()
    const control = card.locator('.settings-field-control > *').first()
    await expect(control).toBeVisible()

    const cardBox = await card.boundingBox()
    const controlBox = await control.boundingBox()
    expect(cardBox).not.toBeNull()
    expect(controlBox).not.toBeNull()
    expect(controlBox!.x).toBeGreaterThanOrEqual(cardBox!.x)
    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(
      cardBox!.x + cardBox!.width + 1,
    )
  })
})
