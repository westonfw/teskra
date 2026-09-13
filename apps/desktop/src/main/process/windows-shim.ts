/**
 * Windows npm `.cmd` / `.bat` shim support.
 *
 * npm global installs place three shims on PATH (`codex`, `codex.cmd`,
 * `codex.ps1`); only the `.cmd`/`.bat` form is CreateProcess-able, and Node
 * refuses to spawn it without a shell (EINVAL since the CVE-2024-27980 fix).
 * (`shell: true` is NOT an option: it mangles quoting/backslashes and is
 * DEP0190-deprecated.)
 *
 * Two launch strategies live here:
 *
 * 1. cmd.exe passthrough (the default). The launch shape below was verified
 *    empirically on a real Windows host against a npm-style shim forwarding
 *    `%*` to node:
 *
 *      spawn(comspec, ['/d','/s','/c','call', `"${exe}"`, ...quotedArgs],
 *            { windowsVerbatimArguments: true })
 *
 *    The `call` prefix is load-bearing. Bare `cmd /s /c "<exe>" args` only
 *    survives while the exe path contains no space AND no argument is quoted:
 *    cmd's `/c` quote-stripping then mis-splits the line (e.g. a path with a
 *    space runs as `C:\...\fake`). With `call`, cmd parses the line under
 *    batch-invocation semantics, quoted arguments reach the shim's `%*`
 *    verbatim, and the final node process re-parses them correctly via
 *    CommandLineToArgvW — multi-word prompts, `&`, and embedded `""` quotes
 *    all round-trip exactly.
 *
 *    node-pty needs the same command line as ONE pre-quoted string so its
 *    argsToCommandLine `isCommandLine` branch passes it through unescaped.
 *
 * 2. Direct launch (shim unwrapping) for arguments cmd CANNOT transport.
 *    Empirically verified on a real Windows host (2026-09-13, against the
 *    installed `codex.cmd`): cmd's batch parser ends the command at the
 *    first line break even inside quotes, so the shim's `%*` forwards only
 *    the first line — a multi-line agent prompt arrives truncated to
 *    `# Implement the Task`. The same wall exists for command lines past
 *    cmd's ~8191-character limit. A Win32 command line itself carries
 *    newlines inside quoted arguments fine (CommandLineToArgvW preserves
 *    them), so when args cross either boundary we unwrap the shim instead:
 *    parse the batch file for the real target it forwards to (a `.js` entry
 *    run with node, or a plain `.exe`), and spawn THAT directly with the
 *    normal argv array. Unparseable shims fall back to strategy 1 — no
 *    worse than before.
 *
 * This module is pure: the host platform check, the ComSpec lookup and all
 * filesystem access stay in the process infrastructure (command-runner /
 * process-manager), which are the ESLint-exempt platform-branch locations.
 * Shim file contents reach the parser through the injected CmdShimIO seam.
 */

import path from 'node:path'

const CMD_SHIM_PATTERN = /\.(cmd|bat)$/i

/** True when the executable is a Windows cmd/batch shim that needs cmd.exe. */
export function isWindowsCmdShim(executable: string): boolean {
  return CMD_SHIM_PATTERN.test(executable)
}

/**
 * Quotes one argument for a `cmd.exe /c` command line: values containing
 * whitespace or cmd metacharacters are wrapped in double quotes, embedded
 * quotes are doubled (the form cmd batch invocation preserves). A quoted `%`
 * is not expanded by cmd (verified empirically); an unquoted one could be,
 * which is why `%` forces quoting here.
 */
