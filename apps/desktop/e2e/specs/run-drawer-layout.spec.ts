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
      // TASK-135: the launcher and the Runs list live on the Runs tab now.
      await page.getByRole('tab', { name: 'Runs', exact: true }).click()
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
      const card = await page
        .locator('.ant-drawer-open .run-detail .ant-card')
        .first()
        .boundingBox()
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

  test('the Agent PTY grows to fill the drawer height at fullscreen', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 })
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
      await createDialog.getByPlaceholder('Task title').fill('Fullscreen PTY')
      await createDialog.getByRole('button', { name: 'OK' }).click()
      await page.locator('.task-list-item', { hasText: 'Fullscreen PTY' }).click()
      // TASK-135: the launcher and the Runs list live on the Runs tab now.
      await page.getByRole('tab', { name: 'Runs', exact: true }).click()
      const launcher = page.locator('.task-run-launcher')
      await launcher.locator('.agent-picker').click()
      await page.locator('.ant-select-item-option', { hasText: /^Fake Agent$/u }).click()
      await launcher.getByRole('button', { name: 'Start' }).click()
      const runsCard = page.locator('.task-detail-card', { hasText: /Runs ·/u }).last()
      await expect(runsCard.locator('.ant-tag', { hasText: 'completed' })).toBeVisible({
        timeout: 30_000,
      })
      await runsCard.getByRole('button', { name: 'View result' }).click()
      const drawer = page.locator('.ant-drawer-open')
      await expect(drawer).toBeVisible()
      await expect(drawer.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })

      // Regression: the terminal was capped at 380px, so on a tall window the
      // drawer's free space went unused and the latest output scrolled out of
      // the small viewport.
      const body = await drawer.locator('.ant-drawer-body').boundingBox()
      const pty = await drawer.locator('.agent-run-terminal').boundingBox()
      expect(body).not.toBeNull()
      expect(pty).not.toBeNull()
      expect(pty!.height).toBeGreaterThan(600)
      expect(pty!.height).toBeGreaterThan(body!.height * 0.55)

      // The latest output line stays visible in the viewport.
      await expect(
        drawer.locator('.xterm-screen').getByText('Fake Agent completed').last(),
      ).toBeVisible()
    } finally {
      removeDir(repoDir)
    }
  })
})
