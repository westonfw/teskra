import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createGitRepo,
  ensureProcessGone,
  launchApp,
  openAndSwitchWorkspace,
  removeDir,
  test,
  expect,
} from '../fixtures'

/**
 * TASK-125 (§14): an exec run with a structured stream lands on the Activity
 * tab, which shows the parsed tool call. The Fake Agent ships with
 * `output.structured: 'none'`; TESKRA_FAKE_AGENT_STRUCTURED opts it into the
 * claude-stream-json family for this launch so the structured-stream scenario
 * flows through the real observation pipeline (TASK-123).
 */
test.describe('Run Activity view', () => {
  test('exec run with a structured stream defaults to the Activity tab and shows the tool call', async () => {
    const teskraHome = mkdtempSync(join(tmpdir(), 'teskra-e2e-home-'))
    const repoDir = createGitRepo()
    process.env['TESKRA_FAKE_AGENT_STRUCTURED'] = '1'
    const app = await launchApp(teskraHome)
    try {
      const page = await app.firstWindow()
      page.setDefaultTimeout(15_000)
      await page.waitForLoadState('domcontentloaded')
      const workspace = await openAndSwitchWorkspace(page, repoDir)

      // ConPTY on Windows fails to resolve the bare `node` command; pin the
      // executable to an absolute path (same fix as fake-agent.spec).
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

      // Exec-mode run emitting the claude-stream-json NDJSON scenario. The UI
      // start flow has no scenario hook, so the run goes through the bridge —
      // everything after the launch is asserted through the real UI.
      await page.evaluate(async (workspaceId) => {
        const started = await window.teskra.agent.start({
          workspaceId,
          agentType: 'fake',
          mode: 'exec',
          executionMode: 'attended',
          prompt: 'Emit the structured stream',
          environment: { TESKRA_FAKE_SCENARIO: 'structured-stream' },
        })
        if (!started.ok) throw new Error(`agent.start failed: ${started.error.message}`)
      }, workspace.id)

      await page.getByRole('menuitem', { name: 'Runs' }).click()
      const runItem = page.locator('.run-list-item').first()
      await expect(runItem.locator('.ant-tag', { hasText: 'completed' })).toBeVisible({
        timeout: 30_000,
      })
      await runItem.getByRole('button', { name: 'Details' }).click()

      const drawer = page.locator('.ant-drawer-open')
      // exec + structured stream → the drawer defaults to the Activity tab.
      await expect(drawer.locator('.ant-tabs-tab-active')).toContainText('Activity')
      const activity = drawer.locator('.run-activity-panel')
      await expect(activity.getByText('Tool call', { exact: true })).toBeVisible()
      await expect(activity.getByText('Bash', { exact: true })).toBeVisible()

      // The tool call collapses input / result behind panels.
      await activity.getByText('Input').click()
      await expect(
        activity.getByText(/fake-agent --scenario structured-stream/u).first(),
      ).toBeVisible()
      await activity.getByText('Result').first().click()
      await expect(activity.getByText('ok').last()).toBeVisible()

      // The Terminal tab still shows the raw stream (the first NDJSON lines
      // scroll out of the small viewport, so assert a visible one).
      await drawer.getByRole('tab', { name: 'Terminal' }).click()
      await expect(drawer.locator('.xterm-screen')).toContainText('tool_use', {
        timeout: 20_000,
      })
    } finally {
      delete process.env['TESKRA_FAKE_AGENT_STRUCTURED']
      await app.close().catch(() => undefined)
      await ensureProcessGone(app)
      removeDir(teskraHome)
      removeDir(repoDir)
    }
  })
})
