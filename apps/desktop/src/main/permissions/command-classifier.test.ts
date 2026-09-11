import { describe, expect, it } from 'vitest'

import {
  COMMAND_RISKS,
  COMMAND_RULES,
  classifyCommand,
  type CommandRule,
} from './command-classifier'

describe('CommandClassifier acceptance mappings (TASK-064)', () => {
  it.each([
    ['git status', 'READ_ONLY'],
    ['git diff HEAD~1', 'READ_ONLY'],
    ['git log --oneline', 'READ_ONLY'],
    ['git push', 'NETWORK_WRITE'],
    ['git push origin main', 'NETWORK_WRITE'],
    ['git fetch --all', 'NETWORK_WRITE'],
    ['git reset --hard', 'DESTRUCTIVE'],
    ['git reset --hard HEAD~3', 'DESTRUCTIVE'],
    ['git reset --soft HEAD~1', 'WORKSPACE_WRITE'],
    ['git clean -fd', 'DESTRUCTIVE'],
    ['git push --force', 'DESTRUCTIVE'],
    ['git push --force-with-lease', 'DESTRUCTIVE'],
    ['git commit -m "wip"', 'WORKSPACE_WRITE'],
    ['git add .', 'WORKSPACE_WRITE'],
    ['git checkout feature', 'WORKSPACE_WRITE'],
    ['git branch', 'READ_ONLY'],
    ['git branch -d old', 'WORKSPACE_WRITE'],
    ['git -C /repo status', 'READ_ONLY'],
    ['rm -rf build/', 'DESTRUCTIVE'],
    ['rm -fr /tmp/x', 'DESTRUCTIVE'],
    ['rm -r node_modules', 'DESTRUCTIVE'],
    ['rm report.txt', 'WORKSPACE_WRITE'],
    ['docker system prune', 'DESTRUCTIVE'],
    ['docker system prune -a --volumes', 'DESTRUCTIVE'],
    ['docker container prune', 'DESTRUCTIVE'],
    ['docker rm abc123', 'DESTRUCTIVE'],
    ['docker ps', 'READ_ONLY'],
    ['docker pull ubuntu', 'NETWORK_WRITE'],
    ['docker run -it ubuntu bash', 'SYSTEM_WRITE'],
    ['docker compose up -d', 'SYSTEM_WRITE'],
  ] as const)('%s → %s', (command, risk) => {
    expect(classifyCommand(command)).toBe(risk)
  })
})

describe('CommandClassifier conservative semantics (TASK-064)', () => {
  it('returns UNKNOWN for unrecognized commands instead of degrading to READ_ONLY', () => {
    expect(classifyCommand('mycustomtool --do-something')).toBe('UNKNOWN')
    expect(classifyCommand('git bisect run ./test.sh')).toBe('UNKNOWN')
    expect(classifyCommand('node scripts/migrate.js')).toBe('UNKNOWN')
    expect(classifyCommand('')).toBe('UNKNOWN')
  })

  it('returns UNKNOWN when command substitution hides the real command', () => {
    expect(classifyCommand('echo $(rm -rf /)')).toBe('UNKNOWN')
    expect(classifyCommand('cat `which secret`')).toBe('UNKNOWN')
  })

  it('takes the highest risk across compound commands', () => {
    expect(classifyCommand('git status && git push')).toBe('NETWORK_WRITE')
    expect(classifyCommand('ls; rm -rf /tmp/x')).toBe('DESTRUCTIVE')
    expect(classifyCommand('git status && mycustomtool')).toBe('UNKNOWN')
    expect(classifyCommand('cat log.txt | grep error')).toBe('READ_ONLY')
  })

  it('peels shell wrappers to see the real command', () => {
    expect(classifyCommand('bash -lc "git push"')).toBe('NETWORK_WRITE')
    expect(classifyCommand("sh -c 'rm -rf /tmp/x'")).toBe('DESTRUCTIVE')
    expect(classifyCommand('wsl.exe -d Ubuntu -- git status')).toBe('READ_ONLY')
    expect(classifyCommand("wsl -d Ubuntu bash -lc 'git reset --hard'")).toBe('DESTRUCTIVE')
    expect(classifyCommand('env CI=true npm test')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('timeout 30 curl example.com')).toBe('NETWORK_WRITE')
  })

  it('raises the floor to SYSTEM_WRITE under sudo', () => {
    expect(classifyCommand('sudo apt install vim')).toBe('SYSTEM_WRITE')
    expect(classifyCommand('sudo cat /etc/shadow')).toBe('SYSTEM_WRITE')
    expect(classifyCommand('sudo rm -rf /var/tmp/x')).toBe('DESTRUCTIVE')
  })

  it('treats output redirection to a file as a workspace write', () => {
    expect(classifyCommand('echo done > marker.txt')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('npm test 2>&1 | tail -5')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('git status > status.txt')).toBe('WORKSPACE_WRITE')
  })

  it('treats bash &>/&>>/>& file redirections as workspace writes, fd dups as no write', () => {
    expect(classifyCommand('git status &> out.txt')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('git status &>> out.txt')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('git status >& out.txt')).toBe('WORKSPACE_WRITE')
    // `>&2` / `1>&2` duplicate an fd — nothing is written to a file.
    expect(classifyCommand('echo hi >&2')).toBe('READ_ONLY')
    expect(classifyCommand('echo hi 1>&2')).toBe('READ_ONLY')
  })

  it('quotes do not confuse tokenization', () => {
    expect(classifyCommand('echo "a && b"')).toBe('READ_ONLY')
    expect(classifyCommand('git commit -m "fix: rm -rf typo"')).toBe('WORKSPACE_WRITE')
  })
})

describe('CommandClassifier rule table (TASK-064)', () => {
  it('classifies sed in-place editing as a workspace write, including the long flag', () => {
    expect(classifyCommand('sed -i s/a/b/ file.txt')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('sed --in-place s/a/b/ file.txt')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('sed --in-place=.bak s/a/b/ file.txt')).toBe('WORKSPACE_WRITE')
    expect(classifyCommand('sed s/a/b/ file.txt')).toBe('READ_ONLY')
  })

  it('is data-driven: every rule has an id and a non-UNKNOWN risk', () => {
    expect(COMMAND_RULES.length).toBeGreaterThan(0)
    for (const rule of COMMAND_RULES) {
      expect(rule.id).toBeTruthy()
      expect(COMMAND_RISKS).toContain(rule.risk)
      expect(rule.risk).not.toBe('UNKNOWN')
    }
  })

  it('is extensible: a custom rule classifies commands the table does not know', () => {
    const terraformRules: CommandRule[] = [
      {
        id: 'terraform-destroy',
        risk: 'DESTRUCTIVE',
        match: ({ executable, args }) => executable === 'terraform' && args[0] === 'destroy',
      },
      {
        id: 'terraform-read',
        risk: 'READ_ONLY',
        match: ({ executable, args }) =>
          executable === 'terraform' && ['plan', 'show', 'output'].includes(args[0] ?? ''),
      },
    ]
    expect(classifyCommand('terraform destroy')).toBe('UNKNOWN')
    expect(classifyCommand('terraform destroy', terraformRules)).toBe('DESTRUCTIVE')
    expect(classifyCommand('terraform plan', terraformRules)).toBe('READ_ONLY')
    // Custom rules layer on top of the built-in table, not instead of it.
    expect(classifyCommand('git push', terraformRules)).toBe('NETWORK_WRITE')
  })
})
