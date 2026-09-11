#!/usr/bin/env node
// TASK-073 — SHA256 checksums for release artifacts.
//
// Generates SHA256SUMS.txt next to the packaged artifacts (default
// apps/desktop/dist) and can re-verify it later. The format matches GNU
// sha256sum ("<hash>  <name>", LF endings, sorted by file name) so
// `sha256sum -c SHA256SUMS.txt` works on Linux/macOS/Git-Bash, while
// --verify is the cross-platform Node equivalent for Windows environments
// without coreutils.
//
// Deterministic by construction: entries are sorted, line endings are LF,
// and only the file name (never a host-specific absolute path) is recorded.
//
// Usage:
//   node scripts/make-checksums.mjs [--dir <distDir>]
//   node scripts/make-checksums.mjs --verify [--dir <distDir>]

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sumsFileName = 'SHA256SUMS.txt'
// Generated for the release but not part of the checksummed artifact set:
// the notes are meant to be edited after packaging.
const excludedNames = new Set([sumsFileName, 'RELEASE_NOTES.md'])

const args = process.argv.slice(2)
const verify = args.includes('--verify')
const dirFlagIndex = args.indexOf('--dir')
const distDir =
  dirFlagIndex !== -1 && args[dirFlagIndex + 1]
    ? resolve(repoRoot, args[dirFlagIndex + 1])
    : join(repoRoot, 'apps/desktop/dist')

function fail(message) {
  console.error(`make-checksums: ${message}`)
  process.exit(1)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function collectArtifacts() {
  return readdirSync(distDir)
    .filter((name) => statSync(join(distDir, name)).isFile())
    .filter((name) => !excludedNames.has(name))
    .sort()
}

if (!existsSync(distDir)) {
  fail(`dist directory not found at ${distDir}; package the app first (see docs/release.md)`)
}

if (!verify) {
  const artifacts = collectArtifacts()
  if (artifacts.length === 0) fail(`no artifact files found under ${distDir}`)

  const lines = artifacts.map((name) => `${sha256(join(distDir, name))}  ${name}`)
  writeFileSync(join(distDir, sumsFileName), lines.join('\n') + '\n', 'utf8')
  console.log(`make-checksums: wrote ${sumsFileName} (${artifacts.length} artifact(s))`)
  for (const line of lines) console.log(`  ${line}`)
} else {
  const sumsPath = join(distDir, sumsFileName)
  if (!existsSync(sumsPath)) fail(`${sumsFileName} not found under ${distDir}`)

  const entries = readFileSync(sumsPath, 'utf8')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
      if (!match) fail(`malformed line in ${sumsFileName}: ${line}`)
      return { hash: match[1], name: match[2] }
    })

  let failures = 0
  for (const { hash, name } of entries) {
    const path = join(distDir, name)
    if (!existsSync(path)) {
      failures += 1
      console.error(`FAIL - ${name} (missing)`)
      continue
    }
    const actual = sha256(path)
    if (actual === hash) {
      console.log(`ok   - ${name}`)
    } else {
      failures += 1
      console.error(`FAIL - ${name} (expected ${hash}, got ${actual})`)
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} checksum verification(s) failed.`)
    process.exit(1)
  }
  console.log(`\nChecksum verification passed (${entries.length} artifact(s)).`)
}
