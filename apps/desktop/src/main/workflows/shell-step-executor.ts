import type { ArtifactType, IpcResult } from '@teskra/contracts'

import type { ArtifactStore } from '../artifacts/artifact-store'
import { getLogger } from '../logger'
import type { CommandRequest, CommandResult, CommandRunner } from '../process/command-runner'
import type { StepCompletion, WorkflowStepExecutor } from './workflow-engine'

/**
 * Shell workflow step executor (TASK-058; plan §153 shell nodes).
 *
 * Runs `ShellWorkflowNode.command` lines such as `dotnet test` / `npm test` /
 * `git status` through CommandRunner — never a direct spawn (architecture red
 * line). The command executes under the run's WorkspaceRuntime with the
 * workspace path as cwd, both supplied via WorkflowExecutionContext.
 *
 * - Timeout: `node.timeoutMs`, falling back to `defaultTimeoutMs`;
 *   CommandRunner kills the process tree on expiry and reports
 *   COMMAND_TIMEOUT, which fails the step with `timedOut: true`.
 * - The exit code becomes the step result (`result.exitCode`); 0 completes
 *   the step with outcome `success`, anything else fails it with `failure`
 *   so `on: failure` edges can react.
 * - Combined stdout/stderr is recorded as an Artifact (TASK-050) — type
 *   `test-result` / `diff` / `implementation` depending on the command's
 *   semantics. Artifacts attach to a Task, so recording is skipped for
 *   task-less runs (ADR-0006); recording failures are logged, never fatal.
 */

export const DEFAULT_SHELL_STEP_TIMEOUT_MS = 10 * 60 * 1000

/** Inline artifact payloads are capped; CommandRunner's buffer cap stays the hard limit. */
export const MAX_ARTIFACT_OUTPUT_CHARS = 256 * 1024

export interface ShellStepExecutorDeps {
  readonly commands: CommandRunner
  readonly artifacts?: Pick<ArtifactStore, 'record'>
  readonly defaultTimeoutMs?: number
  readonly maxArtifactChars?: number
}

/**
 * Splits a command line into argv without invoking a shell: whitespace
 * separates tokens, single/double quotes group. No expansion or escaping —
 * a full shell is intentionally out of scope.
 */
export function splitCommandLine(input: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? (match[3] as string))
  }
  return tokens
}

/** Artifact type from the command's semantics (plan: test-result 或 diff 视语义). */
export function shellArtifactType(command: string): ArtifactType {
  const lowered = command.toLowerCase()
  if (lowered.includes('test')) return 'test-result'
  if (lowered.includes('diff')) return 'diff'
  return 'implementation'
}

function formatOutput(command: string, result: CommandResult, maxChars: number): string {
  const content =
    `$ ${command}\nexit code: ${String(result.exitCode)}\n\n` +
    `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n… [truncated]` : content
}

export function createShellStepExecutor(deps: ShellStepExecutorDeps): WorkflowStepExecutor {
  const logger = getLogger('runtime')
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_SHELL_STEP_TIMEOUT_MS
  const maxArtifactChars = deps.maxArtifactChars ?? MAX_ARTIFACT_OUTPUT_CHARS
  /** stepId → in-flight abort handle, for WorkflowEngine.cancel. */
  const aborts = new Map<string, AbortController>()

  const recordOutput = (
    taskId: string,
    nodeId: string,
    command: string,
    result: CommandResult,
  ): string | undefined => {
    if (deps.artifacts === undefined) return undefined
    const recorded = deps.artifacts.record({
      taskId,
      type: shellArtifactType(command),
      name: `shell step "${nodeId}" output`,
      content: formatOutput(command, result, maxArtifactChars),
    })
    if (!recorded.ok) {
      logger.error(
        { taskId, nodeId, error: recorded.error },
        'Failed to record the shell step output artifact; the step result is unaffected.',
      )
      return undefined
    }
    return recorded.data.id
  }

  return {
    async execute({ run, step, node, context }): Promise<StepCompletion> {
      if (node.type !== 'shell') {
        return { outcome: 'failure', result: { error: 'shell executor received a non-shell node' } }
      }
      if (context.runtime === undefined || context.cwd === undefined) {
        return {
          outcome: 'failure',
          result: {
            error: 'Shell steps require WorkflowExecutionContext.runtime and .cwd.',
          },
        }
      }
      const argv = splitCommandLine(node.command)
      const command = argv[0]
      if (command === undefined) {
        return { outcome: 'failure', result: { error: 'The shell step command is empty.' } }
      }

      const abort = new AbortController()
      aborts.set(step.id, abort)
      let commandResult: IpcResult<CommandResult>
      try {
        const request: CommandRequest = {
          command,
          args: argv.slice(1),
          cwd: context.cwd,
          timeoutMs: node.timeoutMs ?? defaultTimeoutMs,
          signal: abort.signal,
          runtime: context.runtime,
        }
        commandResult = await deps.commands.run(request)
      } finally {
        aborts.delete(step.id)
      }

      if (!commandResult.ok) {
        return {
          outcome: 'failure',
          result: {
            error: commandResult.error.message,
            ...(commandResult.error.code === 'COMMAND_TIMEOUT' ? { timedOut: true } : {}),
          },
        }
      }

      const result = commandResult.data
      // Artifacts attach to a Task (TASK-050); task-less runs (ADR-0006)
      // skip recording — the exit code still lands in the step result.
      const artifactId =
        run.taskId === undefined
          ? undefined
          : recordOutput(run.taskId, node.id, node.command, result)
      return {
        outcome: result.exitCode === 0 ? 'success' : 'failure',
        result: {
          exitCode: result.exitCode,
          ...(artifactId === undefined ? {} : { artifactId }),
        },
      }
    },

    cancel(stepId) {
      aborts.get(stepId)?.abort()
    },
  }
}
