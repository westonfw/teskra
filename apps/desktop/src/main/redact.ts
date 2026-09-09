/**
 * Log redaction (TASK-004). API keys, tokens and secret env values must never
 * reach the log files. Two complementary mechanisms:
 *
 * - key-based: any object key that looks like a secret holder
 *   (`GITHUB_TOKEN`, `apiKey`, `password`, ...) has its whole value replaced;
 * - value-based: well-known token shapes (`sk-...`, `ghp_...`, Slack/JWT/AWS)
 *   are masked wherever they appear inside strings, including nested objects,
 *   arrays and log messages.
 */

export const REDACTED = '[redacted]'

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api_?key|credential|private_?key)/i

// Base patterns without the global flag, so they can be reused for stateless
// detection (a /g regex carries lastIndex across .test() calls).
const SECRET_VALUE_SOURCES: string[] = [
  // OpenAI-style API keys
  'sk-[A-Za-z0-9_-]+',
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained PATs
  'gh[pousr]_[A-Za-z0-9]+',
  'github_pat_[A-Za-z0-9_]+',
  // Slack tokens
  'xox[bpoa]-[A-Za-z0-9-]+',
  // AWS access key ids
  'AKIA[A-Z0-9]{16}',
  // JWTs
  'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
]

const SECRET_VALUE_PATTERNS: RegExp[] = SECRET_VALUE_SOURCES.map((s) => new RegExp(s, 'g'))
const SECRET_VALUE_TESTERS: RegExp[] = SECRET_VALUE_SOURCES.map((s) => new RegExp(s))

/** True when a config/log key name marks its value as a secret holder. */
export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key)
}

/** True when a string contains a well-known token shape (`sk-…`, `ghp_…`). */
export function containsSecretValue(value: string): boolean {
  return SECRET_VALUE_TESTERS.some((pattern) => pattern.test(value))
}

function redactString(value: string): string {
  let result = value
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED)
  }
  return result
}

function redactValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return seen.get(value)
    }
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) {
      copy.push(redactValue(item, seen))
    }
    return copy
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      return seen.get(value)
    }
    const redacted: Record<string, unknown> = {}
    seen.set(value, redacted)
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, seen)
    }
    return redacted
  }
  return value
}

/** Returns a redacted copy; non-object inputs (numbers, null, ...) pass through. */
export function redactSecrets(value: unknown): unknown {
  return redactValue(value, new Map())
}
