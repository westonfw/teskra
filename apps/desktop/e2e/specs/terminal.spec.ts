import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

test.describe('Create Terminal', () => {
  test('creates a terminal session and round-trips a command through the PTY', async ({ page }) => {
    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir)

      await page.getByRole('button', { name: 'New terminal' }).click()
      await expect(page.locator('.terminal-tabs .ant-tabs-tab')).toHaveCount(1)
      await expect(page.locator('.terminal-keep-alive-visible .xterm')).toBeVisible()

      // The session is real IPC state, not just UI.
      const sessions = await page.evaluate(async (workspaceId) => {
        const listed = await window.teskra.terminal.list({ workspaceId })
        if (!listed.ok) throw new Error(`terminal.list failed: ${listed.error.message}`)
        return listed.data
      }, workspace.id)
      expect(sessions).toHaveLength(1)

      // Type into the xterm surface and observe the shell echo through the
      // terminal.output event stream — a full Renderer → Main → PTY → back loop.
      const marker = `TESKRA_E2E_${Date.now()}`
      const outputPromise = page.evaluate(async (expected) => {
        let buffer = ''
        return await new Promise<string>((resolvePromise, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`no terminal output containing ${expected}`)),
            20_000,
          )
          const unsubscribe = window.teskra.events.subscribe('terminal.output', (event) => {
            buffer += event.data
            if (buffer.includes(expected)) {
              clearTimeout(timer)
              unsubscribe()
              resolvePromise(buffer)
            }
          })
        })
      }, marker)

      await page.locator('.terminal-keep-alive-visible .xterm').click()
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')

      const output = await outputPromise
      expect(output).toContain(marker)
    } finally {
      removeDir(repoDir)
    }
  })
})
