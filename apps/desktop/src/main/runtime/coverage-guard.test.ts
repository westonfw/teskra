import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK-074: the Runtime unit test suite is delivered alongside each module;
 * this guard is the Phase D roll-up that keeps it complete. Every Runtime
 * source module must be imported by at least one test file, so new modules
 * cannot ship untested without an explicit, visible exemption here.
 */
const mainDir = fileURLToPath(new URL('..', import.meta.url))

const COVERED_MODULES = [
  'process',
  'workspace',
  'agents',
  'recovery',
  'db',
  'config',
  'prompts',
  'workflows',
  'security',
  'decisions',
]

/** Type declarations and pure data definitions carry no runtime behavior. */
const EXEMPT = new Set([
  'db/raw-sql.d.ts',
  'prompts/raw-markdown.d.ts',
  // Pure AgentDefinition data; exercised through the fake agent adapter and
  // registry tests, which import it via the definitions barrel.
  'agents/definitions/fake.ts',
  // Thin electron safeStorage adapter (TASK-088); importable only inside the
  // Electron main process, so it is wired by main/index.ts and exercised via
  // the injected CredentialCipher interface in credential-store tests.
  'security/safe-storage-cipher.ts',
])

function collect(dir: string, predicate: (entry: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collect(full, predicate))
    } else if (predicate(entry)) {
      files.push(full)
    }
  }
  return files
}

const IMPORT_PATTERN = /from\s+['"](\.[^'"]+)['"]/g

/** Absolute paths (without extension) of every module imported by any test. */
function importedModuleStems(): Set<string> {
  const stems = new Set<string>()
  for (const testFile of collect(mainDir, (entry) => entry.endsWith('.test.ts'))) {
    const source = readFileSync(testFile, 'utf8')
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      const resolved = resolve(dirname(testFile), specifier)
      stems.add(resolved)
      // Directory imports resolve to their index barrel; join keeps the host
      // separator consistent with the join()-built lookup keys below.
      stems.add(join(resolved, 'index'))
    }
  }
  return stems
}

const toPosix = (path: string): string => path.split(sep).join('/')

const runtimeModules = COVERED_MODULES.flatMap((module) =>
  collect(join(mainDir, module), (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts')),
)
  .map((file) => toPosix(relative(mainDir, file)))
  .filter((module) => !EXEMPT.has(module))

describe('Runtime unit test coverage roll-up (TASK-074)', () => {
  it('covers every Runtime source module with at least one importing test', () => {
    const stems = importedModuleStems()
    const uncovered = runtimeModules.filter(
      (module) => !stems.has(join(mainDir, module).replace(/\.ts$/, '')),
    )
    expect(uncovered).toEqual([])
  })

  it('covers the paths module (TASK-078)', () => {
    const stems = importedModuleStems()
    expect(stems.has(join(mainDir, 'paths'))).toBe(true)
  })
})
