import { describe, expect, it } from 'vitest'

import { CLAUDE_AGENT } from '../agents/definitions/claude'
import { CODEX_AGENT } from '../agents/definitions/codex'
import { createCommandExtractor, extractExecutedCommands, stripAnsi } from './command-extraction'

const ESC = '\u001b'
const BEL = '\u0007'

describe('stripAnsi', () => {
  it('removes CSI color and cursor sequences', () => {
    expect(stripAnsi(`${ESC}[32mgreen${ESC}[0m plain`)).toBe('green plain')
  })

  it('removes OSC title sequences terminated by BEL or ST', () => {
    expect(stripAnsi(`${ESC}]0;title${BEL}$ ls`)).toBe('$ ls')
    expect(stripAnsi(`${ESC}]0;title${ESC}\\$ ls`)).toBe('$ ls')
  })
})

describe('extractExecutedCommands (TASK-065)', () => {
  it('recognizes a bare prompt line', () => {
    expect(extractExecutedCommands('$ git status\r\n')).toEqual(['git status'])
  })

  it('recognizes user@host and path prompts', () => {
    const chunk = 'rockye@dev:~/repo$ git push origin main\n[rockye@dev repo]# rm -rf build\n'
    expect(extractExecutedCommands(chunk)).toEqual(['git push origin main', 'rm -rf build'])
  })

  it('recognizes unicode prompt markers', () => {
    expect(extractExecutedCommands('❯ npm test\n› docker ps\n')).toEqual(['npm test', 'docker ps'])
  })

  it('strips ANSI before matching', () => {
    expect(extractExecutedCommands(`${ESC}[1m~/repo${ESC}[0m$ git status`)).toEqual(['git status'])
  })

  it('never treats prose or program output as commands (false-positive control)', () => {
    const chunk = [
      'The total is $ 500 dollars, and $100 is due.', // `$ ` mid-sentence
      'price: $ 5',
      'Run `$ rm -rf /` to clean up.', // backticked suggestion
      'See also: git push --force-with-lease',
      '> diff hunk line',
      'npm warn deprecated foo@1.0.0',
      '',
    ].join('\n')
    expect(extractExecutedCommands(chunk)).toEqual([])
  })

  it('ignores bare prompt redraws and empty commands', () => {
    expect(extractExecutedCommands('$ \n$ \r\n❯\n')).toEqual([])
  })

  it('keeps stream order and duplicates (the caller dedupes)', () => {
    expect(extractExecutedCommands('$ ls\n$ ls\n$ pwd')).toEqual(['ls', 'ls', 'pwd'])
  })
})

describe('createCommandExtractor (P1-4 cross-chunk line buffering)', () => {
  it('buffers a command line split across chunks', () => {
    const extractor = createCommandExtractor()
    expect(extractor.push('$ git sta')).toEqual([])
    expect(extractor.push('tus\n')).toEqual(['git status'])
  })

  it('joins an ANSI sequence split across chunks before matching', () => {
    const extractor = createCommandExtractor()
    expect(extractor.push(`${ESC}[1m~/repo${ESC}[0`)).toEqual([])
    expect(extractor.push(`m$ git status\n`)).toEqual(['git status'])
  })

  it('flush recognizes the trailing partial line at end of stream', () => {
    const extractor = createCommandExtractor()
    expect(extractor.push('$ git status')).toEqual([])
    expect(extractor.flush()).toEqual(['git status'])
    expect(extractor.flush()).toEqual([])
  })

  it('recognizes complete lines immediately without waiting for flush', () => {
    const extractor = createCommandExtractor()
    expect(extractor.push('$ ls\n$ pw')).toEqual(['ls'])
    expect(extractor.flush()).toEqual(['pw'])
  })
})

describe('Agent-specific TUI patterns (P1-4)', () => {
  it('recognizes Claude Code transcript lines (⏺ / ●)', () => {
    const patterns = CLAUDE_AGENT.auditCommandPatterns ?? []
    expect(extractExecutedCommands('⏺ Bash(npm test)\n  ⎿  42 passing\n', patterns)).toEqual([
      'npm test',
    ])
    expect(extractExecutedCommands('● Bash(git push origin main)\n', patterns)).toEqual([
      'git push origin main',
    ])
  })

  it('recognizes Codex exec blocks (marker line applies to the next line only)', () => {
    const patterns = CODEX_AGENT.auditCommandPatterns ?? []
    const chunk = 'exec\nbash -lc "npm run build" in /home/dev/ws\n succeeded in 9ms:\n'
    expect(extractExecutedCommands(chunk, patterns)).toEqual(['bash -lc "npm run build"'])
  })

  it('splits a codex command at the LAST " in " (cwd boundary), keeping inner ones', () => {
    const patterns = CODEX_AGENT.auditCommandPatterns ?? []
    expect(extractExecutedCommands('exec\necho in out in /tmp\n', patterns)).toEqual([
      'echo in out',
    ])
  })

  it('does not match prose after a marker line or without one', () => {
    const patterns = CODEX_AGENT.auditCommandPatterns ?? []
    expect(extractExecutedCommands('exec\njust some prose\n', patterns)).toEqual([])
    expect(extractExecutedCommands('bash -lc "npm test" in /home/dev/ws\n', patterns)).toEqual([])
  })

  it('keeps the false-positive bar: agent text lines are not commands', () => {
    const patterns = CLAUDE_AGENT.auditCommandPatterns ?? []
    const chunk = [
      '⏺ I’ll run the tests now.', // assistant text, not a tool call
      '⏺ Bash(npm test', // unterminated — multi-line invocation, conservatively missed
      '  ⎿  Bash(npm test)', // tool result echo, not the tool call line
    ].join('\n')
    expect(extractExecutedCommands(chunk, patterns)).toEqual([])
  })

  it('streams agent patterns through the line buffer across chunks', () => {
    const extractor = createCommandExtractor(CLAUDE_AGENT.auditCommandPatterns ?? [])
    expect(extractor.push('⏺ Bash(npm te')).toEqual([])
    expect(extractor.push('st)\n')).toEqual(['npm test'])
  })
})
