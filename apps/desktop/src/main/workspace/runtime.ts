import { posix, win32 } from 'node:path'

import type { IpcResult, TerminalShell, WorkspaceRuntimeRef } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import { createTeskraPaths, TESKRA_DATA_DIR, type TeskraPaths } from '../paths'

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
  readonly cwd?: string
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
  /** Home directory inside the distro (e.g. "/home/user"), if detected. */
  readonly homeDir?: string
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

export interface WorkspaceRuntimeDeps {
  /** Host platform override for tests; defaults to process.platform. */
  readonly hostPlatform?: string
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
  const [major, minor] = segments
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
        wslArgs.push(command, ...args)
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
      // host paths module only supplies the directory name here.
      if (wsl?.homeDir !== undefined) {
        return posix.join(wsl.homeDir, TESKRA_DATA_DIR)
      }
      // Tilde form: expanded by the WSL shell when the path is used.
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
