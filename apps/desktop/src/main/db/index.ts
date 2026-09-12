import Database from 'better-sqlite3'

import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import type { TeskraPaths } from '../paths'

/**
 * SQLite integration (TASK-005).
 *
 * The database file lives at `<home>/db/teskra.sqlite`, resolved exclusively
 * through the TASK-078 paths module (ADR-0003) — never `app.getPath("userData")`.
 *
 * Lifecycle: `openDatabase()` at app startup, `close()` on `before-quit`.
 * Every failure is returned as a structured `IpcResult` error (TASK-003 model);
 * nothing here throws across the module boundary, so a broken database can
 * never crash the Renderer.
 *
 * better-sqlite3 is a native module. Since v12 it ships Node-API (ABI-stable)
 * prebuilds, but the `postinstall` still runs `electron-rebuild` so that
 * non-Node-API native modules added later (node-pty, TASK-013) are rebuilt
 * against the Electron ABI by the same mechanism.
 */
export interface TeskraDatabase {
  /** Absolute database file path, or ":memory:" for tests. */
  readonly filePath: string
  /** Raw better-sqlite3 handle — consumed by the Repository layer (TASK-090). */
  readonly connection: Database.Database
  /** Idempotent; safe to call more than once. */
  close(): IpcResult<void>
}

function dbError(message: string, detail: string, cause?: unknown): InternalAppError {
  return { code: 'UNKNOWN', message, retryable: false, detail, cause }
}

/**
 * Applies the mandatory PRAGMA set (TASK-005):
 * - foreign_keys=ON  — better-sqlite3 defaults to OFF
 * - journal_mode=WAL — high-frequency agent event writes must not block UI reads
 * - busy_timeout=5000
 */
function applyPragmas(connection: Database.Database): void {
  connection.pragma('foreign_keys = ON')
  connection.pragma('journal_mode = WAL')
  connection.pragma('busy_timeout = 5000')
}

/** Opens (creating if needed) a database file with the TASK-005 PRAGMA set. */
export function openDatabaseFile(filePath: string): IpcResult<TeskraDatabase> {
  let connection: Database.Database
  try {
    connection = new Database(filePath)
    applyPragmas(connection)
  } catch (cause) {
    return {
      ok: false,
      error: toPublicError(
        dbError('Failed to open the Teskra database.', `open ${filePath}`, cause),
      ),
    }
  }

  let closed = false
  return {
    ok: true,
    data: {
      filePath,
      connection,
      close() {
        if (closed) {
          return { ok: true, data: undefined }
        }
        closed = true
        try {
          connection.close()
          return { ok: true, data: undefined }
        } catch (cause) {
          return {
            ok: false,
            error: toPublicError(
              dbError('Failed to close the Teskra database.', `close ${filePath}`, cause),
            ),
          }
        }
      },
    },
  }
}

/** Opens the application database at `<home>/db/teskra.sqlite`. */
export function openDatabase(paths: TeskraPaths): IpcResult<TeskraDatabase> {
  const dbPath = paths.db()
  if (!dbPath.ok) {
    return dbPath
  }
  return openDatabaseFile(dbPath.data)
}
