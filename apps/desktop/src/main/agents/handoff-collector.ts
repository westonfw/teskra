import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  handoffTypeSchema,
  workerHandoffSchema,
  type HandoffType,
  type IpcResult,
} from '@teskra/contracts'

import type { JsonRecord } from '../db/repositories/common'
import type {
  Handoff,
  HandoffRepository,
  SaveHandoffInput,
} from '../db/repositories/handoff-repository'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'

const FALLBACK_SUMMARY_MAX_CHARS = 2_000

/** Fallback rows have no Agent-declared type; 'analysis' is the neutral bucket. */
const FALLBACK_TYPE: HandoffType = 'analysis'

export interface HandoffCollectorDeps {
  readonly handoffs: HandoffRepository
  readonly paths: TeskraPaths
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
      logger.warn(
        {
          runId,
          path: files.data.handoff,
          issues: validated.success
            ? `runId mismatch: ${validated.data.runId}`
            : validated.error.issues,
        },
        'Handoff file failed validation; the raw file is kept.',
      )
      return save({
        type: declaredType.success ? declaredType.data : FALLBACK_TYPE,
        ...(partial === undefined ? {} : { payload: partial }),
        rawPath: files.data.handoff,
        parseStatus: 'degraded',
      })
    },
  }
}
