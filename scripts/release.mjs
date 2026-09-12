#!/usr/bin/env node
// TASK-073 — release orchestration:
//
//   build -> sign (Windows, optional) -> package -> checksum -> release notes
//
// The pipeline is intentionally host-aware: on a Windows machine (or the
// release CI job) it produces signed NSIS + portable artifacts; on the
// Linux/WSL development machines it exercises the same pipeline minus
// Authenticode signing, which is only meaningful on Windows.
//
// Version injection: an exact git tag on HEAD (e.g. v1.2.3) wins, then the
// --version flag, then apps/desktop/package.json version. The resolved
// version is injected from the same value twice: into the main/preload
// bundles at build time via TESKRA_APP_VERSION (electron-vite `define`,
// backing window.teskra.appVersion — P2-16) and into electron-builder via
// -c.extraMetadata.version, so the artifact names, the app's own version,
// and the renderer-visible version always match the release.
//
// Signing is env-driven per the electron-builder convention: when CSC_LINK
// (base64 PFX or a path to one) and CSC_KEY_PASSWORD are present, electron-
// builder Authenticode-signs during packaging; when absent, the pipeline
// warns and produces unsigned artifacts instead of failing. See
// docs/release.md for certificate preparation.
//
// Usage:
//   node scripts/release.mjs [--target win|linux|dir] [--version <semver>] [--skip-build]
//                            [--known-issues <text>]
//   npm run release -- --target dir   # quick local pipeline exercise
//
// --known-issues supplies the RELEASE_NOTES "已知问题" section; each non-empty
// line becomes a bullet. When omitted (or blank) the section is left out
// entirely — a literal "- TODO" placeholder must never ship in a release.

import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = join(repoRoot, 'apps/desktop')
const distDir = join(desktopDir, 'dist')
const desktopRequire = createRequire(join(desktopDir, 'package.json'))

const args = process.argv.slice(2)

function flagValue(name) {
  const index = args.indexOf(name)
  return index !== -1 ? args[index + 1] : undefined
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/**
 * Renders RELEASE_NOTES.md. Pure so the release-notes contract is unit-test
 * covered: the "已知问题" section exists only when knownIssues has content;
 * no placeholder text is ever emitted.
 */
export function buildReleaseNotes({ version, date, changes, changesRange, knownIssues }) {
  const bullets = (knownIssues ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith('-') ? line : `- ${line}`))
  const knownIssuesSection = bullets.length > 0 ? `\n## 已知问题\n\n${bullets.join('\n')}\n` : ''
  return `# Teskra v${version} — ${date}

## 变更（${changesRange}）

${changes}

## 校验

安装包 SHA256 见随附的 SHA256SUMS.txt，验证方法见 docs/release.md。
${knownIssuesSection}`
}

/**
 * Build environment for the `npm run build` step (P2-16): TESKRA_APP_VERSION
 * feeds the electron-vite `define` so the version baked into the main/preload
 * bundles equals the one injected via -c.extraMetadata.version. Pure/exported
 * so the injection contract is unit-test covered.
 */
export function buildVersionEnv(version, baseEnv = process.env) {
  return { ...baseEnv, TESKRA_APP_VERSION: version }
}

function main() {
  function run(command, commandArgs, options = {}) {
    console.log(`release: $ ${command} ${commandArgs.join(' ')}`)
    const result = spawnSync(command, commandArgs, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    })
    if (result.error) fail(`${command} failed to start: ${result.error.message}`)
    if (result.status !== 0) fail(`${command} exited with code ${result.status}`)
  }

  function git(gitArgs) {
    return execFileSync('git', gitArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      // Suppress stderr: expected failures (no tag on HEAD, no tags at all)
      // are handled by the callers' try/catch and shouldn't pollute the log.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  }

  // --- 1. version resolution ---------------------------------------------------
  const tagVersion = (() => {
    try {
      const tag = git(['describe', '--tags', '--exact-match', 'HEAD'])
      return tag.startsWith('v') ? tag.slice(1) : tag
    } catch {
      return null
    }
  })()

  const packageVersion = desktopRequire('./package.json').version
  const cliVersion = flagValue('--version')
  const version = tagVersion ?? cliVersion ?? packageVersion
  const versionSource = tagVersion ? 'git tag' : cliVersion ? '--version flag' : 'package.json'

  if (!/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`resolved version "${version}" is not semver; tag HEAD as v<semver> or pass --version`)
  }
  console.log(`release: version ${version} (from ${versionSource})`)

  // --- 2. signing status --------------------------------------------------------
  const target = flagValue('--target') ?? (process.platform === 'win32' ? 'win' : 'linux')
  if (target === 'win') {
    if (process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD) {
      console.log(
        'release: CSC_LINK/CSC_KEY_PASSWORD present — electron-builder will Authenticode-sign',
      )
    } else {
      console.warn(
        'release: CSC_LINK/CSC_KEY_PASSWORD not set — packaging UNSIGNED artifacts (see docs/release.md)',
      )
    }
  } else {
    console.warn(
      `release: target "${target}" — Windows Authenticode signing skipped (Windows-only step)`,
    )
  }

  // --- 3. build -----------------------------------------------------------------
  if (args.includes('--skip-build')) {
    console.log('release: --skip-build set, reusing apps/desktop/out')
  } else {
    // Bake the release version into the bundles (electron-vite `define`, see
    // apps/desktop/electron.vite.config.ts) so window.teskra.appVersion
    // matches the -c.extraMetadata.version injection below.
    run('npm', ['run', 'build', '--workspace', '@teskra/desktop'], {
      env: buildVersionEnv(version),
    })
  }

  // --- 4. package ---------------------------------------------------------------
  const builderPkgPath = desktopRequire.resolve('electron-builder/package.json')
  const builderCli = join(
    dirname(builderPkgPath),
    desktopRequire(builderPkgPath).bin['electron-builder'],
  )
  const builderArgs = [`-c.extraMetadata.version=${version}`, '--publish', 'never']
  if (target === 'dir') {
    builderArgs.push('--dir')
  } else {
    builderArgs.push(`--${target}`)
  }
  run(process.execPath, [builderCli, ...builderArgs], { cwd: desktopDir })

  // --- 5. checksums ---------------------------------------------------------------
  if (target !== 'dir') {
    run(process.execPath, [join(repoRoot, 'scripts/make-checksums.mjs')])
  } else {
    console.log('release: --dir target produces an unpacked directory only — checksums skipped')
  }

  // --- 6. release notes -----------------------------------------------------------
  const previousTag = (() => {
    try {
      return git(['describe', '--tags', '--abbrev=0', 'HEAD^'])
    } catch {
      return null
    }
  })()
  const logArgs = previousTag
    ? ['log', '--pretty=format:- %s (%h)', `${previousTag}..HEAD`]
    : ['log', '--pretty=format:- %s (%h)', '-n', '50']
  const changes = git(logArgs) || '- (no commits since previous tag)'
  const date = new Date().toISOString().slice(0, 10)

  writeFileSync(
    join(distDir, 'RELEASE_NOTES.md'),
    buildReleaseNotes({
      version,
      date,
      changes,
      changesRange: previousTag ? `${previousTag}..HEAD` : '最近 50 条提交',
      knownIssues: flagValue('--known-issues'),
    }),
    'utf8',
  )
  console.log(`release: wrote ${join('apps/desktop/dist', 'RELEASE_NOTES.md')}`)

  console.log(`\nrelease: done — artifacts under apps/desktop/dist (version ${version})`)
}

// Importing this module (e.g. from the unit test) must not run the pipeline.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
