import { describe, expect, it } from 'vitest'

import {
  buildCmdShimCommandLine,
  buildCmdShimSpawn,
  cmdShimArgsNeedDirectLaunch,
  type CmdShimIO,
  isWindowsCmdShim,
  quoteCmdArg,
  resolveCmdShimDirectLaunch,
  resolveWindowsCommandPath,
} from './windows-shim'

describe('isWindowsCmdShim', () => {
  it('matches .cmd and .bat executables case-insensitively', () => {
    expect(isWindowsCmdShim('C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd')).toBe(true)
    expect(isWindowsCmdShim('C:\\Tools\\CLAUDE.CMD')).toBe(true)
    expect(isWindowsCmdShim('kimi.bat')).toBe(true)
  })

  it('rejects real executables and extension-less shims', () => {
    expect(isWindowsCmdShim('C:\\Tools\\codex.exe')).toBe(false)
    expect(isWindowsCmdShim('C:\\Users\\u\\AppData\\Roaming\\npm\\codex')).toBe(false)
    expect(isWindowsCmdShim('codex')).toBe(false)
    expect(isWindowsCmdShim('/usr/local/bin/codex')).toBe(false)
    expect(isWindowsCmdShim('C:\\Tools\\codex.ps1')).toBe(false)
  })
})

describe('quoteCmdArg', () => {
  it('leaves plain arguments untouched', () => {
    expect(quoteCmdArg('--version')).toBe('--version')
    expect(quoteCmdArg('exec')).toBe('exec')
    expect(quoteCmdArg('C:\\Tools\\codex.exe')).toBe('C:\\Tools\\codex.exe')
  })

  it('quotes whitespace and cmd metacharacters, doubling embedded quotes', () => {
    expect(quoteCmdArg('hello world')).toBe('"hello world"')
    expect(quoteCmdArg('a&b')).toBe('"a&b"')
    expect(quoteCmdArg('50%')).toBe('"50%"')
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""')
  })
})

describe('buildCmdShimSpawn', () => {
  it('builds the cmd.exe /d /s /c call spawn shape with verbatim arguments', () => {
    expect(
      buildCmdShimSpawn(
        'C:\\npm\\codex.cmd',
        ['exec', 'fix the bug'],
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call', '"C:\\npm\\codex.cmd"', 'exec', '"fix the bug"'],
      verbatim: true,
    })
  })

  it('defaults comspec to cmd.exe', () => {
    expect(buildCmdShimSpawn('codex.cmd', []).command).toBe('cmd.exe')
  })
})

describe('buildCmdShimCommandLine', () => {
  it('builds the pre-quoted single-string command line for node-pty', () => {
    expect(buildCmdShimCommandLine('C:\\npm\\codex.cmd', ['--model', 'gpt 5'])).toBe(
      '/d /s /c call "C:\\npm\\codex.cmd" --model "gpt 5"',
    )
  })

  it('handles empty args', () => {
    expect(buildCmdShimCommandLine('C:\\npm\\kimi.cmd', [])).toBe(
      '/d /s /c call "C:\\npm\\kimi.cmd"',
    )
  })
})

describe('cmdShimArgsNeedDirectLaunch', () => {
  it('requires a direct launch when any argument contains a line break', () => {
    // cmd's batch parser ends the command at the first line break even inside
    // quotes; the shim's %* then forwards only the first line (observed on a
    // real Windows host: a multi-line codex prompt arrived truncated).
    expect(cmdShimArgsNeedDirectLaunch('codex.cmd', ['exec', 'line1\nline2'])).toBe(true)
    expect(cmdShimArgsNeedDirectLaunch('codex.cmd', ['exec', 'line1\r\nline2'])).toBe(true)
    expect(cmdShimArgsNeedDirectLaunch('codex.cmd', ['exec', 'line1\rline2'])).toBe(true)
  })

  it('requires a direct launch past the cmd command-line ceiling', () => {
    expect(cmdShimArgsNeedDirectLaunch('codex.cmd', ['x'.repeat(9_000)])).toBe(true)
  })

  it('keeps the verified cmd.exe path for ordinary arguments', () => {
    expect(cmdShimArgsNeedDirectLaunch('codex.cmd', ['exec', 'fix the bug'])).toBe(false)
    expect(cmdShimArgsNeedDirectLaunch('codex.cmd', [])).toBe(false)
  })
})

