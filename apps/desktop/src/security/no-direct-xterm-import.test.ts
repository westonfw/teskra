import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const terminalRoot = join(srcRoot, 'renderer/src/terminal')
const implementation = join(terminalRoot, 'renderers/xterm-terminal-renderer.ts')

function sources(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const target = join(path, entry)
    return statSync(target).isDirectory() ? sources(target) : /\.tsx?$/u.test(entry) ? [target] : []
  })
}

describe('TerminalRenderer boundary (TASK-082)', () => {
  it('keeps xterm imports out of UI components and all other modules', () => {
    const offenders = sources(terminalRoot).filter(
      (path) => path !== implementation && !path.endsWith('.test.ts'),
    )
    for (const path of offenders) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/from ['"]@xterm\//u)
    }
    expect(readFileSync(implementation, 'utf8')).toContain("from '@xterm/xterm'")
  })
})
