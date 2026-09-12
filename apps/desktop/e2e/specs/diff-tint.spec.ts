import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('diff tint probe', () => {
  test('screenshots the tinted diff and asserts line classes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const repoDir = createGitRepo()
    try {
      appendFileSync(join(repoDir, 'hello.txt'), 'world\n')
      writeFileSync(join(repoDir, 'added.ts'), 'export const x = 1\n')
      await openAndSwitchWorkspace(page, repoDir)
      await page.getByRole('menuitem', { name: 'Git' }).click()
      await page.getByText('hello.txt').first().click()
      await expect(page.locator('.diff-line-add').first()).toBeVisible()
      await expect(page.locator('.diff-line-hunk').first()).toBeVisible()
      await expect(page.locator('.diff-line-meta').first()).toBeVisible()
      await page.getByText('added.ts').first().click()
      await expect(page.locator('.diff-line-add').first()).toBeVisible()
      await page.screenshot({ path: '/tmp/teskra-ui-shots/d1-tinted-diff.png' })
    } finally {
      removeDir(repoDir)
    }
  })
})
