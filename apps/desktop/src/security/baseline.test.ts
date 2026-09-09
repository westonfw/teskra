import { readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// TASK-002 — Electron security baseline, source-level assertions.
// Build-artifact assertions live in scripts/assert-security-baseline.mjs
// (npm run test:security), because they need `npm run build` output.

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const builtinSet = new Set(builtinModules)

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

/** Import specifiers that would end up in the emitted bundle (type imports are erased). */
function runtimeImports(source: string): string[] {
  const specs: string[] = []
  const fromRe = /^\s*import\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/gm
  const sideEffectRe = /^\s*import\s*['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(fromRe)) {
    if (match[1] === undefined) {
      specs.push(match[2] as string)
    }
  }
  for (const match of source.matchAll(sideEffectRe)) {
    specs.push(match[1] as string)
  }
  return specs
}

describe('BrowserWindow webPreferences', () => {
  const mainSource = readFileSync(join(srcDir, 'main/index.ts'), 'utf8')

  it('enforces contextIsolation / nodeIntegration / sandbox', () => {
    expect(mainSource).toContain('contextIsolation: true')
    expect(mainSource).toContain('nodeIntegration: false')
    expect(mainSource).toContain('sandbox: true')
  })
})

describe('preload bridge', () => {
  const preloadSource = readFileSync(join(srcDir, 'preload/index.ts'), 'utf8')

  it('exposes the bridge as window.teskra via contextBridge', () => {
    expect(preloadSource).toContain('contextBridge.exposeInMainWorld')
    expect(preloadSource).toMatch(/exposeInMainWorld\(\s*['"]teskra['"]/)
  })

  it('requires only electron at runtime (sandbox: true forbids npm packages)', () => {
    expect(runtimeImports(preloadSource)).toEqual(['electron'])
    expect(preloadSource).not.toContain('require(')
  })
})

describe('renderer isolation', () => {
  const rendererFiles = collectSourceFiles(join(srcDir, 'renderer'))

  it('has renderer sources to check', () => {
    expect(rendererFiles.length).toBeGreaterThan(0)
  })

  it('imports no Node builtins and no electron internals', () => {
    for (const file of rendererFiles) {
      const specs = runtimeImports(readFileSync(file, 'utf8'))
      for (const spec of specs) {
        const bare = spec.startsWith('node:') ? spec.slice(5) : spec
        expect(builtinSet.has(bare), `${file} imports Node builtin "${spec}"`).toBe(false)
        expect(spec, `${file} imports electron`).not.toBe('electron')
        expect(spec.startsWith('electron/'), `${file} imports electron internals`).toBe(false)
      }
    }
  })

  it('uses no CommonJS require', () => {
    for (const file of rendererFiles) {
      expect(readFileSync(file, 'utf8'), `${file} uses require()`).not.toMatch(/\brequire\s*\(/)
    }
  })
})
