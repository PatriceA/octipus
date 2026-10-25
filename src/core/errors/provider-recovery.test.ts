import { expect, test } from 'vitest';
import { classifyError, FailoverReason } from './classification';
import { isProviderQuotaMessage, providerResetAt, providerRetryDelay } from './provider-recovery';

test('subscription limit records its actual multi-day reset (#38)', () => {
  const message = "You've hit your usage limit. Try again at Oct 27th, 2026 9:20 AM";
  expect(isProviderQuotaMessage(message)).toBe(true);
  expect(classifyError(new Error(message)).reason).toBe(FailoverReason.QUOTA_EXHAUSTED);
  expect(providerResetAt(message)?.getUTCFullYear()).toBe(2026);
  expect(providerRetryDelay(new Error(message), 0)).toBeNull();
});
test.each(['Selected model is at capacity. Please try a different model.',
  'Reconnecting... 2/5 (workspace routing discovery failed)', 'overloaded', 'fetch failed'])('backs off transient infrastructure failure: %s', message => {
  expect([0, 1, 2, 3].map(attempt => providerRetryDelay(new Error(message), attempt))).toEqual([1000, 2000, 4000, null]);
});
test('does not retry policy or deterministic failures', () => {
  expect(providerRetryDelay(new Error('Permission denied'), 0)).toBeNull();
  expect(providerRetryDelay(new Error('Compile failed'), 0)).toBeNull();
});


test.each(['Unexpected end of JSON input', 'Unterminated string in JSON at position 512',
  `Unexpected token '<', "<html>" is not valid JSON`, 'Expected double-quoted property name in JSON at position 1'])
('retries malformed provider JSON: %s', message => {
  const error = new SyntaxError(message);
  expect(classifyError(error).reason).toBe(FailoverReason.INVALID_RESPONSE);
  expect([0, 1, 2, 3].map(attempt => providerRetryDelay(error, attempt))).toEqual([1000, 2000, 4000, null]);
});
test('task prose mentioning JSON or parse is not a malformed response', () => {
  expect(providerRetryDelay(new Error('Please parse the JSON file and fix the schema'), 0)).toBeNull();
});
