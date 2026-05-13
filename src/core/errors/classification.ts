/**
 * Structured error classification for provider-agnostic failure handling.
 *
 * Replaces string-matching scattered across model providers and subsystems
 * with a single canonical taxonomy. Every recoverable or abort-worthy error
 * surfaces through `classifyError()` which returns a `ClassifiedError` with
 * a precise `FailoverReason` and prescribed `RecoveryAction`.
 *
 * Categories are drawn from (a) Hermes' 14 failover categories, (b) the 5
 * swarm-design.md §Failure Modes, and (c) the 2 open-question decisions
 * on concurrency + cache.
 */

// ── Enums ──────────────────────────────────────────────────────────

export enum FailoverReason {
  // Hermes-derived
  RATE_LIMIT = 'rate_limit',
  AUTH_FAILED = 'auth_failed',
  CONTEXT_TOO_BIG = 'context_too_big',
  TOOL_CALL_INVALID = 'tool_call_invalid',
  NETWORK_TIMEOUT = 'network_timeout',
  PROVIDER_DOWN = 'provider_down',
  QUOTA_EXHAUSTED = 'quota_exhausted',
  INVALID_RESPONSE = 'invalid_response',
  COMPRESSION_NEEDED = 'compression_needed',
  CREDENTIAL_ROTATE = 'credential_rotate',
  FALLBACK_MODEL = 'fallback_model',
  RETRY_TRANSIENT = 'retry_transient',
  RETRY_WITH_BACKOFF = 'retry_with_backoff',
  ABORT_FATAL = 'abort_fatal',
  // Swarm-design failure modes
  BUDGET_EXCEEDED = 'budget_exceeded',
  DUPLICATE_SPAWN = 'duplicate_spawn',
  CASCADED_CANCELLATION = 'cascaded_cancellation',
  CHILD_TIMEOUT = 'child_timeout',
  PERMISSION_DENIED = 'permission_denied',
  // Swarm open-Q decisions
  CONCURRENCY_LIMIT = 'concurrency_limit',
  CACHE_HIT = 'cache_hit',
  // Catch-all
  UNKNOWN = 'unknown',
}

export enum RecoveryAction {
  RETRY_NOW = 'retry_now',
  RETRY_BACKOFF = 'retry_backoff',
  ROTATE_CREDENTIAL = 'rotate_credential',
  COMPRESS_CONTEXT = 'compress_context',
  FALLBACK_PROVIDER = 'fallback_provider',
  ABORT = 'abort',
  USER_PROMPT = 'user_prompt',
  NONE = 'none',
}

// ── Classified error class ─────────────────────────────────────────

export interface ClassifiedErrorInit {
  reason: FailoverReason;
  recovery: RecoveryAction;
  message?: string;
  retryAfterMs?: number;
  providerHint?: string;
  metadata?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Structured error that carries a classified `FailoverReason` and the
 * prescribed `RecoveryAction`. `cause` preserves the original error for
 * logging / debugging; it is serialized into the message so that legacy
 * string-matchers fall through gracefully.
 */
export class ClassifiedError extends Error {
  readonly reason: FailoverReason;
  readonly recovery: RecoveryAction;
  readonly retryAfterMs?: number;
  readonly providerHint?: string;
  readonly metadata?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(init: ClassifiedErrorInit) {
    super(init.message || init.reason);
    this.name = 'ClassifiedError';
    this.reason = init.reason;
    this.recovery = init.recovery;
    this.retryAfterMs = init.retryAfterMs;
    this.providerHint = init.providerHint;
    this.metadata = init.metadata;
    this.cause = init.cause;
  }

  /** Whether this error should automatically retry */
  get isRetryable(): boolean {
    return (
      this.recovery === RecoveryAction.RETRY_NOW ||
      this.recovery === RecoveryAction.RETRY_BACKOFF ||
      this.recovery === RecoveryAction.FALLBACK_PROVIDER ||
      this.recovery === RecoveryAction.COMPRESS_CONTEXT ||
      this.recovery === RecoveryAction.ROTATE_CREDENTIAL
    );
  }

