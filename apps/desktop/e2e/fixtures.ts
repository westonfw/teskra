import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

import type { Workspace, WorkspaceRuntimeRef } from '@teskra/contracts'

/** apps/desktop — the directory Electron loads (its package.json main → out/). */
export const APP_DIR = resolve(__dirname, '..')
/**
 * Repository root. The main process resolves the Fake Agent script as
 * `resolve(process.cwd(), 'tools/fake-agent.js')`, so Electron must be
 * launched with this cwd.
 */
export const REPO_ROOT = resolve(APP_DIR, '..', '..')

/**
 * The runtime the E2E host can actually execute on: a real Windows workspace
 * on Windows CI; on the Linux/WSL2 dev host a `wsl` workspace maps onto the
 * native POSIX runtime (WorkspaceRuntime, TASK-010), where the distro name is
 * carried but unused.
 */
export function hostRuntime(): WorkspaceRuntimeRef {
  return process.platform === 'win32' ? { kind: 'windows' } : { kind: 'wsl', distro: 'e2e-native' }
}

/** Environment for the launched app: isolated TESKRA_HOME, no VS Code leakage. */
function launchEnv(teskraHome: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // VS Code Server exports this; Electron would boot as plain Node otherwise.
  delete env['ELECTRON_RUN_AS_NODE']
  // TASK-076: every test gets its own data root; the developer's real
  // ~/.teskra is never touched.
  env['TESKRA_HOME'] = teskraHome
  if (env['DISPLAY'] === undefined && process.platform === 'linux') env['DISPLAY'] = ':0'
  return env
}

/**
 * Chromium switches every E2E launch gets.
 *
 * The suite starts — and repeatedly hard-kills — roughly two dozen Electron
 * instances back to back. With hardware acceleration on, each one creates a
 * D3D11 device through ANGLE and tears it down again, and a tree-kill
 * (hardKillElectron / ensureProcessGone) drops the GPU process while it still
 * holds device resources. On Windows that hammers the display driver: the
 * failure mode observed on a dev host was a DXGKRNL watchdog live dump
 * followed by a 0x7E bugcheck — the whole machine went down mid-suite, not
 * just the test run.
 *
 * Nothing under test needs the GPU (the specs assert DOM state, and
 * page.screenshot() renders fine from the software surface), so E2E renders in
 * software and the display driver stays out of the loop. Only these launches
 * are affected — `npm run dev` and the shipped app keep hardware
 * acceleration. Set TESKRA_E2E_GPU=1 to opt back in when deliberately
 * exercising GPU behaviour.
 */
export function launchSwitches(): string[] {
  const switches: string[] = []
  // Chromium's setuid sandbox is unavailable on some headless Linux CI
  // containers; opt out there explicitly (renderer sandbox stays enabled).
  if (process.env['TESKRA_E2E_NO_SANDBOX'] === '1') switches.push('--no-sandbox')
  if (process.env['TESKRA_E2E_GPU'] !== '1') {
    switches.push('--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer')
  }
  return switches
}

/**
 * The single way E2E starts the app: isolated TESKRA_HOME + the switches
 * above. Specs that relaunch the app mid-test (crash recovery) use it too, so
 * there is exactly one launch configuration in the suite.
 */
export async function launchApp(teskraHome: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_DIR, ...launchSwitches()],
    cwd: REPO_ROOT,
    env: launchEnv(teskraHome),
  })
}

/**
 * Relaunch after hardKillElectron, retried until the killed instance is really
 * gone.
 *
 * The app takes a single-instance lock keyed on its data root (main/index.ts:
 * a second instance would share the single-writer SQLite database), and a
 * relaunch landing before Windows has released the killed instance's lock sees
 * it still held, calls app.quit() and exits 0 — correct product behaviour that
 * Playwright can only report as "the app closed during launch". Waiting on the
 * root PID (hardKillElectron) is not enough: the lock outlives it briefly.
 * Observed once in ~20 full-suite runs, never standalone, so the window is
 * short and load-dependent.
 *
 * A relaunch that is broken rather than racing still fails the test: every
 * attempt inside the deadline has to fail, and the last error is rethrown.
 */
