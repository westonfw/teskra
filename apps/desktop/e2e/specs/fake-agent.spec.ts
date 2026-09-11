import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Start Fake Agent', () => {
  test('runs the Fake Agent to completion and exposes its output', async ({ page }) => {
    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir)
      await page.getByRole('menuitem', { name: 'Runs' }).click()

      // The Fake Agent is available without Codex/Claude installed; it is the
      // deterministic test double from TASK-083 and consumes no real quota.
      await expect(
        page.locator('.agent-card', { hasText: 'Fake Agent' }).getByText('Available'),
      ).toBeVisible()

      await page.locator('.page-heading .agent-picker').click()
      // TASK-089 renders fallback suggestions like "建议改用 Fake Agent" inside
      // unavailable options, so a substring match resolves to multiple options.
      await page.locator('.ant-select-item-option', { hasText: /^Fake Agent$/u }).click()
      await page
        .getByPlaceholder('Describe what the Agent should do…')
        .fill('Deterministic TASK-076 E2E run')
      await page.getByRole('button', { name: 'Start run' }).click()

      const runItem = page.locator('.run-list-item').first()
      await expect(runItem).toBeVisible()
      await expect(runItem.locator('.ant-tag', { hasText: 'completed' })).toBeVisible({
        timeout: 30_000,
      })

      // Starting a run opens its detail drawer automatically.
      const drawer = page.locator('.ant-drawer')
      await expect(drawer.getByText('Fake Agent', { exact: true }).first()).toBeVisible()
      await expect(drawer.locator('.ant-tag', { hasText: 'completed' })).toBeVisible()
      await expect(drawer.getByText('Agent PTY')).toBeVisible()

      // The captured run output crosses the real IPC boundary.
      const output = await page.evaluate(async (workspaceId) => {
        const listed = await window.teskra.agent.list({ workspaceId })
        if (!listed.ok) throw new Error(`agent.list failed: ${listed.error.message}`)
        const run = listed.data.find((candidate) => candidate.agentType === 'fake')
        if (run === undefined) throw new Error('no Fake Agent run recorded')
        const captured = await window.teskra.agent.getOutput({ runId: run.id })
        if (!captured.ok) throw new Error(`agent.getOutput failed: ${captured.error.message}`)
        return captured.data
      }, workspace.id)
      expect(output).toContain('Fake Agent started')
      expect(output).toContain('Fake Agent completed')
    } finally {
      removeDir(repoDir)
    }
  })
})
