import { spawn } from 'node-pty'
import { clearTimeout, setTimeout } from 'node:timers'

const windows = process.platform === 'win32'
const command = windows ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh'
const args = windows
  ? ['/d', '/s', '/c', 'echo teskra-node-pty-smoke']
  : ['-lc', 'printf teskra-node-pty-smoke']

const terminal = spawn(command, args, {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
})

let output = ''
const timer = setTimeout(() => {
  terminal.kill()
  console.error('node-pty Electron ABI smoke timed out')
  process.exit(1)
}, 5_000)

terminal.onData((data) => {
  output += data
})
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer)
  if (exitCode !== 0 || !output.includes('teskra-node-pty-smoke')) {
    console.error(`node-pty smoke failed (exit=${String(exitCode)}): ${JSON.stringify(output)}`)
    process.exit(1)
  }
  console.log('node-pty Electron ABI smoke OK')
  // ConPTY keeps the agent pipes open after the child exits on Windows; the
  // event loop never drains, so exit explicitly instead of hanging CI.
  process.exit(0)
})
