/**
 * TASK-064 — CommandClassifier.
 *
 * Purpose per ADR-0002: audit labelling only. Teskra is a PTY host, not a
 * syscall gateway, so nothing here is a pre-execution allow/deny decision —
 * commands are classified *after* they ran to tag audit records.
 *
 * Semantics are conservative: anything the rules cannot recognize is UNKNOWN
 * (never silently downgraded to READ_ONLY), compound commands take the highest
 * risk of their segments, and shell wrappers (bash -lc, wsl.exe -d … --,
 * sudo, env) are peeled so the real command is what gets classified.
 */

export const COMMAND_RISKS = [
  'READ_ONLY',
  'WORKSPACE_WRITE',
  'NETWORK_WRITE',
  'SYSTEM_WRITE',
  'DESTRUCTIVE',
  'UNKNOWN',
] as const
export type CommandRisk = (typeof COMMAND_RISKS)[number]

export interface CommandInvocation {
  readonly executable: string
  readonly args: readonly string[]
}

/**
 * One row of the rule table: pattern → risk. Rules are evaluated in order and
 * the first match wins, so more specific patterns must come first. The table
 * is exported so tests can iterate it and callers can layer custom rules on
 * top via `classifyCommand(line, extraRules)`.
 */
export interface CommandRule {
  readonly id: string
  readonly risk: Exclude<CommandRisk, 'UNKNOWN'>
  readonly match: (command: CommandInvocation) => boolean
}

const RISK_RANK: Record<CommandRisk, number> = {
  READ_ONLY: 1,
  WORKSPACE_WRITE: 2,
  NETWORK_WRITE: 3,
  SYSTEM_WRITE: 4,
  DESTRUCTIVE: 5,
  UNKNOWN: 6,
}

function highest(a: CommandRisk, b: CommandRisk): CommandRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b
}

/* ---------------------------------------------------------------- tokenizer */

const OPERATOR_CHARS = new Set(['&', '|', ';', '>', '<'])
const COMPOUND_OPERATORS = new Set(['&&', '||', '&', '|', ';'])

/**
 * Shell-ish tokenization: quotes and backslash escapes are honored, operators
 * become their own tokens. Returns null for constructs we refuse to reason
 * about (unterminated quotes, command substitution) — the caller maps that
 * to UNKNOWN instead of guessing.
 */
function tokenize(line: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string
    const next = line[index + 1]
    if (quote === 'single') {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === 'double') {
      if (char === '"') quote = null
      else if (char === '\\' && next !== undefined && '"\\$'.includes(next)) {
        current += next
        index += 1
      } else if (char === '`' || (char === '$' && next === '(')) return null
      else current += char
      continue
    }
    if (char === "'") {
      quote = 'single'
      continue
    }
    if (char === '"') {
      quote = 'double'
      continue
    }
    if (char === '\\') {
      if (next !== undefined) {
        current += next
        index += 1
      }
      continue
    }
    if (char === '`' || (char === '$' && next === '(')) return null
    if (/\s/.test(char)) {
      flush()
      continue
    }
    if (OPERATOR_CHARS.has(char)) {
      const pair = line.slice(index, index + 2)
      const triple = line.slice(index, index + 3)
      // fd duplications (`>&`, `&>`, `&>>`) are single redirect tokens — the
      // `&` here is not a background operator.
      if (char === '>' && next === '&') {
        flush()
        tokens.push('>&')
        index += 1
        continue
      }
      if (char === '&' && next === '>') {
        flush()
        tokens.push(triple === '&>>' ? '&>>' : '&>')
        index += triple === '&>>' ? 2 : 1
        continue
      }
      if (char === '>' || char === '<') {
        const operator = pair === '>>' || pair === '<<' ? pair : char
        if (operator.length === 2) index += 1
        // fd-qualified redirects like `2>` stay one token with their digit.
        if (/^\d+$/.test(current)) {
          current += operator
          flush()
        } else {
          flush()
          tokens.push(operator)
        }
        continue
      }
      flush()
      if (pair === '&&' || pair === '||') {
        tokens.push(pair)
        index += 1
      } else {
        tokens.push(char)
      }
      continue
    }
    current += char
  }
  if (quote !== null) return null
  flush()
  return tokens
}

