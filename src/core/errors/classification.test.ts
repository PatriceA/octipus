import { describe, test, expect } from 'bun:test';
import {
  classifyError,
  ClassifiedError,
  FailoverReason,
  RecoveryAction,
  isRateLimitError,
  isTransientError,
} from './classification';

describe('classifyError — rate limit variants', () => {
  test('classifies HTTP 429 status as RATE_LIMIT', () => {
    const err = classifyError({ status: 429, message: 'Too many requests' });
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
    expect(err.recovery).toBe(RecoveryAction.RETRY_BACKOFF);
  });

  test('classifies OpenAI-style rate_limit_exceeded code', () => {
    const err = classifyError({ code: 'rate_limit_exceeded', message: 'Quota exceeded' });
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
  });

  test('classifies Anthropic-style rate limit text', () => {
    const err = classifyError(new Error('This request would exceed your rate limit'));
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
  });

  test('classifies "too many requests" message', () => {
    const err = classifyError('429: Too Many Requests');
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
  });

  test('extracts retry-after header from OpenAI SDK shape', () => {
    const err = classifyError({
      status: 429,
      message: 'rate limited',
      headers: { 'retry-after': '12' },
    });
    expect(err.retryAfterMs).toBe(12000);
  });
});

describe('classifyError — auth variants', () => {
  test('classifies HTTP 401 as AUTH_FAILED', () => {
    const err = classifyError({ status: 401, message: 'Unauthorized' });
    expect(err.reason).toBe(FailoverReason.AUTH_FAILED);
    expect(err.recovery).toBe(RecoveryAction.ROTATE_CREDENTIAL);
  });

  test('classifies HTTP 403 as AUTH_FAILED', () => {
    const err = classifyError({ status: 403, message: 'Forbidden' });
    expect(err.reason).toBe(FailoverReason.AUTH_FAILED);
  });

  test('classifies invalid_api_key code', () => {
    const err = classifyError({ code: 'invalid_api_key', message: 'bad key' });
    expect(err.reason).toBe(FailoverReason.AUTH_FAILED);
  });

  test('classifies "API key is invalid" text', () => {
    const err = classifyError(new Error('API key is not valid'));
    expect(err.reason).toBe(FailoverReason.AUTH_FAILED);
  });
});

describe('classifyError — context overflow variants', () => {
  test('OpenAI context_length_exceeded code', () => {
    const err = classifyError({ code: 'context_length_exceeded', message: 'ctx too big' });
    expect(err.reason).toBe(FailoverReason.CONTEXT_TOO_BIG);
    expect(err.recovery).toBe(RecoveryAction.COMPRESS_CONTEXT);
  });

  test('Anthropic "maximum context length" message', () => {
    const err = classifyError(
      new Error("This model's maximum context length is 200000 tokens"),
    );
    expect(err.reason).toBe(FailoverReason.CONTEXT_TOO_BIG);
  });

  test('Gemini "input too long" variant', () => {
    const err = classifyError(new Error('Input is too long for this model'));
    expect(err.reason).toBe(FailoverReason.CONTEXT_TOO_BIG);
  });

  test('DeepSeek/OpenAI "prompt too long" variant', () => {
    const err = classifyError(new Error('Prompt is too long, exceeds limit'));
    expect(err.reason).toBe(FailoverReason.CONTEXT_TOO_BIG);
  });

  test('generic "number of tokens exceeds" variant', () => {
    const err = classifyError(new Error('The number of tokens exceeds the maximum allowed'));
    expect(err.reason).toBe(FailoverReason.CONTEXT_TOO_BIG);
  });
});

describe('classifyError — network / timeout', () => {
  test('ECONNRESET code', () => {
    const err = classifyError({ code: 'ECONNRESET', message: 'socket reset' });
    expect(err.reason).toBe(FailoverReason.NETWORK_TIMEOUT);
  });

  test('ETIMEDOUT code', () => {
    const err = classifyError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });
    expect(err.reason).toBe(FailoverReason.NETWORK_TIMEOUT);
  });

  test('fetch failed text', () => {
    const err = classifyError(new Error('fetch failed'));
    expect(err.reason).toBe(FailoverReason.NETWORK_TIMEOUT);
  });

  test('DOMException abort is CASCADED_CANCELLATION', () => {
    const err = classifyError(new Error('The operation was aborted'));
    expect(err.reason).toBe(FailoverReason.CASCADED_CANCELLATION);
    expect(err.recovery).toBe(RecoveryAction.ABORT);
  });
});

