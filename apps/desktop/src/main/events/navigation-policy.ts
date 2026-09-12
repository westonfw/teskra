/**
 * P1-10: in-window navigation policy for the single application BrowserWindow.
 * `will-navigate` does not fire for programmatic loadURL/loadFile, so this
 * only gates page-initiated navigations (links, location.assign, HMR reloads).
 *
 * Dev mode allows same-origin navigations within the vite dev server origin
 * (covers HMR full reloads); the packaged app allows only file: URLs.
 */
export function isAllowedNavigation(url: string, rendererUrl?: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (rendererUrl !== undefined) {
    let allowed: URL
    try {
      allowed = new URL(rendererUrl)
    } catch {
      return false
    }
    return target.origin === allowed.origin
  }
  return target.protocol === 'file:'
}