function splitCompound(tokens: readonly string[]): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if (COMPOUND_OPERATORS.has(token)) {
      if (current.length > 0) segments.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

const REDIRECT_PATTERN = /^(?:\d*>>?|\d*<<|>&|&>>?)$/
const FILE_WRITE_REDIRECT = /^\d*>>?$/
// `&> file` / `&>> file` redirect stdout+stderr to a file (not fd dups).
const WRITE_ALL_REDIRECT = /^&>>?$/

/** Extracts redirections; a `>` target that is not an fd dup (`>&1`) writes a file. */
function extractRedirects(tokens: readonly string[]): {
  tokens: string[]
  writesFile: boolean
} {
  const kept: string[] = []
  let writesFile = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (!REDIRECT_PATTERN.test(token)) {
      kept.push(token)
      continue
    }
    const target = tokens[index + 1]
    if (target !== undefined) index += 1
    if (target === undefined || target.startsWith('&')) continue
    if (FILE_WRITE_REDIRECT.test(token) || WRITE_ALL_REDIRECT.test(token)) {
      writesFile = true
    } else if (token === '>&' && !/^\d+$/.test(target) && target !== '-') {
      // `>& word` with a non-numeric word redirects stdout to the file `word`;
      // `>&2` duplicates an fd and `>&-` closes it — neither writes a file.
      writesFile = true
    }
  }
  return { tokens: kept, writesFile }
}

/* ------------------------------------------------------- wrapper peeling */

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_EXECUTABLES = new Set(['bash', 'sh', 'zsh', 'dash'])
const PASSTHROUGH_EXECUTABLES = new Set(['command', 'builtin', 'exec', 'nohup'])

interface Peeled {
  readonly tokens?: readonly string[]
  readonly subshell?: string
  readonly privileged: boolean
}

function skipFlagsWithValues(
  tokens: readonly string[],
  start: number,
  valuedFlags: ReadonlySet<string>,
): number {
  let index = start
  while (index < tokens.length) {
    const token = tokens[index] as string
    if (!token.startsWith('-')) break
    index += valuedFlags.has(token) ? 2 : 1
  }
  return index
}

/**
 * Removes one layer of wrapper (env/sudo/nice/timeout/shell -c/wsl --) from a
 * segment so classification sees the real command. Loops until a plain
 * invocation remains.
 */
function peel(tokens: readonly string[], depth: number): Peeled | null {
  if (depth > 8) return null
  let rest = [...tokens]
  let privileged = false
  for (let guard = 0; guard < 16; guard += 1) {
    while (rest.length > 0 && ASSIGNMENT_PATTERN.test(rest[0] as string)) rest = rest.slice(1)
    const head = normalizeExecutable(rest[0])
    if (head === undefined) return { tokens: [], privileged }
    if (head === 'env') {
      let index = skipFlagsWithValues(rest, 1, new Set(['-u', '--unset', '-C', '--chdir']))
      while (index < rest.length && ASSIGNMENT_PATTERN.test(rest[index] as string)) index += 1
      rest = rest.slice(index)
      continue
    }
    if (head === 'sudo' || head === 'doas') {
      privileged = true
      rest = rest.slice(
        skipFlagsWithValues(rest, 1, new Set(['-u', '-g', '-h', '-p', '-C', '-T'])),
      )
      continue
    }
    if (head === 'nice') {
      rest = rest.slice(skipFlagsWithValues(rest, 1, new Set(['-n', '--adjustment'])))
      continue
    }
    if (head === 'timeout') {
      let index = skipFlagsWithValues(rest, 1, new Set(['-k', '--kill-after', '-s', '--signal']))
      if (index < rest.length) index += 1 // the duration argument
      rest = rest.slice(index)
      continue
    }
    if (PASSTHROUGH_EXECUTABLES.has(head)) {
      rest = rest.slice(1)
      continue
    }
    if (SHELL_EXECUTABLES.has(head)) {
      const commandFlag = rest.findIndex(
        (token, index) =>
          index > 0 && token.startsWith('-') && !token.startsWith('--') && token.includes('c'),
      )
      if (commandFlag !== -1 && commandFlag + 1 < rest.length) {
        return { subshell: rest[commandFlag + 1] as string, privileged }
      }
      return null // interactive shell invocation — nothing classifiable
    }
    if (head === 'wsl') {
      let index = skipFlagsWithValues(
        rest,
        1,
        new Set(['-d', '--distribution', '-u', '--user', '--cd']),
      )
      if (rest[index] === '--') index += 1
      rest = rest.slice(index)
      continue
    }
    return { tokens: rest, privileged }
  }
  return null
}

function normalizeExecutable(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  const base = raw.split(/[\\/]/).pop() ?? raw
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base
}

/* ------------------------------------------------------------ rule table */

function isExec(invocation: CommandInvocation, ...names: string[]): boolean {
  return names.includes(invocation.executable)
}

