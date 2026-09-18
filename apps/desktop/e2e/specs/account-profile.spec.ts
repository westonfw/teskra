import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import type { AgentRun, WorkspaceRuntimeRef } from '@teskra/contracts'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

/**
 * TASK-115 (Milestone 24 §57, §65 scenario B/C with the Fake Agent):
 *
 *   A Ready → A Limited → B Ready → A → B Continue
 *
 * Two Fake Agent account profiles are created and detected Ready; A is made
 * the default through the Accounts UI. A profile-pinned run of the rate-limit
 * scenario fails and flips A to Limited with the §26 Usage-limit alert, then
 * "Continue with another account" starts a new run under B on the SAME task
 * and worktree while the run history keeps both runs.
 *
 * Profile creation goes through the bridge (the wizard's WSL distro picker
 * has nothing to list on the Linux dev host — the same reason workspace setup
 * uses openWorkspaceViaBridge); everything user-visible is asserted in the UI.
 */

interface ProfileIds {
  readonly a: string
  readonly b: string
}

async function createReadyProfiles(page: Page, runtime: WorkspaceRuntimeRef): Promise<ProfileIds> {
  return await page.evaluate(async (profileRuntime) => {
    const create = async (name: string, slug: string): Promise<string> => {
      const created = await window.teskra.account.create({
        agentId: 'fake',
        name,
        authType: 'subscription',
        runtime: profileRuntime,
        slug,
      })
      if (!created.ok) throw new Error(`account.create failed: ${created.error.message}`)
      // The Fake Agent adapter's deterministic probe: configHome → ready.
      const detected = await window.teskra.account.detect({ id: created.data.id })
      if (!detected.ok) throw new Error(`account.detect failed: ${detected.error.message}`)
      if (detected.data.status !== 'ready') {
        throw new Error(`profile ${name} detected as ${detected.data.status}, expected ready`)
      }
      return created.data.id
    }
    return { a: await create('Fake A', 'fake-a'), b: await create('Fake B', 'fake-b') }
  }, runtime)
}

async function readRun(page: Page, runId: string): Promise<AgentRun> {
  return await page.evaluate(async (id) => {
    const result = await window.teskra.agent.get({ runId: id })
    if (!result.ok) throw new Error(`agent.get failed: ${result.error.message}`)
    if (result.data === null) throw new Error(`run ${id} not found`)
    return result.data
  }, runId)
}

/** Settings → Agents → Accounts. An open run drawer masks the top menu — close it first. */
async function openAccountsSettings(page: Page): Promise<void> {
  const drawerClose = page.locator('.ant-drawer-open .ant-drawer-close')
  if (await drawerClose.isVisible()) {
    await drawerClose.click()
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0)
  }
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Accounts' }).click()
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible()
}

function accountCard(page: Page, name: string) {
  return page.locator('.account-card', { hasText: name })
}

test.describe('Account Profile continuation (TASK-115)', () => {
  test('A Ready → A Limited → B Ready → continue A→B keeps task, worktree, and history', async ({
    page,
  }) => {
    const repoDir = createGitRepo()
    try {
      const workspace = await openAndSwitchWorkspace(page, repoDir)

      // Same ConPTY fix as fake-agent.spec: pin the absolute Node binary.
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

      // --- A Ready, B Ready -------------------------------------------------
      const profiles = await createReadyProfiles(page, workspace.runtime)

      await openAccountsSettings(page)
      await expect(
        accountCard(page, 'Fake A').locator('.ant-tag', { hasText: 'Ready' }),
      ).toBeVisible()
      await expect(
        accountCard(page, 'Fake B').locator('.ant-tag', { hasText: 'Ready' }),
      ).toBeVisible()

      // A becomes the per-agent default through the UI (§15).
      await accountCard(page, 'Fake A').getByRole('button', { name: 'Use as Default' }).click()
      await expect(
        accountCard(page, 'Fake A').locator('.ant-tag', { hasText: 'Default' }),
      ).toBeVisible()

      // --- Start the rate-limit run on A (task + worktree bound) ------------
      const started = await page.evaluate(
        async (args) => {
          const task = await window.teskra.task.create({
            workspaceId: args.workspaceId,
            title: 'TASK-115 rate-limit continuation',
          })
          if (!task.ok) throw new Error(`task.create failed: ${task.error.message}`)
          const worktree = await window.teskra.worktree.create({
            workspaceId: args.workspaceId,
            runId: args.runId,
            taskId: task.data.id,
            agentId: 'fake',
          })
          if (!worktree.ok) throw new Error(`worktree.create failed: ${worktree.error.message}`)
          const run = await window.teskra.agent.start({
            workspaceId: args.workspaceId,
            agentType: 'fake',
            runId: args.runId,
            taskId: task.data.id,
            worktreeId: worktree.data.id,
            accountProfileId: args.profileA,
            executionMode: 'orchestrated',
            prompt: 'TASK-115 E2E: exhaust the quota of account A',
            environment: { TESKRA_FAKE_SCENARIO: 'rate-limit' },
          })
          if (!run.ok) throw new Error(`agent.start failed: ${run.error.message}`)
          return { runId: args.runId, taskId: task.data.id, worktreeId: worktree.data.id }
        },
        { workspaceId: workspace.id, profileA: profiles.a, runId: randomUUID() },
      )

      // Run A fails with the rate-limit classification (§17, ADR-0010).
      await expect
        .poll(async () => (await readRun(page, started.runId)).status, { timeout: 30_000 })
        .toBe('failed')
      const failedRun = await readRun(page, started.runId)
      expect(failedRun.failureClassification?.kind).toBe('rate-limited')
      expect(failedRun.accountProfileId).toBe(profiles.a)

      // The §26 alert is visible on the run detail.
      await page.getByRole('menuitem', { name: 'Runs' }).click()
      const failedItem = page.locator('.run-list-item', { hasText: 'failed' })
      await expect(failedItem).toBeVisible({ timeout: 30_000 })
      await failedItem.getByRole('button', { name: 'Details' }).click()
      const drawer = page.locator('.ant-drawer')
      await expect(drawer.getByText('Usage limit reached')).toBeVisible()

      // --- A Limited --------------------------------------------------------
      await openAccountsSettings(page)
      await expect(
        accountCard(page, 'Fake A').locator('.ant-tag', { hasText: 'Limited' }),
      ).toBeVisible()
      await expect(
        accountCard(page, 'Fake B').locator('.ant-tag', { hasText: 'Ready' }),
      ).toBeVisible()

      // --- Continue A → B ----------------------------------------------------
      await page.getByRole('menuitem', { name: 'Runs' }).click()
      await page
        .locator('.run-list-item', { hasText: 'failed' })
        .getByRole('button', { name: 'Details' })
        .click()
      await drawer.getByRole('button', { name: 'Continue with another account' }).click()

      const modal = page.locator('.ant-modal')
      await expect(modal.locator('.continuation-candidate-list')).toBeVisible()
      // A is limited (excluded by §26 usability); B is the same-agent candidate.
      await expect(modal.locator('.continuation-candidate')).toHaveCount(1)
      await modal.locator('.continuation-candidate', { hasText: 'Fake B' }).click()
      await modal.getByRole('button', { name: 'Continue', exact: true }).click()

      // The continuation opens the new run's detail; the Fake Agent's default
      // scenario completes quickly under B.
      const listRuns = async (): Promise<
        {
          id: string
          status: string
          accountProfileId: string | null
          worktreeId: string | null
          taskId: string | null
        }[]
      > => {
        return await page.evaluate(async (workspaceId) => {
          const result = await window.teskra.agent.list({ workspaceId })
          if (!result.ok) throw new Error(`agent.list failed: ${result.error.message}`)
          return result.data.map((run) => ({
            id: run.id,
            status: run.status,
            accountProfileId: run.accountProfileId ?? null,
            worktreeId: run.worktreeId ?? null,
            taskId: run.taskId ?? null,
          }))
        }, workspace.id)
      }
      await expect
        .poll(
          async () => (await listRuns()).find((run) => run.accountProfileId === profiles.b)?.status,
          { timeout: 30_000 },
        )
        .toBe('completed')

      // --- Run history: two runs, same task, same worktree -------------------
      const history = await listRuns()
      expect(history).toHaveLength(2)
      const runB = history.find((run) => run.accountProfileId === profiles.b)
      expect(runB).toBeDefined()
      expect(runB?.taskId).toBe(started.taskId)
      // §21: the continuation reuses the source worktree.
      expect(runB?.worktreeId).toBe(started.worktreeId)

      // The run list keeps both cards: the failed A run and the completed B run.
      // (Still on the Runs page; the continuation opened run B's detail drawer,
      // which does not affect list assertions.)
      await expect(page.locator('.run-list-item')).toHaveCount(2)
      await expect(page.locator('.run-list-item', { hasText: 'failed' })).toBeVisible()
      await expect(page.locator('.run-list-item', { hasText: 'completed' })).toBeVisible({
        timeout: 30_000,
      })

      // --- End states: A still Limited (reset is in the future), B Ready -----
      await openAccountsSettings(page)
      await expect(
        accountCard(page, 'Fake A').locator('.ant-tag', { hasText: 'Limited' }),
      ).toBeVisible()
      await expect(
        accountCard(page, 'Fake B').locator('.ant-tag', { hasText: 'Ready' }),
      ).toBeVisible()
    } finally {
      removeDir(repoDir)
    }
  })
})
