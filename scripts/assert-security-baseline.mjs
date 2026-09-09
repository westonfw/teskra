#!/usr/bin/env node
// TASK-002 — Electron security baseline, build-artifact assertions.
//
// Complements apps/desktop/src/security/baseline.test.ts (source-level).
// Verifies the actual electron-vite output under apps/desktop/out/:
//
//   1. preload bundle is self-contained: it require()s `electron` and nothing
//      else, so it loads under sandbox: true (which forbids arbitrary npm
//      package requires in preload scripts).
//   2. renderer bundle carries no CommonJS require and no Node builtin
//      imports — the renderer never gets Node capabilities.
//   3. the production index.html carries the CSP meta tag (injected at build
//      time by electron.vite.config.ts; dev mode is exempt because vite HMR
//      and the react-refresh preamble need inline scripts and ws:).
//
// Usage: node scripts/assert-security-baseline.mjs   (run `npm run build` first,
// or use `npm run test:security` which builds first.)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'apps/desktop/out')
const builtinSet = new Set(builtinModules)

let failures = 0

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${label}`)
  } else {
    failures += 1
    console.error(`FAIL - ${label}${detail ? ` (${detail})` : ''}`)
  }
}

function collectFiles(dir, extensions) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, extensions))
    } else if (extensions.includes(extname(entry))) {
      files.push(full)
    }
  }
  return files
}

if (!existsSync(outDir)) {
  console.error(
    'apps/desktop/out is missing — run `npm run build` first (or use npm run test:security).',
  )
  process.exit(1)
}

// --- 1. preload bundle -------------------------------------------------------
const preloadFiles = collectFiles(join(outDir, 'preload'), ['.js', '.cjs', '.mjs'])
check('preload bundle exists', preloadFiles.length > 0)

for (const file of preloadFiles) {
  const code = readFileSync(file, 'utf8')
  const required = new Set(
    [...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  )
  const imported = new Set([...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))
  const externals = [...required, ...imported].filter(
    (s) => !s.startsWith('.') && !s.startsWith('/'),
  )
  check(
    `${file}: only requires electron (found: ${externals.join(', ') || 'none'})`,
    externals.length > 0 && externals.every((s) => s === 'electron'),
  )
  check(`${file}: bridge exposed via contextBridge`, code.includes('exposeInMainWorld'))
}

// --- 2. renderer bundle ------------------------------------------------------
const rendererDir = join(outDir, 'renderer')
const rendererFiles = collectFiles(rendererDir, ['.js', '.mjs'])
check('renderer bundle exists', rendererFiles.length > 0)

for (const file of rendererFiles) {
  const code = readFileSync(file, 'utf8')
  check(`${file}: no CommonJS require()`, !/\brequire\s*\(/.test(code))
  const nodeImports = [...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((s) => builtinSet.has(s.startsWith('node:') ? s.slice(5) : s) || s === 'electron')
  check(
    `${file}: no Node builtin / electron imports`,
    nodeImports.length === 0,
    nodeImports.join(', '),
  )
}

// --- 3. CSP in production html ----------------------------------------------
const indexHtml = readFileSync(join(rendererDir, 'index.html'), 'utf8')
// Note: vite HTML-escapes attribute values, so 'self' appears as &#39;self&#39;.
check(
  'production index.html has a Content-Security-Policy meta',
  /http-equiv="Content-Security-Policy"/.test(indexHtml) &&
    /default-src (?:'|&#39;)self(?:'|&#39;)/.test(indexHtml),
)

if (failures > 0) {
  console.error(`\n${failures} security baseline assertion(s) failed.`)
  process.exit(1)
}
console.log('\nSecurity baseline assertions passed.')
