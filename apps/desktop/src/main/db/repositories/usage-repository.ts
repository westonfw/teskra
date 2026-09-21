import type Database from 'better-sqlite3'

import type { AgentRunUsage, IpcResult, UsageSource, UsageSummaryBucket } from '@teskra/contracts'
import { agentRunUsageSchema, usageSummaryBucketSchema } from '@teskra/contracts'

import { execute, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * UsageRepository (TASK-124, teskra-tasks.md; Milestone 25 design doc §7; DDL:
 * plan §139.1 migration 018) — the `agent_run_usage` table, one row per Run.
 *
 * `upsertAdd` is the accumulation point for the structured stream's `usage`
 * observations (ADR-0013): Claude reports once with its `result`, Codex on
 * every `turn.completed` — both ADD into the same row, and each observation
 * counts one turn. `cost_usd_micros` accumulates only provider-reported cost
 * (NULL stays NULL until the provider reports; Teskra never estimates).
 *
 * Aggregation joins `agent_runs` for the workspace / agentType /
 * accountProfileId dimensions — they are never duplicated onto this table.
 * Usage is display-only and never feeds rate-limit decisions (ADR-0010).
 */

interface AgentRunUsageRow {
  run_id: string
  source: string
  model: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd_micros: number | null
  turns: number
  updated_at: string
}

interface UsageSummaryRow {
  workspace_id: string
  agent_type: string
  account_profile_id: string | null
  runs: number
  turns: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd_micros: number | null
}

export interface AddUsageInput {
  readonly runId: string
  readonly source: UsageSource
  readonly model?: string | undefined
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Provider-reported cost only; undefined leaves the stored value untouched. */
  readonly costUsdMicros?: number | undefined
}

export interface UsageSummaryFilter {
  readonly workspaceId?: string | undefined
  readonly accountProfileId?: string | undefined
  readonly agentType?: string | undefined
  /** ISO-8601 UTC lower bound on updated_at (required — summaries are always windowed). */
  readonly since: string
}

export interface UsageRepository {
  /**
   * Adds one usage observation into the run's single row (INSERT on first,
   * additive UPSERT after). Negative token deltas trip the table CHECK and
   * come back as a structured error — never clamped.
   */
  upsertAdd(input: AddUsageInput, now?: string): IpcResult<AgentRunUsage>
  /** The run's accumulated row; null until the first usage observation. */
  getByRun(runId: string): IpcResult<AgentRunUsage | null>
  /**
   * Buckets grouped by (workspace, agentType, accountProfileId) — the
   * dimensions come from the `agent_runs` join. `costUsdMicros` is the SUM
   * over reporting runs only and stays absent when none reported.
   */
  summarize(filter: UsageSummaryFilter): IpcResult<UsageSummaryBucket[]>
}

const ENTITY = 'agent-run-usage'

function toDomain(row: AgentRunUsageRow): IpcResult<AgentRunUsage> {
  return validateRow(agentRunUsageSchema, ENTITY, {
    runId: row.run_id,
    source: row.source,
    model: row.model ?? undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costUsdMicros: row.cost_usd_micros ?? undefined,
    turns: row.turns,
    updatedAt: row.updated_at,
  })
}

function toBucket(row: UsageSummaryRow): IpcResult<UsageSummaryBucket> {
  return validateRow(usageSummaryBucketSchema, ENTITY, {
    workspaceId: row.workspace_id,
    agentType: row.agent_type,
    accountProfileId: row.account_profile_id ?? undefined,
    runs: row.runs,
    turns: row.turns,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costUsdMicros: row.cost_usd_micros ?? undefined,
  })
}

export function createUsageRepository(connection: Database.Database): UsageRepository {
  // NULL-safe additive upsert: an absent provider cost never overwrites an
  // accumulated one, and vice versa a first report lands on a NULL base.
  const upsertStatement = connection.prepare(
    `INSERT INTO agent_run_usage
       (run_id, source, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros, turns, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       model              = COALESCE(excluded.model, agent_run_usage.model),
       input_tokens       = agent_run_usage.input_tokens + excluded.input_tokens,
       output_tokens      = agent_run_usage.output_tokens + excluded.output_tokens,
       cache_read_tokens  = agent_run_usage.cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = agent_run_usage.cache_write_tokens + excluded.cache_write_tokens,
       cost_usd_micros    = CASE
                              WHEN excluded.cost_usd_micros IS NULL THEN agent_run_usage.cost_usd_micros
                              WHEN agent_run_usage.cost_usd_micros IS NULL THEN excluded.cost_usd_micros
                              ELSE agent_run_usage.cost_usd_micros + excluded.cost_usd_micros
                            END,
       turns              = agent_run_usage.turns + 1,
       updated_at         = excluded.updated_at`,
  )
  const selectByRunStatement = connection.prepare('SELECT * FROM agent_run_usage WHERE run_id = ?')

  const repository: UsageRepository = {
    upsertAdd(input, now = nowIso()) {
      const written = execute(ENTITY, 'upsertAdd', () => {
        upsertStatement.run(
          input.runId,
          input.source,
          input.model ?? null,
          input.inputTokens,
          input.outputTokens,
          input.cacheReadTokens,
          input.cacheWriteTokens,
          input.costUsdMicros ?? null,
          now,
        )
      })
      if (!written.ok) {
        return written
      }
      return requireFound(ENTITY, repository.getByRun(input.runId))
    },

    getByRun(runId) {
      const row = execute(ENTITY, 'read', () => {
        return selectByRunStatement.get(runId) as AgentRunUsageRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return toDomain(row.data)
    },

    summarize(filter) {
      const conditions: string[] = ['u.updated_at >= ?']
      const values: unknown[] = [filter.since]
      if (filter.workspaceId !== undefined) {
        conditions.push('r.workspace_id = ?')
        values.push(filter.workspaceId)
      }
      if (filter.accountProfileId !== undefined) {
        conditions.push('r.account_profile_id = ?')
        values.push(filter.accountProfileId)
      }
      if (filter.agentType !== undefined) {
        conditions.push('r.agent_type = ?')
        values.push(filter.agentType)
      }
      // SUM over INTEGER NOT NULL columns never yields NULL (a bucket has ≥ 1
      // row); cost stays NULL when no run in the bucket reported one.
      const rows = execute(ENTITY, 'summarize', () => {
        return connection
          .prepare(
            `SELECT r.workspace_id AS workspace_id,
                    r.agent_type AS agent_type,
                    r.account_profile_id AS account_profile_id,
                    COUNT(*) AS runs,
                    SUM(u.turns) AS turns,
                    SUM(u.input_tokens) AS input_tokens,
                    SUM(u.output_tokens) AS output_tokens,
                    SUM(u.cache_read_tokens) AS cache_read_tokens,
                    SUM(u.cache_write_tokens) AS cache_write_tokens,
                    SUM(u.cost_usd_micros) AS cost_usd_micros
             FROM agent_run_usage u
             JOIN agent_runs r ON r.id = u.run_id
             WHERE ${conditions.join(' AND ')}
             GROUP BY r.workspace_id, r.agent_type, r.account_profile_id
             ORDER BY r.workspace_id ASC, r.agent_type ASC, r.account_profile_id ASC`,
          )
          .all(...values) as UsageSummaryRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toBucket)
    },
  }

  return repository
}
