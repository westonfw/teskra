import { describe, expect, it } from 'vitest'

import { xtermThemes } from './xterm-themes'

const ANSI_NORMAL = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const
const ANSI_BRIGHT = [
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
] as const

function relativeLuminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter = 0, darker = 0] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('xtermThemes', () => {
  it('defines a full 16-color ANSI palette for the light theme', () => {
    const light = xtermThemes.light
    for (const key of [...ANSI_NORMAL, ...ANSI_BRIGHT, 'white', 'brightWhite'] as const) {
      expect(light[key], key).toMatch(/^#[0-9a-f]{6}$/u)
    }
  })

  it('keeps the light background in sync with --surface-sunken', () => {
    expect(xtermThemes.light.background).toBe('#f6f8fa')
  })

  // Agent CLIs lean on ANSI colors for status text; xterm's default palette is
  // tuned for dark backgrounds, so every light-theme color must hold WCAG AA
  // against the light surface. Bright yellow cannot physically reach 4.5:1 on
  // a near-white background, hence the relaxed 3:1 floor for the bright slots.
  it.each(ANSI_NORMAL)('light %s meets 4.5:1 against the light background', (key) => {
    const color = xtermThemes.light[key]
    expect(contrastRatio(color!, xtermThemes.light.background)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(ANSI_BRIGHT)('light %s meets 3:1 against the light background', (key) => {
    const color = xtermThemes.light[key]
    expect(contrastRatio(color!, xtermThemes.light.background)).toBeGreaterThanOrEqual(3)
  })
})