  /** JSON-safe serialization for logging */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      reason: this.reason,
      recovery: this.recovery,
      message: this.message,
      retryAfterMs: this.retryAfterMs,
      providerHint: this.providerHint,
      metadata: this.metadata,
    };
  }
}

// ── Classification helpers ─────────────────────────────────────────

/** Extract an HTTP-like status code from a raw error if present */
function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp && typeof resp.status === 'number') return resp.status;
  return undefined;
}

/** Extract a numeric retry-after (in ms) from an error */
function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  // OpenAI SDK exposes headers at e.headers or e.response.headers
  const headers =
    (e.headers as Record<string, unknown> | undefined) ||
    ((e.response as Record<string, unknown> | undefined)?.headers as
      | Record<string, unknown>
      | undefined);
  const raw =
    (headers?.['retry-after'] as string | number | undefined) ??
    (headers?.['Retry-After'] as string | number | undefined);
  if (raw == null) return undefined;
  const num = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(num)) return undefined;
  // Retry-After in seconds → ms
  return Math.max(0, num * 1000);
}

/** Extract the message body text from an error */
function extractMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    const nested = e.error as Record<string, unknown> | undefined;
    if (nested && typeof nested.message === 'string') return nested.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Extract error code (e.g. 'rate_limit_exceeded', 'ECONNRESET') */
function extractCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const e = err as Record<string, unknown>;
  if (typeof e.code === 'string') return e.code;
  const nested = e.error as Record<string, unknown> | undefined;
  if (nested && typeof nested.code === 'string') return nested.code;
  return '';
}

// ── Pattern matchers (ordered from most specific to least) ─────────

