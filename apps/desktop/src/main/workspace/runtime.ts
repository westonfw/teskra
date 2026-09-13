import { posix, win32 } from 'node:path'

import type { IpcResult, TerminalShell, WorkspaceRuntimeRef } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import { createTeskraPaths, TESKRA_DATA_DIR, type TeskraPaths } from '../paths'
import { windowsPathToWsl } from './wsl-paths'

/**
 * WorkspaceRuntime abstraction (TASK-010, teskra-tasks.md; plan §8 / §116.1).
 *
 * The single place that knows how a workspace kind maps onto the host: how
 * commands are wrapped (`wsl.exe -d …`), which cwd form a runtime expects,
 * where its data root lives (ADR-0003: WSL workspaces keep `~/.teskra`
 * INSIDE the WSL filesystem, never under `C:\Users\…`), and whether the host
 * filesystem can probe the workspace path directly.
 *
 * Agent / Git / Terminal code must never branch on `process.platform` or
 * `runtime.kind === 'wsl'` themselves — an ESLint no-restricted-syntax rule
 * confines platform checks to this module (plus the Electron app-lifecycle
 * check in main/index.ts) and tests.
 *
 * WSL capability probing (running `wsl --version`) is TASK-011's job and
 * depends on CommandRunner (TASK-012), so this module takes the detection
 * result as an injected `WslEnvironmentInfo` instead of executing anything.
 * Without detection info it conservatively falls back to the
 * `bash -lc 'cd … && exec …'` command strategy, which works on every WSL
 * version (`--cd` needs WSL 0.51+).
 */

/** How a command is handed to ProcessManager / node-pty. */
export interface ShellExecutionContext {
  readonly executable: string
  readonly args: readonly string[]
  /** Omitted when the cwd is encoded in `args` (WSL `--cd` / `bash -lc`). */
  readonly cwd?: string | undefined
}

export interface TerminalLaunchSpec {
  readonly command: string
  readonly args: readonly string[]
}

/** TASK-011 detection result; injected, never probed here. */
export interface WslEnvironmentInfo {
  /** Whether wsl.exe is present on the host. */
  readonly available: boolean
  /** `wsl --version` WSL version (e.g. "2.4.11.0"); undefined = unknown. */
  readonly version?: string
  /**
   * Home directory per installed distro (e.g. { "Ubuntu-24.04": "/home/u" }),
   * keyed by canonical distro name. Each distro has its own filesystem, so a
   * single home cannot be shared across distros.
   */
  readonly homeDirs?: Readonly<Record<string, string>>
  /** Effective Teskra/system default distro, when detected. */
  readonly defaultDistro?: string
  /** Installed distro names; enables synchronous runtime validation. */
  readonly distributions?: readonly string[]
}

export type WslCommandStrategy = 'cd-flag' | 'bash-lc'

export interface RuntimeStatus {
  readonly kind: WorkspaceRuntimeRef['kind']
  /** true when node:fs on this host can stat the runtime's paths directly. */
  readonly hostNative: boolean
  /** WSL-on-Windows only: which command wrapping strategy is in effect. */
  readonly wslCommandStrategy?: WslCommandStrategy
}

export interface WorkspaceRuntime {
  readonly ref: WorkspaceRuntimeRef
  /** true when node:fs on this host can stat the runtime's paths directly. */
  readonly hostNative: boolean
  /** Wraps a command + args for execution inside this runtime. */
  resolveCommand(command: string, args?: readonly string[], cwd?: string): ShellExecutionContext
  /** Maps a user-facing shell choice to a logical command for this runtime. */
  resolveTerminal(shell: TerminalShell): IpcResult<TerminalLaunchSpec>
  /** Normalizes a runtime-side path into the cwd form resolveCommand expects. */
  resolveCwd(path: string): string
  /** Maps a runtime-side path into a path that host desktop applications can open. */
  resolveHostPath(path: string): IpcResult<string>
  /**
   * ADR-0003: the data root inside THIS runtime's filesystem. For WSL
   * workspaces this is the WSL-side `~/.teskra`, not a `C:\…` path.
   */
  resolveDataRoot(): string
  /** Environment validation; returns structured errors, never throws. */
  validate(): IpcResult<RuntimeStatus>
}

