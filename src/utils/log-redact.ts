/**
 * Deep redaction for structured log fields.
 *
 * Wired into pino via `formatters.log` (see logger.ts) so it runs ONCE before
 * serialization and therefore protects every stream — stdout AND the in-memory
 * ring buffer that backs the admin log dashboard (`/api/logs/*`).
 *
 * We redact by key name (recursively) rather than by static path because tool
 * arguments, provider payloads, and request bodies nest credentials under
 * unpredictable keys. Errors / Buffers / other non-plain objects are passed
 * through untouched so pino's own serializers still see the real value.
 */

const SENSITIVE_KEY = new RegExp(
  [
    'pass(word|phrase)?',
    'secret',
    'token', // sessionToken, refreshToken, accessToken, …
    'api[-_]?key',
    'apikey',
    'authorization',
    'cookie',
    'credential',
    'private[-_]?key',
    'mnemonic',
    'bearer',
    'client[-_]?secret',
  ].join('|'),
  'i',
);

// Keys that contain "token"-like substrings but are NOT secrets — don't redact
// these or the dashboard loses useful correlation fields.
const ALLOW_KEY = /^(tokenCount|tokensUsed|promptTokens|completionTokens|totalTokens|maxTokens|requestId|csrfToken)$/i;

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;
const MAX_STRING = 8_192; // guard the buffer against megabyte payloads

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]` : value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((v) => redact(v, depth + 1, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (!ALLOW_KEY.test(key) && SENSITIVE_KEY.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val, depth + 1, seen);
      }
    }
    return out;
  }

  // Errors, Buffers, Dates, class instances, primitives → pass through so
  // pino's standard serializers handle them.
  return value;
}

/**
 * Redact a pino log object (the merged structured fields, excluding
 * level/time/msg which pino adds separately). Returns a new object; the input
 * is not mutated.
 */
export function redactLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  return redact(obj, 0, new WeakSet()) as Record<string, unknown>;
}