/** Strips git global options (`git -C <dir> -c k=v …`) so args[0] is the subcommand. */
function gitCommandArgs(args: readonly string[]): readonly string[] {
  let index = 0
  while (index < args.length) {
    const arg = args[index] as string
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(arg)) {
      index += 2
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      index += 1
    } else if (['-P', '--no-pager', '--paginate', '--no-replace-objects'].includes(arg)) {
      index += 1
    } else {
      break
    }
  }
  return args.slice(index)
}

function git(invocation: CommandInvocation): readonly string[] | undefined {
  return isExec(invocation, 'git') ? gitCommandArgs(invocation.args) : undefined
}

function expandedFlags(args: readonly string[]): Set<string> {
  const flags = new Set<string>()
  for (const arg of args) {
    if (arg.startsWith('--')) {
      flags.add(arg)
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      for (const letter of arg.slice(1)) flags.add(`-${letter}`)
    }
  }
  return flags
}

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'describe',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'grep',
  'shortlog',
  'whatchanged',
  'reflog',
  'verify-commit',
  'cat-file',
])
const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'archive'])
const GIT_WRITE_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'mv',
  'rm',
  'checkout',
  'switch',
  'restore',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'stash',
  'config',
  'init',
  'remote',
  'worktree',
  'apply',
  'am',
  'notes',
  'submodule',
])

function dockerArgs(invocation: CommandInvocation): readonly string[] | undefined {
  if (!isExec(invocation, 'docker', 'podman')) return undefined
  return invocation.args[0] === 'compose' ? invocation.args.slice(1) : invocation.args
}

const NPM_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const NPM_NETWORK_SUBCOMMANDS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'uninstall',
  'update',
  'upgrade',
  'publish',
  'login',
  'logout',
  'fetch',
])
const NPM_RUN_SUBCOMMANDS = new Set(['run', 'run-script', 'test', 'exec', 'dlx', 'start', 'x'])

const READ_ONLY_EXECUTABLES = new Set([
  'ls',
  'cat',
  'pwd',
  'echo',
  'printf',
  'which',
  'whereis',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'sort',
  'uniq',
  'date',
  'whoami',
  'hostname',
  'uname',
  'tree',
  'file',
  'stat',
  'du',
  'df',
  'ps',
  'man',
  'cd',
  'true',
  'false',
  'test',
  '[',
  'less',
  'more',
])
const WORKSPACE_WRITE_EXECUTABLES = new Set([
  'cp',
  'mv',
  'mkdir',
  'touch',
  'ln',
  'tee',
  'tar',
  'zip',
  'unzip',
  'gzip',
  'gunzip',
  'install',
  'patch',
  'truncate',
])
const NETWORK_EXECUTABLES = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ping',
  'dig',
  'host',
  'nslookup',
  'nc',
  'ncat',
])
const DESTRUCTIVE_EXECUTABLES = new Set([
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'dd',
  'shred',
  'fdisk',
  'mkfs',
])

/**
 * The rule table — data-driven, ordered, first match wins. Anything not
 * matched here classifies as UNKNOWN; the table deliberately contains no
 * catch-all READ_ONLY rule.
 */