describe('classifyError — quota / billing', () => {
  test('HTTP 402 is QUOTA_EXHAUSTED', () => {
    const err = classifyError({ status: 402, message: 'Payment Required' });
    expect(err.reason).toBe(FailoverReason.QUOTA_EXHAUSTED);
    expect(err.recovery).toBe(RecoveryAction.FALLBACK_PROVIDER);
  });

  test('insufficient_quota code', () => {
    const err = classifyError({ code: 'insufficient_quota', message: 'no credits' });
    expect(err.reason).toBe(FailoverReason.QUOTA_EXHAUSTED);
  });

  test('OpenRouter credit exhausted text', () => {
    const err = classifyError(new Error('OpenRouter credit exhausted. Add credits at ...'));
    expect(err.reason).toBe(FailoverReason.QUOTA_EXHAUSTED);
  });

  test('Gemini resource_exhausted variant', () => {
    const err = classifyError(new Error('Resource exhausted: quota'));
    expect(err.reason).toBe(FailoverReason.QUOTA_EXHAUSTED);
  });
});

describe('classifyError — provider down / 5xx', () => {
  test('HTTP 500 is PROVIDER_DOWN', () => {
    const err = classifyError({ status: 500, message: 'Internal Server Error' });
    expect(err.reason).toBe(FailoverReason.PROVIDER_DOWN);
    expect(err.recovery).toBe(RecoveryAction.FALLBACK_PROVIDER);
  });

  test('HTTP 503 is PROVIDER_DOWN', () => {
    const err = classifyError({ status: 503, message: 'Service unavailable' });
    expect(err.reason).toBe(FailoverReason.PROVIDER_DOWN);
  });

  test('"overloaded" text is PROVIDER_DOWN', () => {
    const err = classifyError(new Error('Anthropic API is overloaded, try later'));
    expect(err.reason).toBe(FailoverReason.PROVIDER_DOWN);
  });
});

describe('classifyError — tool calls', () => {
  test('invalid_function_arguments code', () => {
    const err = classifyError({
      code: 'invalid_function_arguments',
      message: 'bad args',
    });
    expect(err.reason).toBe(FailoverReason.TOOL_CALL_INVALID);
  });

  test('"could not parse tool call" text', () => {
    const err = classifyError(new Error('Could not parse tool call arguments'));
    expect(err.reason).toBe(FailoverReason.TOOL_CALL_INVALID);
  });

  test('Ollama 400 "Value looks like object" body is TOOL_CALL_INVALID + RETRY_NOW', () => {
    // This is the raw body Ollama's Go parser returns when a smaller model
    // (e.g. qwen3.6) emits unbalanced JSON. Must not fall through to the
    // generic 4xx → ABORT_FATAL rule.
    const err = classifyError({
      status: 400,
      message: `{"error":"Value looks like object, but can't find closing '}' symbol"}`,
    }, 'ollama');
    expect(err.reason).toBe(FailoverReason.TOOL_CALL_INVALID);
    expect(err.recovery).toBe(RecoveryAction.RETRY_NOW);
  });

  test('Ollama XML-syntax tool-call rejection is TOOL_CALL_INVALID + RETRY_NOW', () => {
    const err = classifyError({
      status: 400,
      message: 'XML syntax error on line 3: unexpected element <parameter>',
    }, 'ollama');
    expect(err.reason).toBe(FailoverReason.TOOL_CALL_INVALID);
    expect(err.recovery).toBe(RecoveryAction.RETRY_NOW);
  });
});

describe('classifyError — invalid / empty response', () => {
  test('empty response with no choices', () => {
    const err = classifyError(new Error('Provider returned empty response (no choices)'));
    expect(err.reason).toBe(FailoverReason.INVALID_RESPONSE);
    expect(err.recovery).toBe(RecoveryAction.RETRY_NOW);
  });
});

