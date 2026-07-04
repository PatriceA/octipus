import { describe, expect, test } from 'bun:test';
import { ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import { isTransportFailure } from './index';

/**
 * A3: the circuit breaker must open only on TRANSPORT-class failures. A model
 * emitting bad JSON (TOOL_CALL_INVALID) must NOT trip it — otherwise one flaky
 * small model opens the whole provider lane.
 */
describe('isTransportFailure (A3 breaker gate)', () => {
  const classified = (reason: FailoverReason) =>
    new ClassifiedError({ reason, recovery: RecoveryAction.RETRY_NOW, message: 'x', providerHint: 't' });

  test('TOOL_CALL_INVALID does NOT count as transport failure', () => {
    expect(isTransportFailure(classified(FailoverReason.TOOL_CALL_INVALID))).toBe(false);
  });

  test('INVALID_RESPONSE / AUTH_FAILED do NOT count', () => {
    expect(isTransportFailure(classified(FailoverReason.INVALID_RESPONSE))).toBe(false);
    expect(isTransportFailure(classified(FailoverReason.AUTH_FAILED))).toBe(false);
  });

  test('transport-class ClassifiedErrors DO count', () => {
    expect(isTransportFailure(classified(FailoverReason.RATE_LIMIT))).toBe(true);
    expect(isTransportFailure(classified(FailoverReason.NETWORK_TIMEOUT))).toBe(true);
    expect(isTransportFailure(classified(FailoverReason.PROVIDER_DOWN))).toBe(true);
  });

  test('raw 500 / 429 status errors count', () => {
    expect(isTransportFailure({ status: 500, message: 'Internal error' })).toBe(true);
    expect(isTransportFailure({ status: 429, message: 'rate limited' })).toBe(true);
  });

  test('raw 400 / a bare model-output error does not', () => {
    expect(isTransportFailure({ status: 400, message: 'bad request' })).toBe(false);
    expect(isTransportFailure(new Error('malformed tool call'))).toBe(false);
  });

  test('network error codes count', () => {
    expect(isTransportFailure({ code: 'ECONNREFUSED', message: 'refused' })).toBe(true);
    expect(isTransportFailure(new Error('fetch failed'))).toBe(true);
  });
});
