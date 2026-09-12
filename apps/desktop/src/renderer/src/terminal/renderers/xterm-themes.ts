import type { ThemeMode } from '../../theme/theme-store'

/**
 * Structural mirror of xterm's `ITheme`. The TASK-082 boundary test forbids
 * `@xterm/*` imports outside `xterm-terminal-renderer.ts` — even type-only
 * ones — so this module declares the shape locally; the renderer's usage is
 * checked against the real `ITheme` structurally at the call site.
 */
export interface XtermThemeColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

/**
 * xterm color themes, kept in a pure-data module so the palette can be
 * unit-tested without importing the xterm.js runtime (which needs a DOM).
 *
 * The dark theme only overrides the base colors; xterm's default 16-color
 * ANSI palette is designed for dark backgrounds. The light theme must ship
 * its own ANSI palette: the defaults (bright yellow/green/cyan) sit below
 * 2:1 contrast on a light surface, and agent CLIs lean heavily on the
 * bright variants for status coloring.
 *
 * Contrast targets on the light background (#f6f8fa), enforced in
 * xterm-themes.test.ts: normal colors ≥ 4.5:1, bright colors ≥ 3:1
 * (bright yellow cannot physically reach 4.5:1 on a near-white surface).
 * ansiWhite / ansiBrightWhite intentionally stay near the background —
 * they play the role of "background-ish" slots in a light terminal.
 */
export const xtermThemes: Record<ThemeMode, XtermThemeColors> = {
  dark: {
    background: '#090d14',
    foreground: '#d9e2ef',
    cursor: '#70ddd1',
    cursorAccent: '#090d14',
    selectionBackground: '#2d5e6d99',
  },
  light: {
    background: '#f6f8fa',
    foreground: '#1f2937',
    cursor: '#0f9b8e',
    cursorAccent: '#f6f8fa',
    selectionBackground: '#0f9b8e33',
    black: '#1f2937',
    red: '#cf1322',
    green: '#237804',
    yellow: '#9e5c00',
    blue: '#0958d9',
    magenta: '#9e1068',
    cyan: '#0f766e',
    white: '#dde3ea',
    brightBlack: '#526075',
    brightRed: '#d9363e',
    brightGreen: '#2c7a0b',
    brightYellow: '#bf7c05',
    brightBlue: '#1668dc',
    brightMagenta: '#c41d7f',
    brightCyan: '#0e7490',
    brightWhite: '#ffffff',
  },
}