export const COMMAND_RULES: readonly CommandRule[] = [
  // --- git: most specific first
  {
    id: 'git-reset-hard',
    risk: 'DESTRUCTIVE',
    match: (inv) => {
      const args = git(inv)
      return args?.[0] === 'reset' && expandedFlags(args.slice(1)).has('--hard')
    },
  },
  {
    id: 'git-clean',
    risk: 'DESTRUCTIVE',
    match: (inv) => git(inv)?.[0] === 'clean',
  },
  {
    id: 'git-reset',
    risk: 'WORKSPACE_WRITE',
    match: (inv) => git(inv)?.[0] === 'reset',
  },
  {
    id: 'git-push-force',
    risk: 'DESTRUCTIVE',
    match: (inv) => {
      const args = git(inv)
      if (args?.[0] !== 'push') return false
      const flags = expandedFlags(args.slice(1))
      return flags.has('--force') || flags.has('-f') || flags.has('--force-with-lease')
    },
  },
  {
    id: 'git-push',
    risk: 'NETWORK_WRITE',
    match: (inv) => git(inv)?.[0] === 'push',
  },
  {
    id: 'git-network',
    risk: 'NETWORK_WRITE',
    match: (inv) => {
      const sub = git(inv)?.[0]
      return sub !== undefined && GIT_NETWORK_SUBCOMMANDS.has(sub)
    },
  },
  {
    id: 'git-branch-list',
    risk: 'READ_ONLY',
    match: (inv) => {
      const args = git(inv)
      if (args?.[0] !== 'branch') return false
      const rest = args.slice(1)
      return rest.every((arg) => ['-l', '--list', '-a', '-r', '-v', '-vv', '--show-current'].includes(arg))
    },
  },
  {
    id: 'git-tag-list',
    risk: 'READ_ONLY',
    match: (inv) => {
      const args = git(inv)
      if (args?.[0] !== 'tag') return false
      const rest = args.slice(1)
      return rest.every((arg) => ['-l', '--list', '-n'].includes(arg))
    },
  },
  {
    id: 'git-read-only',
    risk: 'READ_ONLY',
    match: (inv) => {
      const sub = git(inv)?.[0]
      return sub !== undefined && GIT_READ_ONLY_SUBCOMMANDS.has(sub)
    },
  },
  {
    id: 'git-write',
    risk: 'WORKSPACE_WRITE',
    match: (inv) => {
      const sub = git(inv)?.[0]
      return sub !== undefined && (GIT_WRITE_SUBCOMMANDS.has(sub) || sub === 'branch' || sub === 'tag')
    },
  },
  // --- file deletion
  {
    id: 'rm-recursive',
    risk: 'DESTRUCTIVE',
    match: (inv) => {
      if (!isExec(inv, 'rm')) return false
      const flags = expandedFlags(inv.args)
      return flags.has('-r') || flags.has('-R') || flags.has('--recursive')
    },
  },
  {
    id: 'rm-file',
    risk: 'WORKSPACE_WRITE',
    match: (inv) => isExec(inv, 'rm'),
  },
  {
    id: 'rmdir',
    risk: 'WORKSPACE_WRITE',
    match: (inv) => isExec(inv, 'rmdir'),
  },
  // --- containers
  {
    id: 'docker-prune',
    risk: 'DESTRUCTIVE',
    match: (inv) => {
      const args = dockerArgs(inv)
      if (args === undefined) return false
      if (args.includes('prune')) return true
      const sub = args[0]
      return (
        (sub !== undefined && ['rm', 'rmi'].includes(sub)) ||
        (sub !== undefined &&
          ['container', 'image', 'volume', 'network'].includes(sub) &&
          args[1] !== undefined &&
          ['rm', 'prune'].includes(args[1]))
      )
    },
  },
  {
    id: 'docker-read-only',
    risk: 'READ_ONLY',
    match: (inv) => {
      const sub = dockerArgs(inv)?.[0]
      return (
        sub !== undefined && ['ps', 'images', 'inspect', 'logs', 'version', 'info', 'stats', 'diff', 'history'].includes(sub)
      )
    },
  },
  {
    id: 'docker-network',
    risk: 'NETWORK_WRITE',
    match: (inv) => {
      const sub = dockerArgs(inv)?.[0]
      return sub !== undefined && ['pull', 'push', 'login', 'logout', 'search'].includes(sub)
    },
  },
  {
    id: 'docker-write',
    risk: 'SYSTEM_WRITE',
    match: (inv) => {
      const sub = dockerArgs(inv)?.[0]
      return (
        sub !== undefined &&
        ['run', 'create', 'start', 'stop', 'restart', 'exec', 'build', 'up', 'down', 'kill', 'rename', 'cp', 'commit', 'tag', 'save', 'load', 'import', 'export'].includes(sub)
      )
    },
  },
  // --- package managers
  {
    id: 'npm-network',
    risk: 'NETWORK_WRITE',
    match: (inv) =>
      NPM_EXECUTABLES.has(inv.executable) &&
      inv.args[0] !== undefined &&
      NPM_NETWORK_SUBCOMMANDS.has(inv.args[0]),
  },
  {
    id: 'npm-run-script',
    risk: 'WORKSPACE_WRITE',
    match: (inv) =>
      NPM_EXECUTABLES.has(inv.executable) &&
      inv.args[0] !== undefined &&
      NPM_RUN_SUBCOMMANDS.has(inv.args[0]),
  },
  {
    id: 'system-package-manager-write',
    risk: 'SYSTEM_WRITE',
    match: (inv) => {
      if (!isExec(inv, 'apt', 'apt-get', 'dnf', 'yum', 'brew', 'pacman', 'pip', 'pip3')) return false
      const sub = inv.args[0]
      if (sub === undefined) return false
      return !['search', 'list', 'show', 'info', 'freeze', '--version', '--help'].includes(sub)
    },
  },
  {
    id: 'system-package-manager-read',
    risk: 'READ_ONLY',
    match: (inv) => isExec(inv, 'apt', 'apt-get', 'dnf', 'yum', 'brew', 'pacman', 'pip', 'pip3'),
  },
  // --- process / system control
  {
    id: 'process-kill',
    risk: 'SYSTEM_WRITE',
    match: (inv) => isExec(inv, 'kill', 'killall', 'pkill'),
  },
  {
    id: 'permission-change',
    risk: 'WORKSPACE_WRITE',
    match: (inv) => isExec(inv, 'chmod', 'chown', 'chgrp'),
  },
  {
    id: 'host-destructive',
    risk: 'DESTRUCTIVE',
    match: (inv) =>
      DESTRUCTIVE_EXECUTABLES.has(inv.executable) || inv.executable.startsWith('mkfs.'),
  },
  // --- network
  {
    id: 'network-tool',
    risk: 'NETWORK_WRITE',
    match: (inv) => NETWORK_EXECUTABLES.has(inv.executable),
  },
  // --- editors-in-place / find
  {
    id: 'sed-in-place',
    risk: 'WORKSPACE_WRITE',
    match: (inv) => {
      if (!isExec(inv, 'sed')) return false
      const flags = expandedFlags(inv.args)
      return (
        flags.has('-i') ||
        [...flags].some((flag) => flag === '--in-place' || flag.startsWith('--in-place='))
      )
    },
  },
  {
    id: 'sed-stream',
    risk: 'READ_ONLY',
    match: (inv) => isExec(inv, 'sed'),
  },
  {
    id: 'find-delete',
    risk: 'DESTRUCTIVE',
    match: (inv) => isExec(inv, 'find') && inv.args.includes('-delete'),
  },
  {
    id: 'find-read',
    risk: 'READ_ONLY',
    match: (inv) => isExec(inv, 'find'),
  },
  // --- common read-only / workspace-write executables
  {
    id: 'common-read-only',
    risk: 'READ_ONLY',
    match: (inv) => READ_ONLY_EXECUTABLES.has(inv.executable),
  },
  {
    id: 'common-workspace-write',
    risk: 'WORKSPACE_WRITE',
    match: (inv) => WORKSPACE_WRITE_EXECUTABLES.has(inv.executable),
  },
]

