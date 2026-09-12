/**
 * Windows ↔ WSL path conversion (TASK-010).
 *
 * Pure string functions — no I/O, no platform checks. Centralized here so no
 * module hand-rolls `C:\…` → `/mnt/c/…` replacements (plan §8: conversions
 * belong to the WorkspaceRuntime, not scattered string surgery).
 *
 * Two families exist:
 * - drive-letter paths map onto WSL's `/mnt/<drive>` automount;
 * - WSL filesystem paths map onto the `\\wsl$\<distro>\…` (or the newer
 *   `\\wsl.localhost\<distro>\…`) UNC prefix.
 */

const DRIVE_PATH_PATTERN = /^([A-Za-z]):[\\/](.*)$/
const MNT_PATH_PATTERN = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/

const UNC_PREFIXES = ['\\\\wsl$\\', '\\\\wsl.localhost\\'] as const

/** `C:\dev\x` / `C:/dev/x` → `/mnt/c/dev/x`; other inputs → null. */
export function windowsPathToWsl(path: string): string | null {
  const unc = uncPathToWsl(path)
  if (unc !== null) {
    return unc.path
  }
  const drive = DRIVE_PATH_PATTERN.exec(path)
  if (drive === null) {
    return null
  }
  const [, letter, rest] = drive
  if (letter === undefined || rest === undefined) {
    return null
  }
  const suffix = rest.replaceAll('\\', '/').replace(/\/+$/, '')
  return suffix.length > 0
    ? `/mnt/${letter.toLowerCase()}/${suffix}`
    : `/mnt/${letter.toLowerCase()}`
}

/** `/mnt/c/dev/x` → `C:\dev\x`; paths outside /mnt/<drive> → null. */
export function wslPathToWindows(path: string): string | null {
  const mnt = MNT_PATH_PATTERN.exec(path)
  if (mnt === null) {
    return null
  }
  const [, letter, rest] = mnt
  if (letter === undefined) {
    return null
  }
  const drive = `${letter.toUpperCase()}:\\`
  return rest === undefined || rest.length === 0 ? drive : `${drive}${rest.replaceAll('/', '\\')}`
}

/**
 * `/home/u/x` inside `distro` → `\\wsl$\Ubuntu\home\u\x`
 * (`\\wsl.localhost\…` when `options.localhost` is set).
 */
export function wslPathToUnc(
  distro: string,
  wslPath: string,
  options: { localhost?: boolean } = {},
): string {
  const prefix = options.localhost === true ? '\\\\wsl.localhost\\' : '\\\\wsl$\\'
  const segments = wslPath.replace(/^\/+/, '').replace(/\/+$/, '')
  return segments.length > 0
    ? `${prefix}${distro}\\${segments.replaceAll('/', '\\')}`
    : `${prefix}${distro}`
}

/**
 * `\\wsl$\Ubuntu\home\u\x` (or `\\wsl.localhost\…`) →
 * `{ distro: 'Ubuntu', path: '/home/u/x' }`; non-WSL UNC paths → null.
 */
export function uncPathToWsl(path: string): { distro: string; path: string } | null {
  const prefix = UNC_PREFIXES.find((p) => path.toLowerCase().startsWith(p.toLowerCase()))
  if (prefix === undefined) {
    return null
  }
  const rest = path.slice(prefix.length)
  const separator = /[\\/]/
  const firstSeparator = rest.search(separator)
  const distro = firstSeparator === -1 ? rest : rest.slice(0, firstSeparator)
  if (distro.length === 0) {
    return null
  }
  const inner = firstSeparator === -1 ? '' : rest.slice(firstSeparator + 1)
  const posix = inner.replaceAll('\\', '/').replace(/\/+$/, '')
  return { distro, path: posix.length > 0 ? `/${posix}` : '/' }
}
