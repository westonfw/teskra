import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, type ElectronApplication } from '@playwright/test'

import {
  APP_DIR,
  REPO_ROOT,
  createGitRepo,
  ensureProcessGone,
  openWorkspaceViaBridge,
  removeDir,
  test,
  expect,
} from '../fixtures'

/**
 * Crash recovery (TASK-040/070) through the real app lifecycle: start a live
 * run, SIGKILL the process, relaunch on the same TESKRA_HOME, and drive the
 * Recovery Center to resume the interrupted run. The single-instance lock is
 * exercised implicitly — the relaunched instance must boot normally after a
 * hard kill.
 */
function launchEnv(teskraHome: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env['ELECTRON_RUN_AS_NODE']
  env['TESKRA_HOME'] = teskraHome
  if (env['DISPLAY'] === undefined && process.platform === 'linux') env['DISPLAY'] = ':0'
  return env
}

async function waitForExit(pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        process.kill(pid, 0)
      } catch {
        clearInterval(timer)
        resolve()
      }
    }, 200)
  })
}

test.describe('Crash recovery', () => {
  test('relaunches after SIGKILL and resumes the interrupted run from the Recovery Center', async () => {
    test.setTimeout(180_000)
    const teskraHome = mkdtempSync(join(tmpdir(), 'teskra-recovery-home-'))
    const repoDir = createGitRepo()
    let app: ElectronApplication | undefined
    try {
      app = await electron.launch({ args: [APP_DIR], cwd: REPO_ROOT, env: launchEnv(teskraHome) })
      let page = await app.firstWindow()
      const workspace = await openWorkspaceViaBridge(page, repoDir, 'Recovery Repo')
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
      await page.evaluate(async (workspaceId) => {
        const started = await window.teskra.agent.start({
          workspaceId,
          agentType: 'fake',
          prompt: 'crash me',
          executionMode: 'attended',
          approvalMode: 'manual',
          environment: { TESKRA_FAKE_SCENARIO: 'hang' },
        })
        if (!started.ok) throw new Error(started.error.message)
      }, workspace.id)
      await page.waitForTimeout(2_000)

      const pid = app.process().pid
      app.process().kill('SIGKILL')
      await waitForExit(pid)

      app = await electron.launch({ args: [APP_DIR], cwd: REPO_ROOT, env: launchEnv(teskraHome) })
      page = await app.firstWindow()
      await page.getByRole('menuitem', { name: 'Recovery' }).click()
      await expect(page.getByText('Recovery Center')).toBeVisible()
      await expect(page.locator('main').getByText('Interrupted Runs').first()).toBeVisible({
        timeout: 20_000,
      })
      await page.getByRole('button', { name: 'Resume' }).first().click()

      // After the resume the Recovery Center drains; the run is live again.
      await expect(page.getByText('Everything is healthy')).toBeVisible({ timeout: 30_000 })
      // After the resume the Recovery Center drains; the run is live again
      // (resume is async — poll until AgentManager finishes relaunching).
      // After the resume the Recovery Center drains and the run leaves the
      // interrupted state. (Resume intentionally does not persist one-shot
      // environment overrides, so the Fake Agent relaunches with its default
      // scenario and completes instead of hanging — assert the state moved,
      // not a specific terminal value.)
      await expect
        .poll(
          async () => {
            const statuses = await page.evaluate(async (workspaceId) => {
              const agents = await window.teskra.agent.list({ workspaceId })
              if (!agents.ok) throw new Error(agents.error.message)
              return agents.data.map((run) => run.status)
            }, workspace.id)
            return statuses.length > 0 && !statuses.includes('interrupted')
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe(true)

      // Clean up the still-hanging resumed run before closing.
      await page.evaluate(async (workspaceId) => {
        const agents = await window.teskra.agent.list({ workspaceId })
        if (!agents.ok) return
        for (const run of agents.data) {
          if (['running', 'preparing', 'queued'].includes(run.status)) {
            await window.teskra.agent.cancel({ runId: run.id })
          }
        }
      }, workspace.id)
      await app.close()
      await ensureProcessGone(app)
      app = undefined
    } finally {
      if (app !== undefined) app.process().kill('SIGKILL')
      removeDir(teskraHome)
      removeDir(repoDir)
    }
  })
})
