import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Active run output replay', () => {
  test('the drawer replays durable output for an active run with a cold buffer', async ({
    page,
  }) => {
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

      // Start a hanging run and wait until its first line is in the durable log.
      await page.evaluate(async (workspaceId) => {
        const started = await window.teskra.agent.start({
          workspaceId,
          agentType: 'fake',
          prompt: 'hang',
          executionMode: 'attended',
          approvalMode: 'manual',
          environment: { TESKRA_FAKE_SCENARIO: 'hang' },
        })
        if (!started.ok) throw new Error(started.error.message)
      }, workspace.id)
      await expect
        .poll(async () => {
          const output = await page.evaluate(async (workspaceId) => {
            const agents = await window.teskra.agent.list({ workspaceId })
            if (!agents.ok || agents.data[0] === undefined) throw new Error('no run')
            const captured = await window.teskra.agent.getOutput({ runId: agents.data[0].id })
            return captured.ok ? captured.data : ''
          }, workspace.id)
          return output.includes('Fake Agent is hanging as requested')
        })
        .toBe(true)

      // Wipe the renderer's live buffer; the process keeps running and the
      // durable log keeps everything it printed.
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.workspace-switcher')).toContainText('E2E Repo')

      // Open the still-active run's drawer: it must show the durable log, not
      // just frames that happen to arrive from now on.
      await page.getByRole('menuitem', { name: 'Runs' }).click()
      await page.getByRole('button', { name: 'Send input / Terminal' }).first().click()
      const drawer = page.locator('.ant-drawer-open')
      await expect(drawer).toBeVisible({ timeout: 15_000 })

      // Printed before the reload — only reachable through the durable log.
      await expect(drawer.locator('.xterm-screen')).toContainText(
        'Fake Agent is hanging as requested',
        { timeout: 15_000 },
      )
      await expect(drawer.locator('.xterm-screen')).toContainText(
        'Fake Agent is hanging as requested',
        { timeout: 15_000 },
      )

      // Cleanup: interrupt the hanging run.
      await drawer.getByRole('button', { name: 'Interrupt run' }).click()
      await expect(
        page.locator('.run-list-item .ant-tag', { hasText: 'cancelled' }).first(),
      ).toBeVisible({ timeout: 20_000 })
    } finally {
      removeDir(repoDir)
    }
  })
})
