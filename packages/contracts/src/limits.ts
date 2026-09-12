import { z } from 'zod'

/**
 * IPC request payload bounds (code-review P2-20).
 *
 * These schemas exist for the *RequestSchema inputs the Renderer sends over
 * Typed IPC: without an upper bound a UI bug (e.g. `cols: 1e9`) travels
 * straight into `pty.resize`, and unbounded strings cross the bridge for no
 * reason. They are applied to request schemas ONLY — storage/output schemas
 * that parse DB rows or on-disk files stay unbounded so existing persisted
 * data keeps validating.
 */

/** Opaque ids (workspaceId, runId, taskId, agentType, ...). */
export const IPC_ID_MAX = 256

/** Short human/agent-facing strings: names, titles, branches, patterns, commands. */
export const IPC_NAME_MAX = 1024

/** Filesystem paths (Windows MAX_PATH is 260, but WSL/UNC paths run longer). */
export const IPC_PATH_MAX = 4096

/** Long free-form text: prompts, descriptions, commit messages, env values. */
export const IPC_TEXT_MAX = 64 * 1024

/** Bulk payloads: terminal input, memory/artifact content, credential values. */
export const IPC_CONTENT_MAX = 1024 * 1024

/** Terminal grid dimensions — feeds directly into pty.resize. */
export const TERMINAL_DIMENSION_MAX = 1000

/** Required bounded id string. */
export const ipcIdSchema = z.string().min(1).max(IPC_ID_MAX)

/** Required bounded name/title/pattern string. */
export const ipcNameSchema = z.string().min(1).max(IPC_NAME_MAX)

/** Required bounded path string. */
export const ipcPathSchema = z.string().min(1).max(IPC_PATH_MAX)

/** Bounded free-form text (may be empty). */
export const ipcTextSchema = z.string().max(IPC_TEXT_MAX)

/** Bounded bulk payload (may be empty). */
export const ipcContentSchema = z.string().max(IPC_CONTENT_MAX)

/** Bounded terminal grid dimension (cols / rows). */
export const terminalDimensionSchema = z.number().int().min(1).max(TERMINAL_DIMENSION_MAX)