export function quoteCmdArg(arg: string): string {
  if (!/[\s"&|<>^()%]/.test(arg)) {
    return arg
  }
  return `"${arg.replace(/"/g, '""')}"`
}

export interface CmdShimSpawn {
  readonly command: string
  readonly args: readonly string[]
  /** Callers must pass this through as `windowsVerbatimArguments`. */
  readonly verbatim: true
}

/** CommandRunner form: spawn(cmd.exe, args, { windowsVerbatimArguments: true }). */
export function buildCmdShimSpawn(
  executable: string,
  args: readonly string[],
  comspec = 'cmd.exe',
): CmdShimSpawn {
  return {
    command: comspec,
    args: ['/d', '/s', '/c', 'call', `"${executable}"`, ...args.map(quoteCmdArg)],
    verbatim: true,
  }
}

/**
 * node-pty form: the whole command line as ONE pre-quoted string, so
 * windowsPtyAgent's argsToCommandLine `isCommandLine` branch concatenates it
 * verbatim instead of re-escaping.
 */
export function buildCmdShimCommandLine(executable: string, args: readonly string[]): string {
  return ['/d', '/s', '/c', 'call', `"${executable}"`, ...args.map(quoteCmdArg)].join(' ')
}

/**
 * A shim launch with cmd.exe removed from the middle: the real executable
 * (`node` for a `.js` entry, or the unwrapped `.exe` itself) plus the argv
 * prefix that reproduces the shim's forwarding (`[entry.js]` or empty).
 */
export interface CmdShimDirectLaunch {
  readonly command: string
  readonly argsPrefix: readonly string[]
}

/** Filesystem seam for shim unwrapping; production binds node:fs. */
export interface CmdShimIO {
  /** File contents, or undefined when unreadable (missing, EACCES, …). */
  read(path: string): string | undefined
  exists(path: string): boolean
}

/**
 * cmd.exe cannot transport these arguments: a line break ends the batch
 * command even inside quotes (truncating the shim's `%*` forwarding), and
 * cmd's command-line ceiling (~8191 chars, 8000 with margin) silently cuts
 * long prompts. Both cases must bypass cmd via shim unwrapping.
 */
export function cmdShimArgsNeedDirectLaunch(executable: string, args: readonly string[]): boolean {
  if (args.some((arg) => arg.includes('\n') || arg.includes('\r'))) {
    return true
  }
  return buildCmdShimCommandLine(executable, args).length > 8_000
}

/** Environment-variable placeholders npm/pnpm shims use for their own dir. */
const DP0_PATTERN = /%dp0%|%~dp0/gi

const WIN32_ABSOLUTE_PATTERN = /^(?:[a-z]:[\\/]|[\\/]{2})/i

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Resolves a BARE command name (no path separators) against PATH + PATHEXT,
 * mirroring the cmd/libuv lookup. CommandRunner needs the real file path:
 * npm-style CLIs live on PATH only as `.cmd`/`.bat` shims, and Node refuses
 * to spawn those directly (EINVAL since the CVE-2024-27980 fix) — with the
 * shim path in hand the regular shim launch logic takes over. Returns
 * undefined for qualified paths (spawned as-is) and for names found nowhere
 * (spawn then fails with the original ENOENT, behavior unchanged).
 */
export function resolveWindowsCommandPath(
  command: string,
  io: CmdShimIO,
  envPath?: string,
  envPathext?: string,
): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    return undefined
  }
  const extensions = (envPathext ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0)
  const hasExecutableExtension = extensions.some((ext) =>
    command.toLowerCase().endsWith(ext.toLowerCase()),
  )
  // Lowercase the appended extension: the Win32 filesystem is
  // case-insensitive, and real-world shim files are lowercase (`npm.cmd`).
  const names = hasExecutableExtension
    ? [command]
    : extensions.map((ext) => command + ext.toLowerCase())
  for (const dir of (envPath ?? '').split(';')) {
    const trimmed = dir.trim().replace(/^"+|"+$/g, '')
    if (trimmed === '') {
      continue
    }
    for (const name of names) {
      const candidate = path.win32.join(trimmed, name)
      if (io.exists(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

interface CmdShimCandidate {
  /** Normalized absolute path the shim forwards to. */
  readonly target: string
  readonly kind: 'js' | 'exe'
}

/**
 * Extracts the forwarding targets from a shim's batch source. Only lines
 * containing `%*` forward arguments; within those, quoted tokens ending in
 * `.js` (npm/pnpm/yarn shims → run with node) or `.exe` (scoop-style shims
 * → run directly) are candidates. Tokens that still hold an unresolved
 * `%VAR%` after the dp0 substitution (`%_prog%`, `%COMSPEC%`) are skipped.
 * Paths are normalized with win32 semantics so unit tests are host-neutral.
 */
function parseCmdShimCandidates(shimContent: string, shimDir: string): CmdShimCandidate[] {
  const candidates: CmdShimCandidate[] = []
  for (const line of shimContent.split(/\r?\n/u)) {
    if (!line.includes('%*')) {
      continue
    }
    for (const match of line.matchAll(/"([^"]+)"/g)) {
      const raw = match[1]
      if (raw === undefined) {
        continue
      }
      const substituted = raw.replace(DP0_PATTERN, shimDir)
      if (substituted.includes('%')) {
        continue
      }
      const resolved = WIN32_ABSOLUTE_PATTERN.test(substituted)
        ? substituted
        : path.win32.resolve(shimDir, substituted)
      const target = path.win32.normalize(resolved)
      if (/\.js$/i.test(target)) {
        candidates.push({ target, kind: 'js' })
      } else if (/\.exe$/i.test(target)) {
        candidates.push({ target, kind: 'exe' })
      }
    }
  }
  return candidates
}

/**
 * Resolves the node runtime for a `.js` shim target to an ABSOLUTE path:
 * `<shimDir>\node.exe` when bundled (the shim's own IF EXIST branch), else
 * the first `node.exe` on PATH. A bare `node` is never returned — node-pty's
 * startProcess does not search PATH and fails with "File not found" (where
 * cmd.exe would have searched it for the shim). Undefined means no usable
 * node was found and the caller must fall back to the cmd.exe launch.
 */
function resolveNodeExecutable(
  io: CmdShimIO,
  shimDir: string,
  envPath: string | undefined,
): string | undefined {
  const bundled = path.win32.join(shimDir, 'node.exe')
  if (io.exists(bundled)) {
    return bundled
  }
  for (const dir of (envPath ?? '').split(';')) {
    const trimmed = dir.trim().replace(/^"+|"+$/g, '')
    if (trimmed === '') {
      continue
    }
    const candidate = path.win32.join(trimmed, 'node.exe')
    if (io.exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Unwraps a `.cmd`/`.bat` shim into a direct launch, or returns undefined
 * when the shim cannot be parsed (caller falls back to cmd.exe). The first
 * candidate whose target exists on disk wins — a shim that references a
 * missing entry would fail under cmd.exe too, so skipping it costs nothing.
 * `.js` entries also require an absolute node runtime (see
 * resolveNodeExecutable). `envPath` is the host PATH used for that lookup.
 */
export function resolveCmdShimDirectLaunch(
  executable: string,
  io: CmdShimIO,
  envPath?: string,
): CmdShimDirectLaunch | undefined {
  const content = io.read(executable)
  if (content === undefined) {
    return undefined
  }
  const shimDir = path.win32.dirname(executable)
  for (const candidate of parseCmdShimCandidates(content, shimDir)) {
    if (!io.exists(candidate.target)) {
      continue
    }
    if (candidate.kind === 'exe') {
      return { command: candidate.target, argsPrefix: [] }
    }
    const node = resolveNodeExecutable(io, shimDir, envPath)
    if (node !== undefined) {
      return { command: node, argsPrefix: [candidate.target] }
    }
  }
  return undefined
}
