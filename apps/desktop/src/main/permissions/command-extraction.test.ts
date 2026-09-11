import { describe, expect, it } from 'vitest'

import { extractExecutedCommands, stripAnsi } from './command-extraction'

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
