import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGitRepo, openAndSwitchWorkspace, removeDir, test, expect } from '../fixtures'

/**
 * TASK-140 (teskra-tasks.md; Milestone 26 §12/§13) — the Task page Thread tab
 * end-to-end with the Fake Agent (software rendering, per-test TESKRA_HOME):
 *
 *   send a message → Task created, user_message + agent_reply appear →
 *   second message continues the settled round on the same worktree
 *   (user-message resume) → `/workflow full` shows the Workflow system card
 *   with expandable steps → `@fake review` shows the Review system item →
 *   the Runs page's "View in thread" action lands back on the Thread tab.
 *
 * The full workflow needs a confirmed criteria set and (TASK-118) a trusted
 * workspace with the repo-local `full` override pointing at the Fake Agent —
 * both are set up through the real IPC boundary; everything user-visible is
 * asserted through the UI.
 */
const FULL_WORKFLOW_OVERRIDE = {
  id: 'full',
  description: 'e2e override: fake implementer + fake reviewer + trivial test',
  steps: [
    { id: 'implement', type: 'agent', agent: 'fake', role: 'implementer', runOn: 'first' },
    { id: 'fix', type: 'agent', agent: 'fake', role: 'fixer', runOn: 'subsequent' },
    {
      id: 'test-implement',
      type: 'shell',
      command: 'git --version',
      dependsOn: ['implement'],
      runOn: 'first',
    },
    {
      id: 'test-fix',
      type: 'shell',
      command: 'git --version',
      dependsOn: ['fix'],
      runOn: 'subsequent',
    },
    {
      id: 'review-implement',
      type: 'review-panel',
      agents: ['fake'],
      dependsOn: ['test-implement'],
      runOn: 'first',
    },
    {
      id: 'review-fix',
      type: 'review-panel',
      agents: ['fake'],
      dependsOn: ['test-fix'],
      runOn: 'subsequent',
    },
    {
      id: 'gate-implement',
      type: 'criteria-gate',
      dependsOn: [{ node: 'review-implement', on: 'approve' }],
      runOn: 'first',
    },
    {
      id: 'gate-fix',
      type: 'criteria-gate',
      dependsOn: [{ node: 'review-fix', on: 'approve' }],
      runOn: 'subsequent',
    },
  ],
}