/** TASK-023: platform lookup stays behind WorkspaceRuntime's platform boundary. */
export function resolveExecutableLookup(
  runtime: WorkspaceRuntime,
  command: string,
): ShellExecutionContext {
  return runtime.ref.kind === 'windows'
    ? runtime.resolveCommand('where.exe', [command])
    : runtime.resolveCommand('which', [command])
}

/**
 * True only for a WSL workspace executing through wsl.exe on a Windows host —
 * the one configuration where host paths and host env vars do not reach the
 * agent process unchanged. On a Linux/WSL2 dev host a "wsl" workspace IS the
 * native filesystem (hostNative), so no translation applies.
 */
function crossesWslBoundary(runtime: WorkspaceRuntime): boolean {
  return runtime.ref.kind === 'wsl' && !runtime.hostNative
}

/**
 * Maps a host-side path into the form a process inside this runtime can use.
 * Run files (handoff.json, artifacts/, permission-settings.json) live in the
 * HOST data root (ADR-0004 2026-09-12: the host writes run logs there and
 * collects handoffs from there), so a WSL-on-Windows agent must reach them
 * through the /mnt/<drive> automount — `C:\Users\u\.teskra\…` → `/mnt/c/…`.
 * Paths that are not drive-letter/UNC Windows paths pass through unchanged,
 * as does every host-native runtime.
 */
export function resolveRuntimePath(runtime: WorkspaceRuntime, hostPath: string): string {
  if (!crossesWslBoundary(runtime)) {
    return runtime.ref.kind === 'windows' ? win32.normalize(hostPath) : posix.normalize(hostPath)
  }
  return windowsPathToWsl(hostPath) ?? hostPath
}

/**
 * Environment variables set on the wsl.exe host process do NOT cross into WSL
 * unless declared in WSLENV (a colon-separated name list). For a WSL-on-Windows
 * runtime this returns `env` plus a WSLENV covering every key (merged with any
 * inherited declaration); host-native runtimes get `env` back untouched.
 * Values are pre-translated via resolveRuntimePath where they hold paths, so
 * plain passthrough (no /p flag) is correct here.
 */
export function resolveSpawnEnv(
  runtime: WorkspaceRuntime,
  env: Readonly<Record<string, string>>,
  inheritedWslEnv?: string,
): Record<string, string> {
  if (!crossesWslBoundary(runtime)) {
    return { ...env }
  }
  const keys = Object.keys(env).filter((key) => key !== 'WSLENV')
  if (keys.length === 0) {
    return { ...env }
  }
  const existing = env['WSLENV'] ?? inheritedWslEnv
  const additions = keys.join(':')
  const wslenv =
    existing !== undefined && existing.length > 0 ? `${existing}:${additions}` : additions
  return { ...env, WSLENV: wslenv }
}

export interface WorkspaceRuntimeDeps {
  /** Host platform override for tests; defaults to process.platform. */
  readonly hostPlatform?: string | undefined
  /** Host-side data root resolution (TASK-078); defaults to the real module. */
  readonly paths?: TeskraPaths
  /** TASK-011 WSL detection result; absent = unknown → conservative fallback. */
  readonly wsl?: WslEnvironmentInfo
}

const WSL_EXE = 'wsl.exe'

/** `--cd` needs WSL 0.51+ (Windows 10 build 21354+); undefined = unknown. */
export function supportsCdFlag(wslVersion: string | undefined): boolean {
  if (wslVersion === undefined) {
    return false
  }
  const segments = wslVersion.split('.').map((s) => Number.parseInt(s, 10))
  if (segments.length < 2 || segments.some((n) => Number.isNaN(n))) {
    return false
  }
  const [major = 0, minor = 0] = segments
  return major > 0 || minor >= 51
}

/** POSIX single-quote escaping for `bash -lc` scripts. */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fail(error: InternalAppError): { ok: false; error: ReturnType<typeof toPublicError> } {
  return { ok: false, error: toPublicError(error) }
}

function unsupportedShell(
  runtime: WorkspaceRuntimeRef['kind'],
  shell: TerminalShell,
): IpcResult<TerminalLaunchSpec> {
  return fail({
    code: 'CAPABILITY_NOT_AVAILABLE',
    message: `Shell "${shell}" is not available in a ${runtime} workspace.`,
    retryable: false,
    detail: `runtime ${runtime} cannot resolve terminal shell ${shell}`,
  })
}