describe('classifyError — swarm failure modes', () => {
  test('budget exceeded', () => {
    const err = classifyError(new Error('Budget exceeded for this session'));
    expect(err.reason).toBe(FailoverReason.BUDGET_EXCEEDED);
    expect(err.recovery).toBe(RecoveryAction.ABORT);
  });

  test('duplicate spawn', () => {
    const err = classifyError(new Error('Duplicate spawn for agent agent-123'));
    expect(err.reason).toBe(FailoverReason.DUPLICATE_SPAWN);
  });

  test('child timeout', () => {
    const err = classifyError(new Error('Child agent timed out'));
    expect(err.reason).toBe(FailoverReason.CHILD_TIMEOUT);
  });

  test('permission denied', () => {
    const err = classifyError(new Error('Permission denied: cannot write to /etc'));
    expect(err.reason).toBe(FailoverReason.PERMISSION_DENIED);
    expect(err.recovery).toBe(RecoveryAction.USER_PROMPT);
  });

  test('concurrency limit', () => {
    const err = classifyError(new Error('Concurrency limit exceeded, queue full'));
    expect(err.reason).toBe(FailoverReason.CONCURRENCY_LIMIT);
  });

  test('cache hit (informational)', () => {
    const err = classifyError(new Error('cache hit'));
    expect(err.reason).toBe(FailoverReason.CACHE_HIT);
    expect(err.recovery).toBe(RecoveryAction.NONE);
  });
});

describe('classifyError — fallback', () => {
  test('unrecognized error falls through to UNKNOWN + ABORT', () => {
    const err = classifyError(new Error('Weird totally-unknown failure'));
    expect(err.reason).toBe(FailoverReason.UNKNOWN);
    expect(err.recovery).toBe(RecoveryAction.ABORT);
  });

  test('null / undefined → UNKNOWN', () => {
    const err = classifyError(null);
    expect(err.reason).toBe(FailoverReason.UNKNOWN);
  });

  test('string input → classified via message', () => {
    const err = classifyError('Rate limit hit, please retry');
    expect(err.reason).toBe(FailoverReason.RATE_LIMIT);
  });
});

describe('ClassifiedError — behavior', () => {
  test('is idempotent: classifyError(ClassifiedError) returns same instance', () => {
    const original = new ClassifiedError({
      reason: FailoverReason.RATE_LIMIT,
      recovery: RecoveryAction.RETRY_BACKOFF,
      message: 'hit limit',
      providerHint: 'openai',
    });
    expect(classifyError(original)).toBe(original);
  });

  test('classifyError adds providerHint to pre-classified error if missing', () => {
    const original = new ClassifiedError({
      reason: FailoverReason.RATE_LIMIT,
      recovery: RecoveryAction.RETRY_BACKOFF,
      message: 'hit limit',
    });
    const out = classifyError(original, 'anthropic');
    expect(out.providerHint).toBe('anthropic');
    expect(out.reason).toBe(FailoverReason.RATE_LIMIT);
  });

  test('providerHint is preserved from classifyError call', () => {
    const err = classifyError({ status: 429, message: 'rate limited' }, 'openai');
    expect(err.providerHint).toBe('openai');
  });

  test('isRetryable is true for retry / fallback recoveries', () => {
    const err = classifyError({ status: 429, message: 'rl' });
    expect(err.isRetryable).toBe(true);
  });

  test('isRetryable is false for ABORT', () => {
    const err = classifyError(new Error('Budget exceeded'));
    expect(err.isRetryable).toBe(false);
  });

  test('toJSON returns structured object with no cause', () => {
    const err = classifyError({ status: 429, message: 'x' }, 'openai');
    const json = err.toJSON();
    expect(json.reason).toBe(FailoverReason.RATE_LIMIT);
    expect(json.providerHint).toBe('openai');
    expect(json).not.toHaveProperty('cause');
  });
});

describe('helper predicates', () => {
  test('isRateLimitError matches 429', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ status: 500 })).toBe(false);
  });

  test('isTransientError covers 5xx and timeouts', () => {
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ code: 'ETIMEDOUT', message: 'x' })).toBe(true);
    expect(isTransientError({ status: 401 })).toBe(false);
  });
});
