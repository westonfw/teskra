import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

const SHOTS_DIR = resolve(__dirname, '..', 'test-results', 'ui-shots')

/**
 * Visual-review capture, not an assertion spec: walks every primary page with
 * realistic seeded content (workspace, task, completed Fake Agent run, dirty
 * git tree) in both themes and writes screenshots to e2e/test-results/ui-shots/
 * so UI changes can be eyeballed without launching the app by hand.
 */
test.describe('UI screenshots', () => {
  test('captures every primary page in both themes', async ({ page }) => {
    mkdirSync(SHOTS_DIR, { recursive: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => window.localStorage.setItem('teskra.theme', 'dark'))

    const shot = async (name: string): Promise<Buffer> => {
      // Software rendering paints a beat behind DOM updates (menu selection,
      // drawer motion); settle briefly so captures show the final frame.
      await page.waitForTimeout(300)
      return await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
    }

    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir)

      // ConPTY on Windows fails to resolve the bare `node` command; pin the
      // executable to an absolute path (same fix as fake-agent.spec.ts).
      await page.evaluate(
        async ({ runtime, nodePath }) => {
          const overridden = await window.teskra.agent.setExecutableOverride({
            agentId: 'fake',
            runtime,
            path: nodePath,
          })
          if (!overridden.ok) {
            throw new Error(`setExecutableOverride failed: ${overridden.error.message}`)
          }
        },
        { runtime: workspace.runtime, nodePath: process.execPath },
      )

      // Seed a task so the Tasks page shows list + detail content.
      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      await page.getByRole('button', { name: 'Create Task' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create Task' })
      await dialog.getByPlaceholder('Task title').fill('Ship the UI polish')
      await dialog
        .getByPlaceholder('Description and desired outcome')
        .fill('Consistent spacing, calmer surfaces, no clipped text.')
      await dialog.getByRole('button', { name: 'OK' }).click()
      const taskItem = page.locator('.task-list-item', { hasText: 'Ship the UI polish' })
      await expect(taskItem).toBeVisible()
      await taskItem.click()
      await expect(page.locator('.task-detail-card').first()).toBeVisible()
      // Selecting a row scrolls it into view; reset so the capture starts at
      // the page heading like a fresh navigation would.
      await page.evaluate(() => document.querySelector('.route-layer')?.scrollTo(0, 0))
      await shot('dark-tasks')

      // Run the Fake Agent to completion so Runs has a row and the drawer has
      // real content.
      await page.getByRole('menuitem', { name: 'Runs' }).click()
      await page.locator('.page-heading .agent-picker').click()
      await page.locator('.ant-select-item-option', { hasText: /^Fake Agent$/u }).click()
      await page.getByPlaceholder('Describe what the Agent should do…').fill('Screenshot seed run')
      await page.getByRole('button', { name: 'Start run' }).click()
      const drawer = page.locator('.ant-drawer')
      await expect(drawer.locator('.ant-tag', { hasText: 'completed' })).toBeVisible({
        timeout: 30_000,
      })
      await shot('dark-run-drawer')
      await page.keyboard.press('Escape')
      await expect(page.locator('.ant-drawer-open')).toHaveCount(0)
      await shot('dark-runs')

      // Dirty the tree so the Git page shows a real diff.
      writeFileSync(join(repoDir, 'hello.txt'), 'hello\nworld\n')
      writeFileSync(join(repoDir, 'notes.md'), '# notes\n')
      await page.getByRole('menuitem', { name: 'Git' }).click()
      await expect(page.locator('.change-file-row').first()).toBeVisible()
      await page.locator('.change-file-row').first().click()
      await shot('dark-git')

      await page.getByRole('menuitem', { name: 'Home' }).click()
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
      await shot('dark-home')

      await page.getByRole('menuitem', { name: 'Workspace' }).click()
      await shot('dark-workspace')

      await page.getByRole('menuitem', { name: 'Doctor' }).click()
      await shot('dark-doctor')

      await page.getByRole('menuitem', { name: 'Recovery' }).click()
      await shot('dark-recovery')

      await page.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
      await shot('dark-settings')

      await page.getByRole('menuitem', { name: 'Permissions' }).click()
      await expect(page.getByText('Audit log').first()).toBeVisible()
      await page.getByText('Audit log').first().scrollIntoViewIfNeeded()
      await shot('dark-settings-permissions')

      await page.getByRole('menuitem', { name: 'Terminal' }).click()
      await page.getByRole('button', { name: 'New terminal' }).click()
      await expect(page.locator('.terminal-keep-alive-visible .xterm')).toBeVisible()
      await shot('dark-terminal')

      // Light theme pass over the highest-traffic pages.
      await page.evaluate(() => window.localStorage.setItem('teskra.theme', 'light'))
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
      await shot('light-home')

      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      await page.locator('.task-list-item', { hasText: 'Ship the UI polish' }).click()
      await expect(page.locator('.task-detail-card').first()).toBeVisible()
      await shot('light-tasks')

      await page.getByRole('menuitem', { name: 'Runs' }).click()
      await expect(page.locator('.run-list-item').first()).toBeVisible()
      await shot('light-runs')

      await page.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
      await shot('light-settings')
    } finally {
      removeDir(repoDir)
    }
  })
})