function createWindowsRuntime(
  ref: WorkspaceRuntimeRef,
  hostPlatform: string,
  paths: TeskraPaths,
): WorkspaceRuntime {
  const hostNative = hostPlatform === 'win32'
  return {
    ref,
    hostNative,
    resolveCommand(command, args = [], cwd) {
      return { executable: command, args, ...(cwd !== undefined ? { cwd } : {}) }
    },
    resolveTerminal(shell) {
      switch (shell) {
        case 'powershell':
          return { ok: true, data: { command: 'powershell.exe', args: ['-NoLogo'] } }
        case 'cmd':
          return { ok: true, data: { command: 'cmd.exe', args: ['/Q'] } }
        default:
          return unsupportedShell(ref.kind, shell)
      }
    },
    resolveCwd(path) {
      return win32.normalize(path)
    },
    resolveHostPath(path) {
      return { ok: true, data: win32.normalize(path) }
    },
    resolveDataRoot() {
      return paths.home()
    },
    validate() {
      if (!hostNative) {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: 'Windows workspaces can only execute on a Windows host.',
          retryable: false,
          detail: `host platform is ${hostPlatform}`,
        })
      }
      return { ok: true, data: { kind: 'windows', hostNative } }
    },
  }
}

/**
 * Dev-machine mirror: on a Linux/WSL2 host a "wsl" workspace IS the native
 * filesystem, so commands run directly and paths probe natively — no wsl.exe
 * wrapping (which only exists on Windows).
 */
function createNativePosixRuntime(ref: WorkspaceRuntimeRef, paths: TeskraPaths): WorkspaceRuntime {
  return {
    ref,
    hostNative: true,
    resolveCommand(command, args = [], cwd) {
      return { executable: command, args, ...(cwd !== undefined ? { cwd } : {}) }
    },
    resolveTerminal(shell) {
      return shell === 'bash' || shell === 'wsl'
        ? { ok: true, data: { command: 'bash', args: ['-l'] } }
        : unsupportedShell(ref.kind, shell)
    },
    resolveCwd(path) {
      return posix.normalize(path)
    },
    resolveHostPath(path) {
      return { ok: true, data: posix.normalize(path) }
    },
    resolveDataRoot() {
      return paths.home()
    },
    validate() {
      return { ok: true, data: { kind: ref.kind, hostNative: true } }
    },
  }
}

/** Distro names compare case-insensitively, like validate() does. */
function lookupHomeDir(
  homeDirs: Readonly<Record<string, string>> | undefined,
  distro: string,
): string | undefined {
  if (homeDirs === undefined) {
    return undefined
  }
  const folded = distro.toLocaleLowerCase()
  for (const [name, home] of Object.entries(homeDirs)) {
    if (name.toLocaleLowerCase() === folded) {
      return home
    }
  }
  return undefined
}

