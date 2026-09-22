import type { IpcResult, PublicAppError } from '@teskra/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

import { transportError } from '../i18n'
import {
  applyFeedPage,
  applyLiveRecord,
  initialRunFeedState,
  nextAfterSeq,
  RUN_FEED_PAGE_SIZE,
  type RunFeedState,
} from './run-activity-view-model'

export type RunFeedStatus = 'loading' | 'ready' | 'error'

export interface RunFeed<T> {
  readonly status: RunFeedStatus
  readonly records: readonly T[]
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly error?: PublicAppError | undefined
  loadMore(): void
}

/** One paged + live event source (`list-*` IPC plus its `agent.*` broadcast). */
export interface RunFeedSource<TRecord extends { readonly seq: number }> {
  fetchPage(runId: string, afterSeq?: number): Promise<IpcResult<readonly TRecord[]>>
  subscribeLive(runId: string, handler: (record: TRecord) => void): () => void
}

/**
 * TASK-125 (§14): the shared feed behind the Activity and Progress tabs.
 * The subscription is opened BEFORE the first page is fetched so no broadcast
 * is missed in between; overlaps are deduped by seq (mergeFeedRecords). Older
 * windows are paged forward with the `afterSeq` cursor — the feed never
 * re-pulls the whole list.
 */
export function useRunFeed<TRecord extends { readonly seq: number }>(
  runId: string,
  source: RunFeedSource<TRecord>,
): RunFeed<TRecord> {
  const [state, setState] = useState<RunFeedState<TRecord>>(initialRunFeedState)
  const [status, setStatus] = useState<RunFeedStatus>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<PublicAppError>()
  const sourceRef = useRef(source)
  sourceRef.current = source
  // Mirror for loadMore, which must read the newest records outside setState.
  const recordsRef = useRef<readonly TRecord[]>(state.records)
  recordsRef.current = state.records
  const loadingMoreRef = useRef(false)

  useEffect(() => {
    let active = true
    setState(initialRunFeedState())
    setStatus('loading')
    setError(undefined)
    const stop = sourceRef.current.subscribeLive(runId, (record) => {
      if (active) setState((current) => applyLiveRecord(current, record))
    })
    sourceRef.current
      .fetchPage(runId)
      .then((result) => {
        if (!active) return
        if (result.ok) {
          setState((current) => applyFeedPage(current, result.data, RUN_FEED_PAGE_SIZE))
          setStatus('ready')
        } else {
          setStatus('error')
          setError(result.error)
        }
      })
      .catch(() => {
        if (!active) return
        setStatus('error')
        setError(transportError())
      })
    return () => {
      active = false
      stop()
    }
  }, [runId])

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    sourceRef.current
      .fetchPage(runId, nextAfterSeq(recordsRef.current))
      .then((result) => {
        if (result.ok) {
          setState((current) => applyFeedPage(current, result.data, RUN_FEED_PAGE_SIZE))
          setError(undefined)
        } else {
          setError(result.error)
        }
      })
      .catch(() => setError(transportError()))
      .finally(() => {
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [runId])

  return { status, records: state.records, hasMore: state.hasMore, loadingMore, error, loadMore }
}