export async function relaunchApp(teskraHome: string): Promise<ElectronApplication> {
  const deadline = Date.now() + 30_000
  for (;;) {
    let app: ElectronApplication | undefined
    try {
      app = await launchApp(teskraHome)
      // The instance that loses the lock quits before it opens a window, so
      // waiting for one is what separates a live app from a lock collision.
      await app.firstWindow({ timeout: 15_000 })
      return app
    } catch (cause) {
      if (app !== undefined) await app.close().catch(() => undefined)
      if (Date.now() >= deadline) {
        throw new Error('relaunch never acquired the single-instance lock within 30s', { cause })
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/** A throwaway git repository used as the workspace path. Caller removes it. */
export function createGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teskra-e2e-repo-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'e2e@teskra.local')
  git('config', 'user.name', 'Teskra E2E')
  writeFileSync(join(dir, 'hello.txt'), 'hello\n')
  git('add', '.')
  git('commit', '-m', 'initial commit')
  return dir
}

export function removeDir(dir: string): void {
  // Windows releases file handles (SQLite, PTY cwd) asynchronously — and some
  // grandchildren outlive even a taskkill'd tree. A cleanup failure must not
  // fail an otherwise-green test: the runner VM is disposable either way.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
  } catch (cause) {
    console.warn(`e2e cleanup: could not remove ${dir} (leaving it behind):`, cause)
  }
}

/**
 * Hard-kill the app the way a crash would. On Windows a root-PID SIGKILL
 * leaves grandchildren (renderer/utility/PTY) alive holding the userData
 * single-instance lock, so the relaunched instance refuses to boot;
 * taskkill /F /T takes the whole tree down at once.
 */
export async function hardKillElectron(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'pipe' })
    } catch {
      // Already gone.
    }
  } else {
    app.process().kill('SIGKILL')
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * app.close() resolves when the app quits, but on Windows the process (or its
 * native children) can linger and keep tempdir handles busy. Wait briefly for
 * the process to actually die, then force-kill it before cleanup.
 */
export async function ensureProcessGone(app: ElectronApplication): Promise<void> {
  let pid: number | undefined
  try {
    pid = app.process().pid
  } catch {
    // The app is already gone (Playwright may have reaped it) — nothing to do.
    return
  }
  if (pid === undefined) return
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // Give the app a short grace period to exit on its own after close().
  const deadline = Date.now() + 5_000
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!alive()) return
  try {
    if (process.platform === 'win32') {
      // SIGKILL on the root PID is not enough on Windows: renderer/utility
      // processes and node-pty grandchildren survive it and keep SQLite and
      // repo cwd handles busy (EBUSY on cleanup). Kill the whole tree.
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'pipe' })
    } else {
      app.process().kill('SIGKILL')
    }
  } catch {
    // Already exited between the check and the kill.
  }
}

/**
 * Opens a workspace through the real IPC boundary (window.teskra bridge) and
 * returns the persisted Workspace. The dialog-driven flow is covered on
 * Windows CI; on the Linux dev host the dialog's WSL branch has no
 * distribution list to pick from, so E2E setup goes through the bridge.
 */
export async function openWorkspaceViaBridge(
  page: Page,
  path: string,
  name: string,
): Promise<Workspace> {
  return await page.evaluate(
    async ({ runtime, path: workspacePath, name: workspaceName }) => {
      const opened = await window.teskra.workspace.open({
        runtime,
        path: workspacePath,
        name: workspaceName,
      })
      if (!opened.ok) throw new Error(`workspace.open failed: ${opened.error.message}`)
      return opened.data
    },
    { runtime: hostRuntime(), path, name },
  )
}

/**
 * Bridge-open + reload + select in the UI ("Switch" in Recent workspaces),
 * ending on the Terminal page with the workspace active. The reload re-runs
 * the AppShell's recent-workspaces load so the just-opened workspace shows up.
 */
export async function openAndSwitchWorkspace(
  page: Page,
  repoDir: string,
  name = 'E2E Repo',
): Promise<Workspace> {
  const workspace = await openWorkspaceViaBridge(page, repoDir, name)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  // Home is the default page (TASK-071); the Recent workspaces list lives on
  // the Workspace page.
  await page.getByRole('menuitem', { name: 'Workspace' }).click()
  const item = page.locator('.ant-list-item', { hasText: name })
  await expect(item).toBeVisible()
  // The most recent workspace is auto-selected, so the action reads either
  // "Open terminal" (already current) or "Switch".
  await item.getByRole('button', { name: /^(Switch|Open terminal)$/u }).click()
  await expect(page.locator('.workspace-switcher')).toContainText(name)
  return workspace
}

interface TeskraE2EFixtures {
  /** Per-test isolated data root (TESKRA_HOME); removed after the test. */
  teskraHome: string
  electronApp: ElectronApplication
  page: Page
}

export const test = base.extend<TeskraE2EFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern
  teskraHome: async ({}, use) => {
    const home = mkdtempSync(join(tmpdir(), 'teskra-e2e-home-'))
    await use(home)
    removeDir(home)
  },
  electronApp: async ({ teskraHome }, use) => {
    const app = await launchApp(teskraHome)
    await use(app)
    await app.close().catch(() => undefined)
    await ensureProcessGone(app)
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect }
