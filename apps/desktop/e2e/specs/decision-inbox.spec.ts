import type { PendingDecision } from '@teskra/contracts'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

/**
 * TASK-131 (teskra-tasks.md; design doc §9.3): the Decision Inbox E2E.
 *
 * The Fake Agent's progress-blocker scenario (TASK-126) writes a `blocker`
 * progress event and hangs; the TASK-130 bridge opens an `agent_blocker`
 * PendingDecision. The Inbox must list it (grouped, with options); picking
 * `stop` cancels the run and the item leaves the Inbox.
 */

async function listOpenDecisions(page: Parameters<typeof openAndSwitchWorkspace>[0]) {
  return await page.evaluate(async () => {
    const result = await window.teskra.decision.list({ status: 'open' })
    if (!result.ok) throw new Error(`decision.list failed: ${result.error.message}`)
    return result.data
  })
}

async function readRun(page: Parameters<typeof openAndSwitchWorkspace>[0], runId: string) {
  return await page.evaluate(async (id) => {
    const result = await window.teskra.agent.get({ runId: id })
    if (!result.ok) throw new Error(`agent.get failed: ${result.error.message}`)
    if (result.data === null) throw new Error(`run ${id} not found`)
    return result.data
  }, runId)
}

test.describe('Decision Inbox (TASK-131)', () => {
  test('progress-blocker scenario opens an Inbox entry; Stop cancels the run', async ({ page }) => {
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

      // The scenario writes two progress events, then a blocker, then hangs.
      const runId = await page.evaluate(async (workspaceId) => {
        const started = await window.teskra.agent.start({
          workspaceId,
          agentType: 'fake',
          executionMode: 'attended',
          prompt: 'TASK-131 E2E: report a blocker and wait',
          environment: { TESKRA_FAKE_SCENARIO: 'progress-blocker' },
        })
        if (!started.ok) throw new Error(`agent.start failed: ${started.error.message}`)
        return started.data.id
      }, workspace.id)

      // TASK-130: the blocker progress event opens an agent_blocker decision.
      await expect
        .poll(
          async () =>
            (await listOpenDecisions(page)).filter(
              (entry: PendingDecision) => entry.kind === 'agent_blocker',
            ).length,
          { timeout: 30_000 },
        )
        .toBe(1)

      // The nav badge counts the open decision.
      const inboxMenu = page.getByRole('menuitem', { name: /Inbox/u })
      await expect(inboxMenu.locator('.ant-badge-count')).toHaveText('1')

      // The Inbox lists the blocker under its severity group, with options.
      await inboxMenu.click()
      const item = page.locator('.inbox-item', { hasText: 'The Agent reported a blocker' })
      await expect(item).toBeVisible()
      await expect(item).toContainText('Fake Agent needs a human decision to continue')
      await expect(page.locator('.inbox-group', { hasText: 'Warning' })).toContainText(
        'The Agent reported a blocker',
      )

      // The run is untouched while the decision is open (ADR-0012).
      expect((await readRun(page, runId)).status).not.toBe('cancelled')

      // Stop → Main cancels the run; the resolved item leaves the Inbox.
      await item.getByRole('button', { name: 'Stop the run' }).click()
      await expect
        .poll(async () => (await readRun(page, runId)).status, {
          timeout: 30_000,
        })
        .toBe('cancelled')
      await expect(page.locator('.inbox-empty')).toBeVisible()
      await expect(inboxMenu.locator('.ant-badge-count')).toHaveCount(0)
    } finally {
      removeDir(repoDir)
    }
  })
})
