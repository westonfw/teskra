import { test, expect } from '../fixtures'

test.describe('Permission rule modal', () => {
  test('form controls fill the modal width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await page.getByRole('menuitem', { name: 'Permissions' }).click()
    await page.getByRole('button', { name: 'New rule' }).click()
    const dialog = page.getByRole('dialog', { name: 'New permission rule' })
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(600)

    // Regression: the vertical Space shrink-wrapped and the Selects rendered
    // at their tiny intrinsic widths instead of filling the modal.
    const body = await dialog.locator('.ant-modal-body').boundingBox()
    const selects = dialog.locator('.ant-select')
    expect(body).not.toBeNull()
    const count = await selects.count()
    expect(count).toBeGreaterThan(0)
    for (let index = 0; index < count; index += 1) {
      const box = await selects.nth(index).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThan(body!.width - 60)
    }
  })
})