const PATTERNS: Array<{
  test: (msg: string, code: string, status: number | undefined) => boolean;
  reason: FailoverReason;
  recovery: RecoveryAction;
}> = [
  // Rate limits (429 is the strongest signal)
  {
    test: (_m, _c, s) => s === 429,
    reason: FailoverReason.RATE_LIMIT,
    recovery: RecoveryAction.RETRY_BACKOFF,
  },
  {
    test: (m, c) =>
      c === 'rate_limit_exceeded' ||
      /rate[\s._-]?limit|too[\s_-]?many[\s_-]?requests|tpm.exceeded|rpm.exceeded/i.test(
        m,
      ),
    reason: FailoverReason.RATE_LIMIT,
    recovery: RecoveryAction.RETRY_BACKOFF,
  },

  // Auth failures (401 / 403)
  {
    test: (_m, _c, s) => s === 401 || s === 403,
    reason: FailoverReason.AUTH_FAILED,
    recovery: RecoveryAction.ROTATE_CREDENTIAL,
  },
  {
    test: (m, c) =>
      c === 'invalid_api_key' ||
      c === 'authentication_error' ||
      /unauthorized|invalid.api.key|authentication.failed|invalid.bearer|forbidden|api[\s_-]?key.*(invalid|not.*valid|missing|expired)/i.test(
        m,
      ),
    reason: FailoverReason.AUTH_FAILED,
    recovery: RecoveryAction.ROTATE_CREDENTIAL,
  },

  // Context / token overflow
  {
    test: (m, c) =>
      c === 'context_length_exceeded' ||
      c === 'string_above_max_length' ||
      /context.{0,15}(too|length|window).{0,15}(long|large|exceed)|maximum.context.length|tokens?.{0,10}(exceed|limit|maximum)|input.*too.*(long|large)|prompt.*(too.*long|exceeds)|token.*limit|reduce.*(input|messages)|number.*of.*tokens|this.*model.*maximum.*context/i.test(
        m,
      ),
    reason: FailoverReason.CONTEXT_TOO_BIG,
    recovery: RecoveryAction.COMPRESS_CONTEXT,
  },

  // Quota / billing / credits (402 + text)
  {
    test: (_m, _c, s) => s === 402,
    reason: FailoverReason.QUOTA_EXHAUSTED,
    recovery: RecoveryAction.FALLBACK_PROVIDER,
  },
  {
    test: (m, c) =>
      c === 'insufficient_quota' ||
      c === 'billing_hard_limit_reached' ||
      /quota.*(exhaust|exceed|reached)|resource.?exhausted|credit.*(exhaust|insufficient|depleted)|billing.*limit|limit.reached|capacity.*(exceed|reach)|no.*credits/i.test(
        m,
      ),
    reason: FailoverReason.QUOTA_EXHAUSTED,
    recovery: RecoveryAction.FALLBACK_PROVIDER,
  },

  // Tool-call schema problems
  {
    test: (m, c) =>
      c === 'invalid_function_arguments' ||
      c === 'tool_use_failed' ||
      /(tool|function).call.*(invalid|malformed|schema|failed|failed to parse)|could not parse.*(tool|function)|arguments.*(invalid|malformed)|function.*arguments.*invalid/i.test(
        m,
      ),
    reason: FailoverReason.TOOL_CALL_INVALID,
    recovery: RecoveryAction.RETRY_NOW,
  },

  // Ollama Go-side parser rejections for malformed model output. Smaller
  // models (qwen3.6, etc.) emit unbalanced JSON, mixed XML tags, or
  // interleaved think/tool markers, which surface as a 400 with one of
  // these stable signatures. Treat as recoverable tool-call corruption.
  {
    test: (m) =>
      /Value looks like object|find closing '\}' symbol/.test(m) ||
      /XML syntax error.*element|<parameter>.*<\/function>/.test(m),
    reason: FailoverReason.TOOL_CALL_INVALID,
    recovery: RecoveryAction.RETRY_NOW,
  },

  // Internal timeouts / cancellations — must precede the generic network/timeout
  // rule, whose regex (aborted|timed out) would otherwise shadow these.
  {
    test: (m, c) =>
      c === 'ABORT_ERR' ||
      /abort(ed)?|cancel(l)?ed by user|user.aborted|operation.*(cancel|abort)/i.test(m),
    reason: FailoverReason.CASCADED_CANCELLATION,
    recovery: RecoveryAction.ABORT,
  },
  {
    test: (m) => /child.*(timeout|timed.?out)|subagent.*timeout/i.test(m),
    reason: FailoverReason.CHILD_TIMEOUT,
    recovery: RecoveryAction.RETRY_BACKOFF,
  },

  // Network / timeout
  {
    test: (m, c) =>
      c === 'ECONNRESET' ||
      c === 'ECONNREFUSED' ||
      c === 'ETIMEDOUT' ||
      c === 'ENOTFOUND' ||
      c === 'EAI_AGAIN' ||
      c === 'UND_ERR_SOCKET' ||
      /timeout|timed.?out|network.*error|socket.hang.up|connection.*(reset|refused|closed)|ENOTFOUND|fetch failed/i.test(
        m,
      ),
    reason: FailoverReason.NETWORK_TIMEOUT,
    recovery: RecoveryAction.RETRY_BACKOFF,
  },

  // Provider down / 5xx
  {
    test: (_m, _c, s) =>
      typeof s === 'number' && s >= 500 && s < 600,
    reason: FailoverReason.PROVIDER_DOWN,
    recovery: RecoveryAction.FALLBACK_PROVIDER,
  },
  {
    test: (m) =>
      /service.*(unavailable|down)|upstream.*(error|failure)|bad.gateway|gateway.timeout|overloaded|provider.*unavailable|internal.server.error/i.test(
        m,
      ),
    reason: FailoverReason.PROVIDER_DOWN,
    recovery: RecoveryAction.FALLBACK_PROVIDER,
  },

  // Permission / policy
  {
    test: (m, c) =>
      c === 'permission_denied' ||
      /permission.*(denied|required)|not.*allowed|content.*(policy|filter)|safety.*(block|filter)|responsible.ai/i.test(
        m,
      ),
    reason: FailoverReason.PERMISSION_DENIED,
    recovery: RecoveryAction.USER_PROMPT,
  },

  // Budget exceeded (internal)
  {
    test: (m) =>
      /budget.*(exceed|exhaust)|cost.*(limit|cap).*(exceed|reach)/i.test(m),
    reason: FailoverReason.BUDGET_EXCEEDED,
    recovery: RecoveryAction.ABORT,
  },

  // Duplicate spawn
  {
    test: (m) => /duplicate.*(spawn|agent|job)|already.*(spawned|running)/i.test(m),
    reason: FailoverReason.DUPLICATE_SPAWN,
    recovery: RecoveryAction.NONE,
  },

  // Concurrency limit (semaphore / queue full)
  {
    test: (m) =>
      /concurrenc(y|ent).*(limit|exceed|full)|semaphore.*(full|timeout)|queue.*full|too.many.concurrent/i.test(
        m,
      ),
    reason: FailoverReason.CONCURRENCY_LIMIT,
    recovery: RecoveryAction.RETRY_BACKOFF,
  },

  // Cache hit (informational — caller may short-circuit)
  {
    test: (m) => /^cache[:\s]?hit$|cache.hit/i.test(m),
    reason: FailoverReason.CACHE_HIT,
    recovery: RecoveryAction.NONE,
  },

  // Invalid response shape (empty, missing choices)
  {
    test: (m) =>
      /empty.response|no.choices|returned.*no.*(choices|content)|malformed.response|unexpected.response|invalid.json/i.test(
        m,
      ),
    reason: FailoverReason.INVALID_RESPONSE,
    recovery: RecoveryAction.RETRY_NOW,
  },

  // Generic 4xx not matched above
  {
    test: (_m, _c, s) => typeof s === 'number' && s >= 400 && s < 500,
    reason: FailoverReason.ABORT_FATAL,
    recovery: RecoveryAction.ABORT,
  },
];

