import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Run drawer layout', () => {
  test('drawer content fills the drawer width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir)
      await page.evaluate(
        async ({ runtime, nodePath }) => {
          const overridden = await window.teskra.agent.setExecutableOverride({
            agentId: 'fake',
            runtime,
            path: nodePath,
          })
          if (!overridden.ok) throw new Error(overridden.error.message)
        },
        { runtime: workspace.runtime, nodePath: process.execPath },
      )
      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      await page.getByRole('button', { name: 'Create Task' }).click()
      const createDialog = page.getByRole('dialog', { name: 'Create Task' })
      await createDialog.getByPlaceholder('Task title').fill('Drawer layout')
      await createDialog.getByRole('button', { name: 'OK' }).click()
      await page.locator('.task-list-item', { hasText: 'Drawer layout' }).click()
      const launcher = page.locator('.task-run-launcher')
      await launcher.locator('.agent-picker').click()
      await page.locator('.ant-select-item-option', { hasText: /^Fake Agent$/u }).click()
      await launcher.getByRole('button', { name: 'Start' }).click()
      const runsCard = page.locator('.task-detail-card', { hasText: /Runs ·/u }).last()
      await expect(runsCard.locator('.ant-tag', { hasText: 'completed' })).toBeVisible({
        timeout: 30_000,
      })
      await runsCard.getByRole('button', { name: 'View result' }).click()
      await expect(page.locator('.ant-drawer-open')).toHaveCount(1)

      // Regression: the Output tab's vertical Space shrink-wrapped to ~195px,
      // squeezing every card (and the Agent PTY) into an unreadable strip.
      const body = await page.locator('.ant-drawer-open .ant-drawer-body').boundingBox()
      const card = await page.locator('.ant-drawer-open .run-detail .ant-card').first().boundingBox()
      const pty = await page.locator('.ant-drawer-open .agent-run-terminal').boundingBox()
      expect(body).not.toBeNull()
      expect(card).not.toBeNull()
      expect(pty).not.toBeNull()
      expect(card!.width).toBeGreaterThan(body!.width - 90)
      expect(pty!.width).toBeGreaterThan(body!.width - 90)
    } finally {
      removeDir(repoDir)
    }
  })
})
