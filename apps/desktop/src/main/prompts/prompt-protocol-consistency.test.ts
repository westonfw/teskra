import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  AGENT_PROGRESS_KINDS,
  BUILT_IN_PROMPT_TEMPLATES,
  agentProgressKindSchema,
} from '@teskra/contracts'

/**
 * TASK-127 / ADR-0012 §5 — the Agent-facing protocol document
 * (resources/prompts/teskra-agent-protocol.md) is bound to the implementation:
 * any drift between the `TESKRA_*` variables cli-agent-adapter.ts injects and
 * the variables the document mentions, or between the document's progress
 * `kind` list and agentProgressEventSchema, fails this suite.
 */

const ADAPTER_PATH = fileURLToPath(
  new URL('../agents/adapters/cli-agent-adapter.ts', import.meta.url),
)
const PROTOCOL_PATH = fileURLToPath(
  new URL('../../../resources/prompts/teskra-agent-protocol.md', import.meta.url),
)
const PROMPTS_DIR = fileURLToPath(new URL('../../../resources/prompts', import.meta.url))

/**
 * Matches real variable names (TESKRA_RUN_ID) but not the literal `TESKRA_*`
 * wildcard appearing in comments.
 */
const TESKRA_VAR_PATTERN = /TESKRA_[A-Z][A-Z0-9_]*[A-Z0-9]/g

function teskraVariables(source: string): string[] {
  return [...new Set(source.match(TESKRA_VAR_PATTERN) ?? [])].sort()
}

describe('prompt/protocol consistency (TASK-127, ADR-0012 §5)', () => {
  const adapterSource = readFileSync(ADAPTER_PATH, 'utf8')
  const protocolDoc = readFileSync(PROTOCOL_PATH, 'utf8')

  it('the adapter injects exactly the TESKRA_* set the protocol document mentions', () => {
    const injected = teskraVariables(adapterSource)
    // Guard the extractor itself: the adapter must inject the four contract vars.
    expect(injected).toEqual([
      'TESKRA_ARTIFACT_DIR',
      'TESKRA_HANDOFF_PATH',
      'TESKRA_PROGRESS_PATH',
      'TESKRA_RUN_ID',
    ])
    // Bidirectional: no injected variable missing from the doc, no documented
    // variable that is never injected.
    expect(teskraVariables(protocolDoc)).toEqual(injected)
  })

  it('the protocol documents the progress kind enum of agentProgressEventSchema', () => {
    const kindUnion = /"kind"\s*:\s*"([^"]+)"/.exec(protocolDoc)
    expect(kindUnion, 'protocol document carries a machine-checkable kind union').not.toBeNull()
    const documented = kindUnion?.[1]?.split('|').map((kind) => kind.trim()) ?? []
    for (const kind of documented) {
      expect(
        agentProgressKindSchema.safeParse(kind).success,
        `documented kind ${JSON.stringify(kind)} is valid`,
      ).toBe(true)
    }
    expect([...documented].sort()).toEqual([...AGENT_PROGRESS_KINDS].sort())
  })

  it('the protocol states that stdout is never treated as a result', () => {
    expect(protocolDoc).toMatch(/stdout/)
    expect(protocolDoc).toMatch(/never treated as a result/i)
  })

  it('every built-in template inlines {{protocol}} after {{memory}} and before the Handoff section', () => {
    for (const name of BUILT_IN_PROMPT_TEMPLATES) {
      const template = readFileSync(`${PROMPTS_DIR}/${name}.md`, 'utf8')
      const memoryAt = template.indexOf('{{memory}}')
      const protocolAt = template.indexOf('{{protocol}}')
      const handoffAt = template.indexOf('## Handoff')
      expect(memoryAt, `${name}: has {{memory}}`).toBeGreaterThanOrEqual(0)
      expect(protocolAt, `${name}: has {{protocol}}`).toBeGreaterThanOrEqual(0)
      expect(handoffAt, `${name}: has a Handoff section`).toBeGreaterThanOrEqual(0)
      expect(protocolAt, `${name}: {{protocol}} sits after {{memory}}`).toBeGreaterThan(memoryAt)
      expect(protocolAt, `${name}: {{protocol}} sits before the Handoff section`).toBeLessThan(
        handoffAt,
      )
      expect(template, `${name}: references the progress file`).toContain(
        '{{env.TESKRA_PROGRESS_PATH}}',
      )
    }
  })
})
