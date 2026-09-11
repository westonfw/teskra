// TASK-072 packaged-artifact smoke: after `npm run pack --workspace
// @teskra/desktop` (electron-builder --dir), assert the app bundle exists and
// both native modules were asar-unpacked with their .node binaries — the
// TASK-013 packaging contract that lets node-pty/better-sqlite3 load in the
// packaged app.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/desktop/dist')

function fail(message) {
  console.error(`smoke-packaged-artifact: ${message}`)
  process.exit(1)
}

function containsNodeBinary(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (containsNodeBinary(full)) return true
    } else if (entry.endsWith('.node')) {
      return true
    }
  }
  return false
}

if (!existsSync(distDir)) {
  fail(
    `dist directory not found at ${distDir}; run \`npm run pack --workspace @teskra/desktop\` first`,
  )
}

const unpacked = readdirSync(distDir).find((entry) => entry.endsWith('-unpacked'))
if (!unpacked) fail(`no *-unpacked directory under ${distDir}`)

const resourcesDir = join(distDir, unpacked, 'resources')
if (!existsSync(join(resourcesDir, 'app.asar'))) fail(`app.asar missing under ${resourcesDir}`)

for (const mod of ['node-pty', 'better-sqlite3']) {
  const modDir = join(resourcesDir, 'app.asar.unpacked', 'node_modules', mod)
  if (!existsSync(modDir)) fail(`${mod} was not asar-unpacked (expected ${modDir})`)
  if (!containsNodeBinary(modDir)) fail(`${mod} unpacked but contains no .node binary`)
}

console.log(`packaged artifact smoke OK (${unpacked})`)