test.describe('Task thread (TASK-140)', () => {
  test('thread timeline: first reply, resume round, workflow card, review item', async ({
    page,
  }) => {
    test.setTimeout(420_000)
    const repoDir = createGitRepo()
    try {
      mkdirSync(join(repoDir, '.teskra', 'workflows'), { recursive: true })
      writeFileSync(
        join(repoDir, '.teskra', 'workflows', 'full.json'),
        JSON.stringify(FULL_WORKFLOW_OVERRIDE, null, 2),
      )

      const workspace = await openAndSwitchWorkspace(page, repoDir)
      await page.evaluate(
        async ({ runtime, nodePath, workspaceId }) => {
          const overridden = await window.teskra.agent.setExecutableOverride({
            agentId: 'fake',
            runtime,
            path: nodePath,
          })
          if (!overridden.ok) throw new Error(overridden.error.message)
          const configured = await window.teskra.settings.updateConfig({
            layer: 'global',
            patch: { agents: { defaultAgent: 'fake' } },
          })
          if (!configured.ok) throw new Error(configured.error.message)
          // The repo-local workflow override only loads for trusted workspaces.
          const trusted = await window.teskra.workspace.updateTrust({
            id: workspaceId,
            trustLevel: 'trusted',
          })
          if (!trusted.ok) throw new Error(trusted.error.message)
        },
        { runtime: workspace.runtime, nodePath: process.execPath, workspaceId: workspace.id },
      )

      // ── First message: the Task is created from its first line. ──
      await page.getByRole('menuitem', { name: 'Tasks' }).click()
      const quickStart = page.locator('.quick-start-input').first()
      await expect(quickStart.locator('.quick-start-defaults-summary')).toContainText('fake')
      await quickStart
        .getByPlaceholder('Describe what you want done…')
        .fill('E2E Thread Task\nFirst round body')
      await quickStart.getByRole('button', { name: 'Send' }).click()
      await expect(page.locator('.task-list-item', { hasText: 'E2E Thread Task' })).toBeVisible()

      // Thread is the default tab; the user message appears, then the first
      // reply (the Fake Agent's handoff summary, source 'handoff').
      await expect(page.locator('.task-detail-tabs .ant-tabs-tab-active')).toContainText('Thread')
      const thread = page.locator('.task-thread-panel')
      await expect(thread.locator('.thread-user-message')).toContainText('E2E Thread Task', {
        timeout: 30_000,
      })
      await expect(thread.locator('.thread-agent-reply')).toContainText(
        'Fake Agent completed the requested work.',
        { timeout: 60_000 },
      )

      const first = await page.evaluate(async (workspaceId) => {
        const tasks = await window.teskra.task.list({ workspaceId })
        if (!tasks.ok) throw new Error(tasks.error.message)
        const task = tasks.data.find((entry) => entry.title === 'E2E Thread Task')
        if (task === undefined) throw new Error('thread task missing')
        const runs = await window.teskra.agent.list({ workspaceId })
        if (!runs.ok) throw new Error(runs.error.message)
        const run = runs.data.find((entry) => entry.taskId === task.id)
        if (run === undefined) throw new Error('first run missing')
        return { taskId: task.id, runId: run.id, worktreeId: run.worktreeId }
      }, workspace.id)
      await expect
        .poll(
          async () => {
            return await page.evaluate(async (runId) => {
              const run = await window.teskra.agent.get({ runId })
              if (!run.ok) throw new Error(run.error.message)
              return run.data?.status
            }, first.runId)
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBe('completed')

      // ── Second message: resumes the settled round on the SAME worktree. ──
      const composer = page.locator('.task-detail-stack .quick-start-input')
      await composer.getByPlaceholder('Describe what you want done…').fill('Second round please')
      await composer.getByRole('button', { name: 'Send' }).click()
      await expect(thread.locator('.thread-user-message')).toHaveCount(2, { timeout: 30_000 })

      // The continuation run reuses the source worktree and carries the
      // message in the userMessage section of its continuation prompt.
      await expect
        .poll(
          async () => {
            return await page.evaluate(
              async ({ workspaceId, taskId, sourceRunId }) => {
                const listed = await window.teskra.agent.list({ workspaceId })
                if (!listed.ok) throw new Error(listed.error.message)
                const run = listed.data.find(
                  (entry) => entry.taskId === taskId && entry.id !== sourceRunId,
                )
                if (run === undefined) return undefined
                return { worktreeId: run.worktreeId, prompt: run.prompt ?? '' }
              },
              { workspaceId: workspace.id, taskId: first.taskId, sourceRunId: first.runId },
            )
          },
          { timeout: 30_000, intervals: [500] },
        )
        .toMatchObject({ worktreeId: first.worktreeId })

      const continuation = await page.evaluate(
        async ({ workspaceId, taskId, sourceRunId }) => {
          const listed = await window.teskra.agent.list({ workspaceId })
          if (!listed.ok) throw new Error(listed.error.message)
          const run = listed.data.find(
            (entry) => entry.taskId === taskId && entry.id !== sourceRunId,
          )
          if (run === undefined) throw new Error('continuation run missing')
          return { prompt: run.prompt ?? '', status: run.status }
        },
        { workspaceId: workspace.id, taskId: first.taskId, sourceRunId: first.runId },
      )
      expect(continuation.prompt).toContain('Second round please')
      await expect
        .poll(
          async () => {
            return await page.evaluate(
              async ({ workspaceId, taskId, sourceRunId }) => {
                const listed = await window.teskra.agent.list({ workspaceId })
                if (!listed.ok) throw new Error(listed.error.message)
                return listed.data.find(
                  (entry) => entry.taskId === taskId && entry.id !== sourceRunId,
                )?.status
              },
              { workspaceId: workspace.id, taskId: first.taskId, sourceRunId: first.runId },
            )
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBe('completed')

      // ── `/workflow full`: the Workflow system card with expandable steps. ──
      // The default full workflow anchors to a confirmed criteria set.
      await page.evaluate(async (taskId) => {
        const created = await window.teskra.criteria.createSet({ taskId })
        if (!created.ok) throw new Error(created.error.message)
        const setId = created.data.set.id
        const added = await window.teskra.criteria.addCriterion({
          setId,
          description: 'unit tests pass',
        })
        if (!added.ok) throw new Error(added.error.message)
        const confirmed = await window.teskra.criteria.confirmSet({ setId })
        if (!confirmed.ok) throw new Error(confirmed.error.message)
      }, first.taskId)

      // A repo-supplied test command would park every shell step on a shell
      // confirmation decision (TASK-118); passing --test makes the command
      // request-supplied, so the run converges unattended.
      await composer
        .getByPlaceholder('Describe what you want done…')
        .fill('/workflow full --test "git --version"')
      await composer.getByRole('button', { name: 'Send' }).click()
      const workflowCard = thread.locator('.thread-system[data-system-kind="workflow"]')
      await expect(workflowCard).toBeVisible({ timeout: 60_000 })
      await workflowCard.locator('.thread-workflow-toggle').click()
      await expect(thread.locator('.thread-workflow-steps')).toContainText('implement', {
        timeout: 30_000,
      })

      // The send settles only when the workflow settles (the Fake Agent never
      // scores criteria, so the gate loop parks at needs_user_review); the
      // composer must become usable again before the review send.
      await expect
        .poll(
          async () => {
            return await page.evaluate(async (taskId) => {
              const runs = await window.teskra.workflow.listRuns({ taskId })
              if (!runs.ok) throw new Error(runs.error.message)
              return runs.data[0]?.status
            }, first.taskId)
          },
          { timeout: 240_000, intervals: [2_000] },
        )
        .toMatch(/^(completed|needs_user_review|failed)$/u)
      // While the blocking workflow send is in flight the composer textarea
      // is disabled; it re-enables once the send resolves.
      await expect(composer.locator('textarea')).toBeEnabled({ timeout: 60_000 })

      // ── `@fake review`: a new Review system item appears in the thread. ──
      // (The workflow's review-panel rounds already produced review items, so
      // assert the count grows by exactly one.)
      const reviewSelector = '.thread-system[data-system-kind="review"]'
      const reviewCountBefore = await thread.locator(reviewSelector).count()
      await composer.getByPlaceholder('Describe what you want done…').fill('@fake review it')
      await composer.getByRole('button', { name: 'Send' }).click()
      await expect(thread.locator(reviewSelector)).toHaveCount(reviewCountBefore + 1, {
        timeout: 60_000,
      })

      // ── The Runs page offers "View in thread" and lands on the Thread tab. ──
      await page.getByRole('menuitem', { name: 'Runs' }).click()
      await page.locator('.run-list-item .run-view-in-thread').first().click()
      await expect(page.locator('.task-detail-tabs .ant-tabs-tab-active')).toContainText('Thread')
      await expect(page.locator('.task-thread-panel .thread-user-message').first()).toBeVisible()
    } finally {
      removeDir(repoDir)
    }
  })
})
