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

test.describe('Task Runs card resume', () => {
  test('an interrupted run can be resumed from the task page, same as the Runs page', async () => {
    test.setTimeout(180_000)
    const teskraHome = mkdtempSync(join(tmpdir(), 'teskra-task-resume-'))
    const repoDir = createGitRepo()
    let app: ElectronApplication | undefined
    try {
      app = await electron.launch({ args: [APP_DIR], cwd: REPO_ROOT, env: launchEnv(teskraHome) })
      let page = await app.firstWindow()
      const workspace = await openWorkspaceViaBridge(page, repoDir, 'Task Resume Repo')
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
        const task = await window.teskra.task.create({ workspaceId, title: 'Task-resume E2E' })
        if (!task.ok) throw new Error(task.error.message)
        const started = await window.teskra.agent.start({
          workspaceId,
          taskId: task.data.id,
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

      // The task's Runs card exposes Resume for the interrupted run.
      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      await page.locator('.task-list-item', { hasText: 'Task-resume E2E' }).click()
      const runsCard = page.locator('.task-detail-card', { hasText: /Runs ·/u }).last()
      await expect(runsCard.locator('.ant-tag', { hasText: 'interrupted' })).toBeVisible({
        timeout: 20_000,
      })
      await runsCard.getByRole('button', { name: 'Resume' }).click()

      // Resume opens the drawer and the run leaves the interrupted state.
      await expect(page.locator('.ant-drawer-open')).toBeVisible({ timeout: 20_000 })
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