/* ----------------------------------------------------------- classification */

function classifyInvocation(
  invocation: CommandInvocation,
  rules: readonly CommandRule[],
): CommandRisk {
  return rules.find((rule) => rule.match(invocation))?.risk ?? 'UNKNOWN'
}

function classifySegment(
  tokens: readonly string[],
  rules: readonly CommandRule[],
  depth: number,
): CommandRisk {
  const { tokens: withoutRedirects, writesFile } = extractRedirects(tokens)
  const peeled = peel(withoutRedirects, depth)
  let risk: CommandRisk
  if (peeled === null) {
    risk = 'UNKNOWN'
  } else if (peeled.subshell !== undefined) {
    risk = classifyTokens(peeled.subshell, rules, depth + 1)
  } else {
    const executable = normalizeExecutable(peeled.tokens?.[0])
    risk =
      executable === undefined
        ? 'READ_ONLY' // segment was only env assignments / redirects
        : classifyInvocation({ executable, args: (peeled.tokens ?? []).slice(1) }, rules)
  }
  if (peeled?.privileged === true && RISK_RANK[risk] < RISK_RANK.SYSTEM_WRITE) {
    risk = 'SYSTEM_WRITE'
  }
  if (writesFile && RISK_RANK[risk] < RISK_RANK.WORKSPACE_WRITE) {
    risk = 'WORKSPACE_WRITE'
  }
  return risk
}

function classifyTokens(line: string, rules: readonly CommandRule[], depth: number): CommandRisk {
  const tokens = tokenize(line)
  if (tokens === null) return 'UNKNOWN'
  const segments = splitCompound(tokens)
  if (segments.length === 0) return 'UNKNOWN'
  return segments
    .map((segment) => classifySegment(segment, rules, depth))
    .reduce(highest, 'READ_ONLY' as CommandRisk)
}

/**
 * Classifies a command line for audit labelling (ADR-0002 — this never gates
 * execution). Custom rules are evaluated before the built-in table, so
 * callers can extend or override classification without editing this module.
 */
export function classifyCommand(
  commandLine: string,
  extraRules: readonly CommandRule[] = [],
): CommandRisk {
  return classifyTokens(commandLine, [...extraRules, ...COMMAND_RULES], 0)
}
