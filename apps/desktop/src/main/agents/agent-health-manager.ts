import type {
  AgentDetectionRequest,
  AgentHealth,
  IpcResult,
  ListAgentDetectionsRequest,
} from '@teskra/contracts'

import { toPublicError } from '../errors'
import type { AgentDetector } from './agent-detector'
import type { AgentRegistry } from './agent-registry'

export interface AgentHealthManager {
  check(request: AgentDetectionRequest): Promise<IpcResult<AgentHealth>>
  list(request: ListAgentDetectionsRequest): Promise<IpcResult<readonly AgentHealth[]>>
}

export interface AgentHealthManagerDeps {
  readonly registry: Pick<AgentRegistry, 'get' | 'list'>
  readonly detector: Pick<AgentDetector, 'detect'>
  readonly now?: () => number
}

export function createAgentHealthManager(deps: AgentHealthManagerDeps): AgentHealthManager {
  const now = deps.now ?? Date.now

  const unavailable = (
    request: AgentDetectionRequest,
    message: string,
  ): IpcResult<AgentHealth> => ({
    ok: true,
    data: {
      agentId: request.agentId,
      runtime: request.runtime,
      installed: false,
      available: false,
      error: message,
      checkedAt: new Date(now()).toISOString(),
    },
  })

  const manager: AgentHealthManager = {
    async check(request) {
      if (deps.registry.get(request.agentId) === undefined) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: `Unknown Agent "${request.agentId}".`,
            retryable: false,
            detail: `Agent Registry does not contain id=${request.agentId}`,
          }),
        }
      }

      try {
        const detected = await deps.detector.detect(request)
        if (!detected.ok) return unavailable(request, detected.error.message)
        return {
          ok: true,
          data: {
            agentId: detected.data.agentId,
            runtime: detected.data.runtime,
            installed: detected.data.installed,
            available: detected.data.installed && detected.data.error === undefined,
            ...(detected.data.executable !== undefined
              ? { executable: detected.data.executable }
              : {}),
            ...(detected.data.version !== undefined ? { version: detected.data.version } : {}),
            ...(detected.data.error !== undefined ? { error: detected.data.error } : {}),
            checkedAt: detected.data.checkedAt,
          },
        }
      } catch {
        return unavailable(request, 'The Agent health check failed unexpectedly.')
      }
    },

    async list(request) {
      const health = await Promise.all(
        deps.registry.list().map((agent) =>
          manager
            .check({
              agentId: agent.id,
              runtime: request.runtime,
              refresh: request.refresh,
            })
            .then((result) => ({ agentId: agent.id, result })),
        ),
      )
      return {
        ok: true,
        data: health.flatMap(({ agentId, result }) =>
          result.ok
            ? [result.data]
            : [
                {
                  agentId,
                  runtime: request.runtime,
                  installed: false,
                  available: false,
                  error: result.error.message,
                  checkedAt: new Date(now()).toISOString(),
                },
              ],
        ),
      }
    },
  }

  return manager
}
