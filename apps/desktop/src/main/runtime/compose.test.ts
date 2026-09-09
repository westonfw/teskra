import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FUTURE_RUNTIME_PORTS } from '@teskra/contracts'

import { createTeskraPaths } from '../paths'
import type { CommandRunner } from '../process/command-runner'
import { composeTeskraRuntime } from './compose'
import { requireRuntimePort } from './facade'

const tempHomes: string[] = []

afterEach(() => {
  for (const path of tempHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function makeHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'teskra-compose-'))
  tempHomes.push(path)
  return path
}

function wslCommands(): CommandRunner {
  return {
    async run(request) {
      if (request.args?.includes('--status')) {
        return {
          ok: true,
          data: { stdout: 'Default Distribution: Ubuntu-24.04\r\n', stderr: '', exitCode: 0 },
        }
      }
      if (request.args?.includes('--version')) {
        return {
          ok: true,
          data: { stdout: 'WSL version: 2.6.3.0\r\n', stderr: '', exitCode: 0 },
        }
      }
      return {
        ok: true,
        data: { stdout: 'Ubuntu-24.04\r\nDebian\r\n', stderr: '', exitCode: 0 },
      }
    },
  }
}

describe('TeskraRuntime composition root (TASK-081)', () => {
  it('instantiates under plain Node with working workspace, terminal, and system ports', async () => {
    const home = makeHome()
    const paths = createTeskraPaths({ TESKRA_HOME: home })
    const composed = await composeTeskraRuntime({
      paths,
      commands: wslCommands(),
      hostPlatform: 'linux',
      appVersion: '9.8.7',
      runtimeVersion: '22.test',
      initializeLogs: false,
    })
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    const runtime = composed.data

    const workspacePath = join(home, 'repo')
    mkdirSync(workspacePath)
    const created = runtime.workspace.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: workspacePath,
    })
    expect(created.ok).toBe(true)
    expect(runtime.workspace.listRecent().ok).toBe(true)
    expect(runtime.terminal.list()).toEqual({ ok: true, data: [] })
    expect(runtime.system.info()).toEqual({
      ok: true,
      data: { appVersion: '9.8.7', runtimeVersion: '22.test' },
    })
    const systemPaths = runtime.system.paths()
    expect(systemPaths.ok).toBe(true)
    if (systemPaths.ok) {
      expect(systemPaths.data.dataDirectory).toBe(home)
      expect(systemPaths.data.databaseFile).toBe(join(home, 'db', 'teskra.sqlite'))
      expect(existsSync(systemPaths.data.logDirectory)).toBe(true)
    }
    const health = await runtime.system.health()
    expect(health).toEqual({
      ok: true,
      data: { databaseAvailable: true, wslAvailable: true, issues: [] },
    })

    expect(runtime.dispose()).toEqual({ ok: true, data: undefined })
    expect(runtime.dispose()).toEqual({ ok: true, data: undefined })
  })

  it('mounts WSL list/read/write operations on the system port', async () => {
    const home = makeHome()
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
    })
    if (!composed.ok) throw new Error('expected runtime')

    const listed = await composed.data.system.listWslDistributions()
    expect(listed.ok && listed.data.map((item) => item.name)).toEqual(['Ubuntu-24.04', 'Debian'])
    expect(await composed.data.system.getDefaultWslDistribution()).toEqual({
      ok: true,
      data: 'Ubuntu-24.04',
    })
    expect(await composed.data.system.setDefaultWslDistribution('debian')).toEqual({
      ok: true,
      data: 'Debian',
    })
    expect(await composed.data.system.getDefaultWslDistribution()).toEqual({
      ok: true,
      data: 'Debian',
    })
    composed.data.dispose()
  })

  it('reports every not-yet-mounted port as CAPABILITY_NOT_AVAILABLE', async () => {
    const composed = await composeTeskraRuntime({
      paths: createTeskraPaths({ TESKRA_HOME: makeHome() }),
      commands: wslCommands(),
      hostPlatform: 'linux',
      initializeLogs: false,
    })
    if (!composed.ok) throw new Error('expected runtime')

    for (const name of FUTURE_RUNTIME_PORTS) {
      const result = requireRuntimePort(composed.data, name)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    }
    composed.data.dispose()
  })
})