describe('resolveCmdShimDirectLaunch', () => {
  const NPM_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    '',
  ].join('\r\n')

  const SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd'
  const ENTRY = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'

  function ioWith(content: string | undefined, existing: readonly string[]): CmdShimIO {
    return {
      read: (path) => (path === SHIM ? content : undefined),
      exists: (path) => existing.includes(path),
    }
  }

  it('unwraps an npm shim into the PATH-resolved node + the .js entry', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    expect(
      resolveCmdShimDirectLaunch(
        SHIM,
        ioWith(NPM_SHIM, [ENTRY, node]),
        'C:\\Program Files\\nodejs',
      ),
    ).toEqual({
      command: node,
      argsPrefix: [ENTRY],
    })
  })

  it('prefers a node.exe bundled next to the shim (the shim IF EXIST branch)', () => {
    const bundled = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node.exe'
    expect(resolveCmdShimDirectLaunch(SHIM, ioWith(NPM_SHIM, [ENTRY, bundled]))).toEqual({
      command: bundled,
      argsPrefix: [ENTRY],
    })
  })

  it('returns undefined for a .js target when no node runtime can be resolved', () => {
    // A bare "node" would crash node-pty ("File not found" — it does not
    // search PATH), so the caller must fall back to the cmd.exe launch.
    expect(
      resolveCmdShimDirectLaunch(SHIM, ioWith(NPM_SHIM, [ENTRY]), 'C:\\nowhere'),
    ).toBeUndefined()
  })

  it('unwraps a scoop-style shim into the referenced .exe directly', () => {
    const scoop = '@"C:\\Users\\u\\scoop\\apps\\codex\\current\\codex.exe" %*\r\n'
    expect(
      resolveCmdShimDirectLaunch(
        SHIM,
        ioWith(scoop, ['C:\\Users\\u\\scoop\\apps\\codex\\current\\codex.exe']),
      ),
    ).toEqual({ command: 'C:\\Users\\u\\scoop\\apps\\codex\\current\\codex.exe', argsPrefix: [] })
  })

  it('skips unresolved %VAR% tokens and lines without %*', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const result = resolveCmdShimDirectLaunch(
      SHIM,
      ioWith(NPM_SHIM, [ENTRY, node]),
      'C:\\Program Files\\nodejs',
    )
    // "%_prog%" and the IF EXIST "%dp0%\node.exe" line must not win over the
    // real forwarding target.
    expect(result?.command).toBe(node)
    expect(result?.argsPrefix).toEqual([ENTRY])
  })

  it('returns undefined when the shim cannot be read', () => {
    expect(resolveCmdShimDirectLaunch(SHIM, ioWith(undefined, [ENTRY]))).toBeUndefined()
  })

  it('returns undefined when the shim forwards to nothing recognizable', () => {
    expect(
      resolveCmdShimDirectLaunch(SHIM, ioWith('@echo off\r\necho hi %1\r\n', [])),
    ).toBeUndefined()
  })

  it('returns undefined when the referenced target does not exist on disk', () => {
    expect(resolveCmdShimDirectLaunch(SHIM, ioWith(NPM_SHIM, []))).toBeUndefined()
  })
})

describe('resolveWindowsCommandPath', () => {
  const io: CmdShimIO = {
    read: () => undefined,
    exists: (path) => path === 'C:\\npm\\npm.cmd' || path === 'C:\\Windows\\System32\\where.exe',
  }

  it('resolves a bare name to the first PATH+PATHEXT match', () => {
    // `npm` exists on PATH only as npm.cmd — the file spawn cannot launch
    // directly, which is exactly why the caller needs this resolution.
    expect(
      resolveWindowsCommandPath('npm', io, 'C:\\Windows\\System32;C:\\npm', '.COM;.EXE;.BAT;.CMD'),
    ).toBe('C:\\npm\\npm.cmd')
  })

  it('tries the name as-is when it already carries an executable extension', () => {
    expect(resolveWindowsCommandPath('where.exe', io, 'C:\\Windows\\System32', '.COM;.EXE')).toBe(
      'C:\\Windows\\System32\\where.exe',
    )
  })

  it('ignores qualified paths (spawn handles those itself)', () => {
    expect(resolveWindowsCommandPath('C:\\npm\\npm.cmd', io, 'C:\\npm')).toBeUndefined()
    expect(resolveWindowsCommandPath('scripts/build.cmd', io, 'C:\\x')).toBeUndefined()
  })

  it('returns undefined when the name is nowhere on PATH', () => {
    expect(resolveWindowsCommandPath('nope', io, 'C:\\npm')).toBeUndefined()
    expect(resolveWindowsCommandPath('nope', io, undefined)).toBeUndefined()
  })
})