function createWslRuntime(
  ref: WorkspaceRuntimeRef,
  paths: TeskraPaths,
  wsl: WslEnvironmentInfo | undefined,
): WorkspaceRuntime {
  // No detection info → conservatively pick the strategy that works on every
  // WSL version; explicit unavailability surfaces in validate().
  const strategy: WslCommandStrategy =
    wsl !== undefined && supportsCdFlag(wsl.version) ? 'cd-flag' : 'bash-lc'
  const distro = ref.distro ?? wsl?.defaultDistro

  const distroArgs = (): string[] => (distro === undefined ? [] : ['-d', distro])

  return {
    ref,
    // WSL paths go through wsl.exe / \\wsl$ from a Windows host; node:fs
    // cannot stat them directly.
    hostNative: false,
    resolveCommand(command, args = [], cwd) {
      if (strategy === 'cd-flag') {
        const wslArgs = distroArgs()
        if (cwd !== undefined) {
          wslArgs.push('--cd', cwd)
        }
        // `--exec` is load-bearing: without it wsl.exe routes the command
        // through `bash -c` with the argv space-joined UNQUOTED, so any arg
        // with shell metacharacters (git pathspec `:(exclude)…`, `*`) breaks
        // and multi-line prompts get torn at every line break — the same
        // truncation class as the Windows cmd-shim bug.
        wslArgs.push('--exec', command, ...args)
        return { executable: WSL_EXE, args: wslArgs }
      }
      const script =
        (cwd !== undefined ? `cd ${quoteShellArg(cwd)} && ` : '') +
        `exec ${[command, ...args].map(quoteShellArg).join(' ')}`
      return { executable: WSL_EXE, args: [...distroArgs(), 'bash', '-lc', script] }
    },
    resolveTerminal(shell) {
      return shell === 'bash' || shell === 'wsl'
        ? { ok: true, data: { command: 'bash', args: ['-l'] } }
        : unsupportedShell(ref.kind, shell)
    },
    resolveCwd(path) {
      return posix.normalize(path)
    },
    resolveHostPath(path) {
      if (distro === undefined || /[\\/]/u.test(distro)) {
        return fail({
          code: 'WSL_DISTRO_NOT_FOUND',
          message: 'Choose a WSL distribution before opening files.',
          retryable: false,
          detail: `cannot map WSL path for distro=${JSON.stringify(distro)}`,
        })
      }
      const normalized = posix.normalize(path)
      if (!normalized.startsWith('/')) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Only absolute WSL paths can be opened by the host.',
          retryable: false,
          detail: `cannot map non-absolute WSL path=${JSON.stringify(path)}`,
        })
      }
      const hostTail = normalized.slice(1).replaceAll('/', '\\')
      return { ok: true, data: `\\\\wsl.localhost\\${distro}\\${hostTail}` }
    },
    resolveDataRoot() {
      // ADR-0003: WSL worktrees must live inside the WSL filesystem, so the
      // data root is the WSL-side ~/.teskra — never the host C:\… one. The
      // home must come from THIS runtime's distro: each distro has its own
      // filesystem, and the resolved path is used verbatim as a --cd / quoted
      // bash cwd, where a tilde would never expand.
      const home = distro === undefined ? undefined : lookupHomeDir(wsl?.homeDirs, distro)
      if (home !== undefined) {
        return posix.join(home, TESKRA_DATA_DIR)
      }
      // Degraded fallback when detection could not probe the distro home.
      return posix.join('~', TESKRA_DATA_DIR)
    },
    validate() {
      if (wsl?.available === false) {
        return fail({
          code: 'WSL_NOT_AVAILABLE',
          message: 'WSL is not available on this machine.',
          retryable: false,
          detail: `wsl.exe not detected on the host; distro ${JSON.stringify(distro)} unreachable`,
        })
      }
      if (wsl?.distributions !== undefined) {
        if (wsl.distributions.length === 0) {
          return fail({
            code: 'WSL_DISTRO_NOT_FOUND',
            message: 'No WSL distributions are installed.',
            retryable: false,
            detail: 'WSL detection returned an empty distribution list',
          })
        }
        if (
          distro !== undefined &&
          !wsl.distributions.some(
            (candidate) => candidate.toLocaleLowerCase() === distro.toLocaleLowerCase(),
          )
        ) {
          return fail({
            code: 'WSL_DISTRO_NOT_FOUND',
            message: `WSL distribution "${distro}" is not installed.`,
            retryable: false,
            detail: `installed distributions: ${wsl.distributions.join(', ')}`,
          })
        }
      }
      return { ok: true, data: { kind: 'wsl', hostNative: false, wslCommandStrategy: strategy } }
    },
  }
}

/**
 * Maps a validated WorkspaceRuntimeRef to the runtime implementation for this
 * host. `ssh` / `container` refs are rejected with CAPABILITY_NOT_AVAILABLE
 * (domain validation in TASK-008 rejects them earlier; this is the backstop).
 */
export function createWorkspaceRuntime(
  ref: WorkspaceRuntimeRef,
  deps: WorkspaceRuntimeDeps = {},
): IpcResult<WorkspaceRuntime> {
  const hostPlatform = deps.hostPlatform ?? process.platform
  const paths = deps.paths ?? createTeskraPaths()

  switch (ref.kind) {
    case 'windows':
      return { ok: true, data: createWindowsRuntime(ref, hostPlatform, paths) }
    case 'wsl':
      return {
        ok: true,
        data:
          hostPlatform === 'win32'
            ? createWslRuntime(ref, paths, deps.wsl)
            : createNativePosixRuntime(ref, paths),
      }
    default:
      return fail({
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: `Workspace runtime "${ref.kind}" is not supported yet.`,
        retryable: false,
        detail: `no WorkspaceRuntime implementation for kind "${ref.kind}"`,
      })
  }
}