/**
 * Classify a raw error (thrown from a provider, transport, or internal
 * subsystem) into a structured `ClassifiedError`.
 *
 * - Strings become the message.
 * - Already-classified errors pass through unchanged (but pick up providerHint).
 * - Providers can pass `providerHint` so downstream consumers know where the
 *   error came from (e.g. 'openai', 'anthropic', 'mcp:github').
 */
export function classifyError(
  err: unknown,
  providerHint?: string,
): ClassifiedError {
  // Idempotent — already classified
  if (err instanceof ClassifiedError) {
    if (providerHint && !err.providerHint) {
      return new ClassifiedError({
        reason: err.reason,
        recovery: err.recovery,
        message: err.message,
        retryAfterMs: err.retryAfterMs,
        providerHint,
        metadata: err.metadata,
        cause: err.cause,
      });
    }
    return err;
  }

  const message = extractMessage(err);
  const code = extractCode(err);
  const status = extractStatus(err);
  const retryAfterMs = extractRetryAfterMs(err);

  for (const { test, reason, recovery } of PATTERNS) {
    if (test(message, code, status)) {
      return new ClassifiedError({
        reason,
        recovery,
        message: message || reason,
        retryAfterMs,
        providerHint,
        metadata: { status, code: code || undefined },
        cause: err,
      });
    }
  }

  return new ClassifiedError({
    reason: FailoverReason.UNKNOWN,
    recovery: RecoveryAction.ABORT,
    message: message || 'Unclassified error',
    retryAfterMs,
    providerHint,
    metadata: { status, code: code || undefined },
    cause: err,
  });
}

/** Convenience: true if the classified error is a rate-limit */
export function isRateLimitError(err: unknown): boolean {
  return classifyError(err).reason === FailoverReason.RATE_LIMIT;
}

/** Convenience: true if the classified error is a transient network issue */
export function isTransientError(err: unknown): boolean {
  const r = classifyError(err).reason;
  return (
    r === FailoverReason.NETWORK_TIMEOUT ||
    r === FailoverReason.RATE_LIMIT ||
    r === FailoverReason.PROVIDER_DOWN ||
    r === FailoverReason.RETRY_TRANSIENT ||
    r === FailoverReason.RETRY_WITH_BACKOFF
  );
}
