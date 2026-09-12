import { z } from 'zod'

import { IPC_CONTENT_MAX, IPC_NAME_MAX, ipcIdSchema } from './limits'

/**
 * TASK-079 Prompt Template domain — templates are externalized (built-in
 * resources overridable by `<repo>/.teskra/prompts/*.md`), never hardcoded in
 * code. The renderable variable set is fixed; a template referencing a
 * variable that is unknown or was not provided fails validation instead of
 * silently leaving `{{...}}` in the output.
 *
 * `memory` is fed by the ContextBuilder (TASK-068): callers that wire it pass
 * the packed Workspace Memory section; when omitted it renders as an empty
 * string.
 */

/** Names of the templates shipped under apps/desktop/resources/prompts/. */
export const BUILT_IN_PROMPT_TEMPLATES = ['plan', 'implement', 'review', 'fix', 'test'] as const

/** Lowercase slug; also guards against path traversal into the prompts dir. */
export const promptTemplateNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/)
export type PromptTemplateName = z.infer<typeof promptTemplateNameSchema>

export const promptTemplateSourceSchema = z.enum(['builtin', 'repo-local'])
export type PromptTemplateSource = z.infer<typeof promptTemplateSourceSchema>

export const promptTemplateInfoSchema = z.strictObject({
  name: promptTemplateNameSchema,
  source: promptTemplateSourceSchema,
  /** Absolute path of the repo-local file; present for repo-local templates. */
  path: z.string().optional(),
})
export type PromptTemplateInfo = z.infer<typeof promptTemplateInfoSchema>

/** Injectable variables. Omitted optional variables fail rendering when referenced. */
export const promptTemplateContextSchema = z.strictObject({
  task: z.strictObject({
    title: z.string().max(IPC_NAME_MAX),
    description: z.string().max(IPC_CONTENT_MAX),
  }),
  /** Acceptance Criteria (TASK-048 confirmed set), rendered as a bullet list. */
  criteria: z.array(z.string().max(IPC_CONTENT_MAX)).optional(),
  role: z.string().max(IPC_NAME_MAX).optional(),
  /** Workspace Memory section packed by the ContextBuilder (TASK-068); empty when unwired. */
  memory: z.string().max(IPC_CONTENT_MAX).optional(),
  previousHandoff: z.string().max(IPC_CONTENT_MAX).optional(),
  /** ADR-0004 handoff contract paths injected into the agent environment. */
  env: z.strictObject({
    TESKRA_HANDOFF_PATH: z.string().min(1).max(IPC_CONTENT_MAX),
    TESKRA_ARTIFACT_DIR: z.string().min(1).max(IPC_CONTENT_MAX),
  }),
})
export type PromptTemplateContext = z.infer<typeof promptTemplateContextSchema>

export const renderedPromptSchema = z.strictObject({
  name: promptTemplateNameSchema,
  source: promptTemplateSourceSchema,
  path: z.string().optional(),
  content: z.string(),
})
export type RenderedPrompt = z.infer<typeof renderedPromptSchema>

export const listPromptTemplatesRequestSchema = z.strictObject({
  /** When set, repo-local overrides of that workspace's repo are included. */
  workspaceId: ipcIdSchema.optional(),
})
export type ListPromptTemplatesRequest = z.infer<typeof listPromptTemplatesRequestSchema>

export const renderPromptTemplateRequestSchema = z.strictObject({
  name: promptTemplateNameSchema,
  /** When set, `<repo>/.teskra/prompts/<name>.md` overrides the built-in template. */
  workspaceId: ipcIdSchema.optional(),
  context: promptTemplateContextSchema,
})
export type RenderPromptTemplateRequest = z.infer<typeof renderPromptTemplateRequestSchema>
