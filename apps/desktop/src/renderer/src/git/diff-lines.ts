export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

/**
 * Classifies one line of a unified-diff patch for tinted rendering.
 * `+++ b/file` / `--- a/file` are file headers (meta), not add/del content;
 * everything else follows the first character.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to') ||
    line.startsWith('Binary files') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('\\')
  ) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

export interface DiffDisplayLine {
  readonly text: string
  readonly kind: DiffLineKind
}

export function splitDiffLines(patch: string): readonly DiffDisplayLine[] {
  // The patch always ends with a trailing newline; split produces a final
  // empty segment that must not become a phantom context line.
  const lines = patch.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((text) => ({ text, kind: classifyDiffLine(text) }))
}
