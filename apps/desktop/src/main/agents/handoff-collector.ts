import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  handoffTypeSchema,
  workerHandoffSchema,
  type DecisionOption,
  type HandoffType,
  type IpcResult,
} from '@teskra/contracts'

import type { JsonRecord } from '../db/repositories/common'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type {
  Handoff,
  HandoffRepository,
  SaveHandoffInput,
} from '../db/repositories/handoff-repository'
import type { DecisionService } from '../decisions/decision-service'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'

const FALLBACK_SUMMARY_MAX_CHARS = 2_000

/** Fallback rows have no Agent-declared type; 'analysis' is the neutral bucket. */
const FALLBACK_TYPE: HandoffType = 'analysis'

/** §9.2 vocabulary; dismiss is the timeout default (DECISION_TIMEOUT_DEFAULT_OPTIONS). */
const HANDOFF_DEGRADED_OPTIONS: readonly DecisionOption[] = [
  { id: 'open_raw', label: 'Open raw file' },
  { id: 'dismiss', label: 'Dismiss' },
]

export interface HandoffCollectorDeps {
  readonly handoffs: HandoffRepository
  readonly paths: TeskraPaths
  /**
   * TASK-130 (ADR-0014 §3, design §9.2): a `degraded` result also opens a
   * persisted `handoff_degraded` decision (open_raw / dismiss). The run row
   * supplies the decision's workspaceId, so both deps are required for the
   * decision; without them the collector keeps its TASK-051 log-only behavior.
   */
  readonly decisions?: Pick<DecisionService, 'open'>
  readonly runs?: Pick<AgentRunRepository, 'getById'>
  readonly createHandoffId?: () => string
  readonly now?: () => string
}

export interface HandoffCollector {
  /**
   * ADR-0004 post-exit collection: reads the file at TESKRA_HANDOFF_PATH
   * (never stdout) and persists exactly one `handoffs` row per run.
   *
   * - file with valid WorkerHandoff for this run → parse_status 'ok'
   * - file present but unreadable as a valid handoff → 'degraded', the raw
   *   file is kept untouched and referenced via raw_path, warning logged
   * - file absent/empty → 'missing', payload falls back to a truncated
   *   terminal.log tail marked with its source
   *
   * Never throws and never blocks Run completion: failures surface as an
   * error result plus a log entry, and callers are expected to carry on.
   */
  collect(runId: string): IpcResult<Handoff | null>
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** TASK-051 (ADR-0004): the file-contract reader behind AgentManager's exit path. */
export function createHandoffCollector(deps: HandoffCollectorDeps): HandoffCollector {
  const logger = getLogger('agent')
  const createHandoffId = deps.createHandoffId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())

  const readText = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }

  const terminalSummary = (terminalPath: string): string => {
    const log = readText(terminalPath)
    if (log === undefined) return 'The Agent terminal log is unavailable.'
    const tail = log.slice(-FALLBACK_SUMMARY_MAX_CHARS).trim()
    return tail.length > 0 ? tail : 'The Agent produced no terminal output.'
  }

  /**
   * TASK-130: a degraded handoff surfaces in the Decision Inbox. Best-effort —
   * collection never blocks on it (the decision needs the run row only for its
   * workspaceId).
   */
  const openDegradedDecision = (
    runId: string,
    rawPath: string,
    issues?: readonly string[],
  ): void => {
    if (deps.decisions === undefined || deps.runs === undefined) return
    const run = deps.runs.getById(runId)
    if (!run.ok) {
      logger.error(
        { runId, error: run.error },
        'Failed to read the run for the degraded-handoff decision.',
      )
      return
    }
    if (run.data === null) {
      logger.warn({ runId }, 'Handoff is degraded but the run row is gone; no decision opened.')
      return
    }
    const opened = deps.decisions.open({
      workspaceId: run.data.workspaceId,
      kind: 'handoff_degraded',
      severity: 'warning',
      dedupeKey: `handoff_degraded:${runId}`,
      title: 'The Agent handoff failed validation',
      detail: {
        kind: 'handoff_degraded',
        rawPath,
        ...(issues === undefined ? {} : { issues: [...issues] }),
      },
      options: HANDOFF_DEGRADED_OPTIONS,
      runId,
    })
    if (!opened.ok) {
      logger.error({ runId, error: opened.error }, 'Failed to open the degraded-handoff decision.')
    }
  }

  return {
    collect(runId) {
      const files = deps.paths.runFiles(runId)
      if (!files.ok) {
        logger.error(
          { runId, error: files.error },
          'Handoff collection could not resolve the run files.',
        )
        return { ok: false, error: files.error }
      }
      const save = (input: Omit<SaveHandoffInput, 'id' | 'runId'>): IpcResult<Handoff | null> => {
        const saved = deps.handoffs.save({ id: createHandoffId(), runId, ...input }, now())
        if (!saved.ok) {
          logger.error({ runId, error: saved.error }, 'Failed to persist the collected handoff.')
        }
        return saved
      }

      // RunLogStore.initialize() touches handoff.json, so an empty file is
      // the common "Agent wrote nothing" shape and counts as missing.
      const raw = readText(files.data.handoff)
      if (raw === undefined || raw.trim().length === 0) {
        return save({
          type: FALLBACK_TYPE,
          payload: { source: 'terminal.log', summary: terminalSummary(files.data.terminal) },
          parseStatus: 'missing',
        })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        logger.warn(
          { runId, path: files.data.handoff, cause },
          'Handoff file is not valid JSON; the raw file is kept.',
        )
        openDegradedDecision(runId, files.data.handoff)
        return save({ type: FALLBACK_TYPE, rawPath: files.data.handoff, parseStatus: 'degraded' })
      }

      const validated = workerHandoffSchema.safeParse(parsed)
      if (validated.success && validated.data.runId === runId) {
        return save({
          type: validated.data.type,
          payload: validated.data,
          rawPath: files.data.handoff,
          parseStatus: 'ok',
        })
      }

      const partial = isRecord(parsed) ? parsed : undefined
      const declaredType = handoffTypeSchema.safeParse(partial?.['type'])
      const issues = validated.success
        ? [`runId mismatch: the handoff declares ${validated.data.runId}`]
        : validated.error.issues.map((issue) => issue.message)
      logger.warn(
        {
          runId,
          path: files.data.handoff,
          issues,
        },
        'Handoff file failed validation; the raw file is kept.',
      )
      openDegradedDecision(runId, files.data.handoff, issues)
      return save({
        type: declaredType.success ? declaredType.data : FALLBACK_TYPE,
        ...(partial === undefined ? {} : { payload: partial }),
        rawPath: files.data.handoff,
        parseStatus: 'degraded',
      })
    },
  }
}
