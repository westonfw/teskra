// P2-16: single source of truth for the app version. electron-vite injects
// `__TESKRA_APP_VERSION__` into the main and preload bundles via `define`
// (see apps/desktop/electron.vite.config.ts); vitest.config.ts provides the
// same define so unit tests resolve the identical value. The injected value
// is TESKRA_APP_VERSION when set (scripts/release.mjs exports it so the
// bundle matches -c.extraMetadata.version) and otherwise the version field
// of apps/desktop/package.json — which is also what `app.getVersion()`
// reports in dev.
declare const __TESKRA_APP_VERSION__: string

export const APP_VERSION: string = __TESKRA_APP_VERSION__
