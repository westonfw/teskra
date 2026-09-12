import { describe, expect, it } from 'vitest'
import { spawn } from 'node-pty'

function hostShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'echo teskra-node-pty-smoke'],
    }
  }
  return { command: '/bin/sh', args: ['-lc', 'printf teskra-node-pty-smoke'] }
}

describe('node-pty native integration (TASK-013)', () => {
  it('spawns a PTY, captures output, and exits cleanly', async () => {
    const shell = hostShell()
    const terminal = spawn(shell.command, shell.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    })

    const result = await new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => {
        terminal.kill()
        reject(new Error('node-pty smoke timed out'))
      }, 5_000)
      terminal.onData((data) => {
        output += data
      })
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer)
        resolve({ output, exitCode })
      })
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('teskra-node-pty-smoke')
  })
})
